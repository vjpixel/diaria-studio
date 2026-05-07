/**
 * diaria-linkedin-cron — Cloudflare Worker (#TBD)
 *
 * Fila de posts LinkedIn agendados pra Diar.ia. Substitui o agendamento via
 * Make.com Data Store (que não funcionou — ver
 * `feedback_make_searchrecord_mapping_unsolved.md`).
 *
 * Arquitetura:
 *   1. publish-linkedin.ts POSTa pra /queue com {text, image_url, scheduled_at, destaque}
 *   2. KV armazena com key lex-sortable, valor JSON
 *   3. Cron a cada 30min lê KV, fira webhook Make pra items com scheduled_at <= now
 *   4. Item é deletado após fire bem-sucedido (HTTP 2xx do webhook)
 *   5. Falhas incrementam retry_count; após MAX_RETRIES (5) movem pra dlq:{uuid}
 *
 * Endpoints:
 *   POST   /queue       → adiciona item à fila. Auth: header X-Diaria-Token
 *   GET    /health      → debug — quantos items na fila, próximo agendado
 *   GET    /list        → debug — lista completa (auth required)
 *   GET    /dlq         → debug — lista dead-letter queue (auth required)
 *   DELETE /dlq/:key    → cleanup — remove entry específica do DLQ (auth required, #894 P2-B)
 *
 * KV schema:
 *   queue:{scheduled_at_iso}:{uuid}  = QueueEntry JSON (lex-sortable por scheduled_at — #883)
 *   queue:{uuid}                     = QueueEntry JSON (legacy, ainda processado pra compat)
 *   dlq:{scheduled_at_iso}:{uuid}    = QueueEntry JSON após esgotar retries (#880, #894 P1-A)
 *
 * DLQ retention (#894 P1-B): entries no DLQ expiram automaticamente após DLQ_TTL_SECONDS
 * (30 dias) via expirationTtl. Janela suficiente pra editor revisar/agir sem acumular.
 *
 * Secrets (via `wrangler secret put`):
 *   DIARIA_TOKEN       → header X-Diaria-Token pra autenticar /queue, /list e /dlq
 *   MAKE_WEBHOOK_URL   → URL do webhook Make (Scenario A "Integration LinkedIn")
 */

export interface Env {
  LINKEDIN_QUEUE: KVNamespace;
  DIARIA_TOKEN: string;
  MAKE_WEBHOOK_URL: string;
}

export interface QueueEntry {
  text: string;
  image_url: string | null;
  scheduled_at: string; // ISO 8601
  destaque: string; // d1 | d2 | d3
  created_at: string;
  retry_count?: number; // #880 — incrementado a cada falha de fetch
}

// ── Constantes ─────────────────────────────────────────────────────────────

export const MAX_RETRIES = 5; // #880 — após isso, vai pra dlq:
export const FETCH_TIMEOUT_MS = 30_000; // #881 — timeout por fetch ao Make
export const MAX_TEXT_LENGTH = 10_000; // #882 — limite de caracteres do post
export const MAX_URL_LENGTH = 2_000; // #882 — limite de comprimento de image_url
export const DLQ_TTL_SECONDS = 30 * 24 * 3600; // #894 P1-B — DLQ entries expiram em 30 dias

// ── Auth helper ────────────────────────────────────────────────────────────

/**
 * Comparação constant-time entre duas strings (#879).
 *
 * Evita timing attack onde um atacante mede tempo de resposta byte a byte
 * pra inferir o token. Sempre percorre o array completo (após o length check)
 * e usa XOR + OR pra acumular diferenças sem early return.
 *
 * Mesmo padrão usado em `workers/poll/src/index.ts::hmacVerify`.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get("X-Diaria-Token");
  if (!token) return false;
  return constantTimeEquals(token, env.DIARIA_TOKEN);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Key helpers (#883) ─────────────────────────────────────────────────────

/**
 * Constrói key lex-sortable pra fila: `queue:{scheduled_at_iso}:{uuid}`.
 *
 * KV.list() retorna keys em ordem lex, então o primeiro item do prefix
 * `queue:` é o próximo a firar (#883). ISO 8601 é lex-sortable quando os
 * timestamps são UTC normalizados (Z).
 */
export function buildQueueKey(scheduledAtIso: string, uuid: string): string {
  return `queue:${scheduledAtIso}:${uuid}`;
}

/**
 * Constrói key DLQ a partir da queue key original e scheduled_at (#894 P1-A).
 *
 * Reusa UUID original pra manter rastreabilidade entry-da-fila ↔ entry-no-dlq:
 * - Schema novo `queue:<iso>:<uuid>` → `dlq:<iso>:<uuid>` (mesmo iso/uuid)
 * - Schema legacy `queue:<uuid>` → `dlq:<scheduled_at>:<uuid>` (mantém uuid,
 *   adiciona iso pra ordenação lex no DLQ)
 *
 * Tem fallback pra UUID novo se a key original for malformada (corrupção).
 */
export function buildDlqKey(originalKey: string, scheduledAtIso: string): string {
  if (!originalKey.startsWith("queue:")) {
    // Não deveria acontecer, mas fallback defensivo
    return `dlq:${scheduledAtIso}:${crypto.randomUUID()}`;
  }
  const rest = originalKey.slice("queue:".length);
  // Schema novo: extrair UUID após o último `:`
  const lastColon = rest.lastIndexOf(":");
  if (lastColon >= 0) {
    const uuid = rest.slice(lastColon + 1);
    return `dlq:${scheduledAtIso}:${uuid}`;
  }
  // Schema legacy `queue:<uuid>`: usa o uuid direto
  return `dlq:${scheduledAtIso}:${rest}`;
}

/**
 * Regex pra schema novo: `queue:{iso}:{uuid}`.
 *
 * - ISO 8601 UTC: `YYYY-MM-DDTHH:MM:SS[.fff]Z` (Z opcional pra robustez)
 * - UUID v4: hex + hifens (8-4-4-4-12)
 *
 * Mantemos `[\d:.]+` no segmento ISO em vez de regex estrita pra tolerar
 * variações que `Date.toISOString()` pode produzir em edge cases (mas
 * ainda exige a estrutura `queue:<data>T<hora>:<...>` reconhecível).
 */
const QUEUE_KEY_NEW_RE = /^queue:\d{4}-\d{2}-\d{2}T[\d:.]+Z?:[\da-fA-F-]+$/;

/**
 * Detecta se uma key é do schema legacy `queue:{uuid}` (sem timestamp).
 *
 * Schema novo é `queue:{iso}:{uuid}` (verificado via regex). Legacy é
 * qualquer outra coisa começando com `queue:` que não bate o padrão novo.
 * Mantemos compat pra não exigir migração manual no KV.
 *
 * #894 P2-A — substitui heurística frágil baseada em contagem de `:`.
 */
export function isLegacyKey(key: string): boolean {
  if (!key.startsWith("queue:")) return false;
  return !QUEUE_KEY_NEW_RE.test(key);
}

// ── POST /queue — enfileira ─────────────────────────────────────────────────

async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Partial<QueueEntry>;
  try {
    body = (await request.json()) as Partial<QueueEntry>;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const required = ["text", "scheduled_at", "destaque"] as const;
  for (const field of required) {
    if (!body[field] || typeof body[field] !== "string") {
      return json({ error: `missing or invalid field: ${field}` }, 400);
    }
  }

  // Validar scheduled_at é uma data parseable
  const scheduledMs = Date.parse(body.scheduled_at as string);
  if (isNaN(scheduledMs)) {
    return json({ error: "scheduled_at must be a valid ISO 8601 date" }, 400);
  }

  // Validar destaque
  if (!/^d[123]$/.test(body.destaque as string)) {
    return json({ error: "destaque must be d1, d2, or d3" }, 400);
  }

  // #882 — Validar tamanho de payload pra evitar abuso de KV (cap por valor é
  // ~25MB, mas posts LinkedIn maiores que 10k caracteres são quase certamente
  // erro/abuso) e proteger fetch downstream.
  const textValue = body.text as string;
  if (textValue.length > MAX_TEXT_LENGTH) {
    return json(
      { error: `text exceeds ${MAX_TEXT_LENGTH} chars (got ${textValue.length})` },
      400,
    );
  }
  if (body.image_url) {
    const imageUrlValue = body.image_url as string;
    if (typeof imageUrlValue !== "string") {
      return json({ error: "image_url must be a string" }, 400);
    }
    if (imageUrlValue.length > MAX_URL_LENGTH) {
      return json(
        { error: `image_url exceeds ${MAX_URL_LENGTH} chars (got ${imageUrlValue.length})` },
        400,
      );
    }
  }

  const uuid = crypto.randomUUID();
  // #883 — Normalizar scheduled_at pra ISO UTC (lex-sortable). Isso garante
  // que `queue:{iso}:{uuid}` ordene corretamente mesmo se o caller passou
  // timezone offset (`+00:00`, `-03:00`, etc).
  const normalizedIso = new Date(scheduledMs).toISOString();
  const key = buildQueueKey(normalizedIso, uuid);
  const entry: QueueEntry = {
    text: textValue,
    image_url: (body.image_url as string | null) ?? null,
    scheduled_at: body.scheduled_at as string,
    destaque: body.destaque as string,
    created_at: new Date().toISOString(),
    retry_count: 0,
  };
  await env.LINKEDIN_QUEUE.put(key, JSON.stringify(entry));

  return json(
    {
      queued: true,
      key,
      scheduled_at: entry.scheduled_at,
      destaque: entry.destaque,
    },
    202,
  );
}

// ── GET /health — quantos items + próximo a firar ──────────────────────────

/**
 * #883 — O(1) leitura de `next_scheduled` via key naming lex-sortable.
 *
 * KV.list() retorna keys ordenadas lex; com schema `queue:{iso}:{uuid}`,
 * a primeira key é o próximo a firar. Tem fallback pra schema legacy
 * (`queue:{uuid}`) que exige get() pra ler scheduled_at — mas só consultamos
 * a primeira key da lista, não o cluster inteiro, então worst case é 1 read.
 */
async function handleHealth(env: Env): Promise<Response> {
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let nextScheduled: { key: string; scheduled_at: string; destaque: string } | null = null;

  if (list.keys.length > 0) {
    const firstKey = list.keys[0];
    if (isLegacyKey(firstKey.name)) {
      // Schema legacy: precisa ler o valor pra obter scheduled_at. Fazemos
      // só 1 read (não O(n)) — se houver muitos legacy keys eles vão ser
      // drenados pelo cron e migrados naturalmente conforme a fila vira.
      const raw = await env.LINKEDIN_QUEUE.get(firstKey.name);
      if (raw) {
        try {
          const entry = JSON.parse(raw) as QueueEntry;
          nextScheduled = {
            key: firstKey.name,
            scheduled_at: entry.scheduled_at,
            destaque: entry.destaque,
          };
        } catch {
          // ignora — fica null
        }
      }
    } else {
      // Schema novo: ISO está embutido na key — sem read necessário.
      // queue:{iso}:{uuid} → segmentos: ["queue", iso..., uuid]
      // ISO contém múltiplos `:`, então fazemos slice em vez de split.
      const after = firstKey.name.slice("queue:".length);
      // O UUID tem 36 chars (8-4-4-4-12 com hifens) e fica no final após `:`
      const lastColon = after.lastIndexOf(":");
      const iso = lastColon >= 0 ? after.slice(0, lastColon) : after;
      // destaque não está na key — fazemos 1 read pra obter
      const raw = await env.LINKEDIN_QUEUE.get(firstKey.name);
      let destaque = "?";
      if (raw) {
        try {
          destaque = (JSON.parse(raw) as QueueEntry).destaque;
        } catch {
          // ignora
        }
      }
      nextScheduled = {
        key: firstKey.name,
        scheduled_at: iso,
        destaque,
      };
    }
  }

  return json({
    status: "ok",
    queue_size: list.keys.length,
    next_scheduled: nextScheduled,
    server_time: new Date().toISOString(),
  });
}

// ── GET /list — debug ───────────────────────────────────────────────────────

async function handleList(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  const items: Array<QueueEntry & { key: string }> = [];

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;
    const entry = JSON.parse(raw) as QueueEntry;
    items.push({ key: k.name, ...entry });
  }

  items.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return json({ count: items.length, items });
}

// ── GET /dlq — dead-letter queue (#880) ────────────────────────────────────

async function handleDlq(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const list = await env.LINKEDIN_QUEUE.list({ prefix: "dlq:" });
  const items: Array<QueueEntry & { key: string }> = [];

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw) as QueueEntry;
      items.push({ key: k.name, ...entry });
    } catch {
      // ignora entries corrompidas
    }
  }

  items.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return json({ count: items.length, items });
}

// ── DELETE /dlq/:key — cleanup manual de DLQ (#894 P2-B) ───────────────────

/**
 * Remove uma entry específica do DLQ. Útil pra editor limpar dead-letters
 * via API após investigar (em vez de `wrangler kv key delete`).
 *
 * Responses:
 *   200 → { deleted: true, key }
 *   401 → unauthorized
 *   400 → key inválida (não começa com `dlq:`)
 *   404 → key não existe (ou já expirou via TTL)
 */
async function handleDlqDelete(request: Request, env: Env, key: string): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!key.startsWith("dlq:")) {
    return json({ error: "key must start with 'dlq:'" }, 400);
  }
  const existing = await env.LINKEDIN_QUEUE.get(key);
  if (existing === null) {
    return json({ error: "key not found", key }, 404);
  }
  await env.LINKEDIN_QUEUE.delete(key);
  return json({ deleted: true, key });
}

// ── Cron handler — fira items maduros ──────────────────────────────────────

/**
 * #880 — move entry pra dlq:{uuid} após esgotar retries.
 * #881 — fetch ao Make tem timeout via AbortSignal (FETCH_TIMEOUT_MS).
 */
async function fireDueItems(env: Env): Promise<{ fired: number; errors: number; dlq: number }> {
  const now = Date.now();
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let fired = 0;
  let errors = 0;
  let dlq = 0;

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;

    let entry: QueueEntry;
    try {
      entry = JSON.parse(raw) as QueueEntry;
    } catch (e) {
      console.error(`[fire] invalid JSON in ${k.name}: ${(e as Error).message}`);
      errors++;
      continue;
    }

    const scheduledMs = Date.parse(entry.scheduled_at);
    if (isNaN(scheduledMs)) {
      console.error(`[fire] invalid scheduled_at in ${k.name}: ${entry.scheduled_at}`);
      errors++;
      continue;
    }

    if (scheduledMs > now) continue; // ainda não chegou a hora

    // Disparar webhook Make (#881 — com timeout)
    let succeeded = false;
    try {
      const res = await fetch(env.MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          image_url: entry.image_url,
          scheduled_at: entry.scheduled_at,
          destaque: entry.destaque,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
        await env.LINKEDIN_QUEUE.delete(k.name);
        console.log(
          `[fire] ${k.name} fired (destaque=${entry.destaque}, scheduled=${entry.scheduled_at})`,
        );
        fired++;
        succeeded = true;
      } else {
        const body = await res.text();
        console.error(
          `[fire] ${k.name} make webhook returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      const err = e as Error;
      // AbortError surge se AbortSignal.timeout dispara antes do Make responder
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        console.error(`[fire] ${k.name} fetch timeout after ${FETCH_TIMEOUT_MS}ms`);
      } else {
        console.error(`[fire] ${k.name} fetch failed: ${err.message}`);
      }
    }

    if (succeeded) continue;

    // #880 — incrementar retry_count e mover pra dlq se esgotou
    const currentRetry = entry.retry_count ?? 0;
    const nextRetry = currentRetry + 1;

    if (nextRetry >= MAX_RETRIES) {
      // #894 P1-A — Move pra DLQ com ordem atômica: PUT dlq primeiro, delete
      // queue depois. Se Worker crashar entre as 2 ops, o item permanece em
      // ambos: o cron seguinte vai re-processar a queue entry (e potencialmente
      // re-mover pra DLQ, gerando duplicata). Trade-off: duplicata é benigna
      // (DLQ é só auditoria, não dispara ação) e o TTL (#894 P1-B) garante que
      // entries antigas evaporam. Inverter a ordem (delete primeiro, put
      // depois) seria pior: crash entre as ops perde o item silenciosamente.
      //
      // Reusa o UUID original pra rastreabilidade (`queue:<ts>:<uuid>` →
      // `dlq:<ts>:<uuid>`). Pra schema legacy (`queue:<uuid>`), usa o uuid
      // direto. Mantém vínculo entre entry da fila e entry no DLQ.
      const dlqKey = buildDlqKey(k.name, entry.scheduled_at);
      const dlqEntry: QueueEntry = { ...entry, retry_count: nextRetry };
      await env.LINKEDIN_QUEUE.put(dlqKey, JSON.stringify(dlqEntry), {
        expirationTtl: DLQ_TTL_SECONDS, // #894 P1-B
      });
      await env.LINKEDIN_QUEUE.delete(k.name);
      console.error(
        `[fire] ${k.name} moved to dlq after ${nextRetry} retries (destaque=${entry.destaque}, scheduled=${entry.scheduled_at}, dlq_key=${dlqKey})`,
      );
      dlq++;
    } else {
      // Re-write com retry_count incrementado
      const updated: QueueEntry = { ...entry, retry_count: nextRetry };
      await env.LINKEDIN_QUEUE.put(k.name, JSON.stringify(updated));
      console.error(
        `[fire] ${k.name} retry ${nextRetry}/${MAX_RETRIES} (destaque=${entry.destaque})`,
      );
      errors++;
    }
  }

  return { fired, errors, dlq };
}

// ── Main handler ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/queue" && request.method === "POST") {
      return handleEnqueue(request, env);
    }
    if (path === "/health" && request.method === "GET") {
      return handleHealth(env);
    }
    if (path === "/list" && request.method === "GET") {
      return handleList(request, env);
    }
    if (path === "/dlq" && request.method === "GET") {
      return handleDlq(request, env);
    }
    // #894 P2-B — DELETE /dlq/:key pra cleanup via API
    if (path.startsWith("/dlq/") && request.method === "DELETE") {
      const key = decodeURIComponent(path.slice("/dlq/".length));
      return handleDlqDelete(request, env, key);
    }

    return json(
      {
        error: "not found",
        endpoints: [
          "POST /queue (auth: X-Diaria-Token)",
          "GET /health",
          "GET /list (auth: X-Diaria-Token)",
          "GET /dlq (auth: X-Diaria-Token)",
          "DELETE /dlq/:key (auth: X-Diaria-Token)",
        ],
      },
      404,
    );
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const result = await fireDueItems(env);
        console.log(`[cron] fired=${result.fired} errors=${result.errors} dlq=${result.dlq}`);
      })(),
    );
  },
};

// Internal exports pra testes (#879 #880 #881 #882 #883 #894)
export const __test__ = {
  handleEnqueue,
  handleHealth,
  handleList,
  handleDlq,
  handleDlqDelete,
  fireDueItems,
};
