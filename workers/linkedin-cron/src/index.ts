/**
 * diaria-linkedin-cron — Cloudflare Worker (#TBD)
 *
 * Fila de posts LinkedIn agendados pra Diar.ia. Substitui o agendamento via
 * Make.com Data Store (que não funcionou — ver
 * `feedback_make_searchrecord_mapping_unsolved.md`).
 *
 * Arquitetura (#1168 — Durable Object alarms):
 *   1. publish-linkedin.ts POSTa pra /queue com {text, image_url, scheduled_at, destaque}
 *   2. KV armazena com key lex-sortable, valor JSON
 *   3a. DO `LinkedInScheduler` cria alarm em scheduled_at via state.storage.setAlarm
 *       — disparo exato, lag ~zero (substitui cron polling de cron-5min com lag worst-case ~5min)
 *   3b. Cron fallback (cron-5min) ainda ativo durante transição — fira items maduros que
 *       não têm alarm (legacy KV ou raro edge de crash pós-enqueue pré-setAlarm)
 *   4. Item é deletado após fire bem-sucedido (HTTP 2xx do webhook)
 *   5. Falhas incrementam retry_count; após MAX_RETRIES (5) movem pra dlq:{uuid}
 *
 * DO design (#1168): 1 DO instance por item (`idFromName(queueKey)`).
 *   - Vantagem: isolamento total, sem collision de alarm (DO tem 1 alarm por vez).
 *   - Alternativa (1 scheduler central) teria que re-arm pra próximo item mais
 *     cedo — lógica mais complexa, e falha de 1 item afetaria o scheduler global.
 *   - Desvantagem: N DO instances pra N items pendentes (low-cost, DO spins up
 *     só no alarm; ≤3 items/dia na prática).
 *
 * Migration path de KV legacy (#1168):
 *   - Items já no KV (pré-deploy) NÃO perdem alarm automático.
 *   - Editor faz re-arm pós-deploy: POST /rearm (auth) varre KV e chama
 *     setAlarm em cada DO de item pendente. 1 call, idempotente.
 *   - Enquanto re-arm não for chamado (ou items que carreguem só pelo cron),
 *     o cron fallback (cron-5min) garante que items legacy não são perdidos.
 *
 * Idempotência (#1168):
 *   - DO guarda `fired: true` em storage após fire bem-sucedido.
 *   - alarm() e fireDueItems (cron path) checam o storage flag antes de disparar.
 *   - Com ambos paths ativos, colisão alarm+cron é possível (janela de ~ms). O
 *     guard `fired` garante que apenas 1 disparo por item seja efetivo.
 *
 * Endpoints:
 *   POST   /queue       → adiciona item à fila. Auth: header X-Diaria-Token
 *   DELETE /queue/:key  → cleanup — remove entry específica da queue (auth, #1058)
 *   POST   /rearm       → re-arma alarms DO pra items KV legacy (auth, #1168)
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
  // #595 — webhook URL do scenario Make "Pixel LinkedIn" (vjpixel personal,
  // só faz comments na Diar.ia company page). Opcional pra backward-compat:
  // se ausente, items com webhook_target="pixel" vão pra DLQ com reason claro.
  MAKE_PIXEL_WEBHOOK_URL?: string;
  // #1168 — Durable Object namespace pra alarms por item.
  LINKEDIN_SCHEDULER: DurableObjectNamespace;
}

export type WebhookTarget = "diaria" | "pixel";
export type QueueAction = "post" | "comment";

export interface QueueEntry {
  text: string;
  image_url: string | null;
  scheduled_at: string; // ISO 8601
  destaque: string; // d1 | d2 | d3
  created_at: string;
  retry_count?: number; // #880 — incrementado a cada falha de fetch
  // #595 — fields opcionais pra suportar comments. Default `webhook_target`
  // = "diaria" e `action` = "post" pra backward-compat com entries antigas.
  webhook_target?: WebhookTarget;
  action?: QueueAction;
  parent_destaque?: string; // qual destaque o comment pertence (auditoria)
  // (#2230 bug 2 fix) Tombstone de cancelamento: setado por handleQueueDelete quando
  // o KV.delete falha após o DO cancel. O cron detecta este flag, pula o item sem
  // postar, e o deleta do KV (cleanup do tombstone).
  cancelled?: boolean;
}

// ── Constantes ─────────────────────────────────────────────────────────────

export const MAX_RETRIES = 5; // #880 — após isso, vai pra dlq:
export const FETCH_TIMEOUT_MS = 30_000; // #881 — timeout por fetch ao Make
export const MAX_TEXT_LENGTH = 10_000; // #882 — limite de caracteres do post
export const MAX_URL_LENGTH = 2_000; // #882 — limite de comprimento de image_url
export const DLQ_TTL_SECONDS = 30 * 24 * 3600; // #894 P1-B — DLQ entries expiram em 30 dias
// (#2219 bug 2 fix) TTL do claim: se `claiming=true` por mais de 5min, o claim
// é considerado expirado (crash mid-flight sem release). CF DO tem timeout de
// CPU de 30s por invocação; 5min é uma margem segura acima disso.
export const CLAIM_TTL_MS = 5 * 60 * 1000; // 5 minutos

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

export * from "./durable-object";
import { LinkedInScheduler, type DoStoredPayload } from "./durable-object";

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

  // #595 — Validar webhook_target e action (opcionais; defaults aplicados
  // em fireDueItems pra backward-compat com entries antigas no KV).
  if (body.webhook_target !== undefined && body.webhook_target !== "diaria" && body.webhook_target !== "pixel") {
    return json({ error: "webhook_target must be 'diaria' or 'pixel'" }, 400);
  }
  if (body.action !== undefined && body.action !== "post" && body.action !== "comment") {
    return json({ error: "action must be 'post' or 'comment'" }, 400);
  }
  // Pixel scenario só faz comment — rejeitar combinação inválida no enqueue
  // pra falhar early em vez de DLQ no fire.
  if (body.webhook_target === "pixel" && body.action === "post") {
    return json({ error: "webhook_target='pixel' supports only action='comment'" }, 400);
  }
  if (body.parent_destaque !== undefined) {
    if (typeof body.parent_destaque !== "string") {
      return json({ error: "parent_destaque must be a string" }, 400);
    }
    if (!/^d[123]$/.test(body.parent_destaque)) {
      return json({ error: "parent_destaque must be d1, d2, or d3" }, 400);
    }
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
    // #595 — preservar fields opcionais (omitidos se undefined pra não inflar KV)
    ...(body.webhook_target !== undefined && { webhook_target: body.webhook_target as WebhookTarget }),
    ...(body.action !== undefined && { action: body.action as QueueAction }),
    ...(body.parent_destaque !== undefined && { parent_destaque: body.parent_destaque as string }),
  };
  await env.LINKEDIN_QUEUE.put(key, JSON.stringify(entry));

  // #919 verify-after-put: KV.put pode "succeed" sem persistir em casos raros
  // (eventual consistency edge, namespace misconfig, region-specific glitch).
  // Read-back imediato confirma que a entry está acessível antes de retornar
  // 202 — caso contrário caller acreditaria que enfileirou mas a queue está
  // vazia (silent fail bug 2026-05-07: "200 OK" mas queue_size=0).
  //
  // Custo: +1 KV.get por enqueue (~10ms). Aceitável: enqueue é raro (3×/dia)
  // e o sinal de falha precoce previne perda silenciosa de posts.
  const verifyRaw = await env.LINKEDIN_QUEUE.get(key);
  if (verifyRaw === null) {
    return json(
      {
        error: "kv_put_verify_failed",
        message:
          "KV.put returned without error but read-back returned null. " +
          "Eventual consistency or namespace misconfig — não retornamos 202 " +
          "pra evitar silent fail (caller acreditaria enqueue mas queue ficou vazia).",
        key,
      },
      500,
    );
  }

  // #1168 — Armar DO alarm pra disparo preciso em scheduledAtMs.
  // DO failure é non-fatal: cron fallback (*/5) garante que o item é disparado.
  // Isso é importante pra compat: se LINKEDIN_SCHEDULER não estiver configurado
  // (deploy antigo / env sem binding), cron continua funcionando normalmente.
  let alarmArmed = false;
  try {
    const doId = env.LINKEDIN_SCHEDULER.idFromName(key);
    const doStub = env.LINKEDIN_SCHEDULER.get(doId);
    const armPayload: DoStoredPayload & { scheduledAtMs: number } = {
      scheduledAtMs: scheduledMs,
      key,
      entry,
      webhookUrl: env.MAKE_WEBHOOK_URL,
      ...(env.MAKE_PIXEL_WEBHOOK_URL !== undefined && { pixelWebhookUrl: env.MAKE_PIXEL_WEBHOOK_URL }),
    };
    const armRes = await doStub.fetch("https://do/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(armPayload),
    });
    alarmArmed = armRes.ok;
    if (!armRes.ok) {
      console.warn(`[enqueue] DO arm failed for key=${key} status=${armRes.status} — cron fallback active`);
    }
  } catch (e) {
    // DO indisponível / binding ausente — não bloquear o enqueue
    console.warn(`[enqueue] DO arm exception for key=${key}: ${(e as Error).message} — cron fallback active`);
  }

  return json(
    {
      queued: true,
      key,
      scheduled_at: entry.scheduled_at,
      destaque: entry.destaque,
      alarm_armed: alarmArmed,
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

// ── DELETE /queue/:key — cleanup manual de queue (#1058) ──────────────────

/**
 * Remove uma entry específica da queue. Útil pra cleanup pós-/diaria-test
 * --with-publish (deletar items agendados que viraram artefatos de teste).
 * Simétrico ao DELETE /dlq/:key.
 *
 * Responses:
 *   200 → { deleted: true, key }
 *   401 → unauthorized
 *   400 → key inválida (não começa com `queue:`)
 *   404 → key não existe (já firada/deletada)
 */
async function handleQueueDelete(request: Request, env: Env, key: string): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!key.startsWith("queue:")) {
    return json({ error: "key must start with 'queue:'" }, 400);
  }
  const existing = await env.LINKEDIN_QUEUE.get(key);
  if (existing === null) {
    return json({ error: "key not found", key }, 404);
  }

  // (#2219 bug 3 fix) Cancelar o alarm do DO PRIMEIRO, antes de deletar o KV.
  // Ordem anterior (KV delete → DO cancel) tinha janela onde o alarm podia disparar
  // entre as 2 ops — sem KV entry o cron não reprocessa, mas o DO ainda tem
  // o payload em storage e posta no LinkedIn. Correto: DO cancel primeiro.
  // O DO guarda payload em storage independente do KV — deletar KV não para o alarm.
  // Non-fatal: se o DO não estiver disponível, logamos warning e seguimos.
  // O editor deve saber que, em caso de falha aqui, o post ainda pode ser enviado.
  let doAlarmCancelled = false;
  try {
    const doId = env.LINKEDIN_SCHEDULER.idFromName(key);
    const doStub = env.LINKEDIN_SCHEDULER.get(doId);
    const cancelRes = await doStub.fetch("https://do/cancel", { method: "POST" });
    doAlarmCancelled = cancelRes.ok;
    if (!cancelRes.ok) {
      console.warn(
        `[queue-delete] DO cancel failed for key=${key} status=${cancelRes.status} — alarm may still fire`,
      );
    }
  } catch (e) {
    // DO indisponível (binding ausente, etc.) — non-fatal, logar aviso.
    console.warn(`[queue-delete] DO cancel exception for key=${key}: ${(e as Error).message} — alarm may still fire`);
  }

  // (#2230 bug 2 fix) KV delete APÓS DO cancel com retry: garantir que o item
  // não dispara depois mesmo se o KV delete falha transitoriamente.
  //
  // Cenário anterior (bug): DO cancel OK mas KV.delete lança → item permanece no KV
  // → próximo cron: DO está limpo (deleteAll), /claim retorna claimed=true (virgem),
  // cron lê KV entry e posta — post-após-delete.
  //
  // Fix: retry de 3x no KV.delete. Se ainda falhar, gravar um tombstone
  // ("cancelled:true") na KV entry pra que o cron detect e pule o item.
  // O cron é responsável por limpar tombstones na próxima rodada (scheduled_at no passado
  // + entry.cancelled=true → pula + deleta sem postar).
  let kvDeleted = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.LINKEDIN_QUEUE.delete(key);
      kvDeleted = true;
      break;
    } catch (kvErr) {
      console.warn(`[queue-delete] KV.delete attempt ${attempt + 1} failed for key=${key}: ${(kvErr as Error).message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  if (!kvDeleted) {
    // KV delete persistentemente falhou — gravar tombstone pra que o cron pule este item.
    // O tombstone é uma QueueEntry válida com campo `cancelled:true` (lido pelo cron).
    // O DO já foi cancelado (deleteAll), então alarm não disparará; o risco é apenas o cron.
    try {
      const tombstoneEntry = JSON.parse(existing) as QueueEntry & { cancelled?: boolean };
      tombstoneEntry.cancelled = true;
      await env.LINKEDIN_QUEUE.put(key, JSON.stringify(tombstoneEntry));
      console.warn(`[queue-delete] KV.delete failed after 3 retries for key=${key} — wrote tombstone (cancelled=true); cron will skip`);
    } catch (tombstoneErr) {
      // Tombstone também falhou — situação de storage muito degradada; logar crítico.
      console.error(`[queue-delete] CRITICAL: KV.delete AND tombstone failed for key=${key}: ${(tombstoneErr as Error).message} — alarm may fire if DO cancel also failed`);
    }
  }

  return json({ deleted: true, key, do_alarm_cancelled: doAlarmCancelled, kv_deleted: kvDeleted });
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

export * from "./fire";
import { fireDueItems } from "./fire";

// ── POST /rearm — re-arm DO alarms pra items KV legacy (#1168) ────────────

/**
 * Varre todos os items pendentes no KV e arma (ou re-arma) o DO alarm de cada
 * um. Idempotente: pode ser chamado múltiplas vezes sem efeito colateral
 * (setAlarm sobrescreve alarm anterior).
 *
 * Uso: editor chama 1x após deploy do #1168 pra garantir que items KV legacy
 * (enfileirados antes do deploy) tenham alarms DO agendados.
 *
 * Só processa items com scheduledMs no FUTURO — items já vencidos são deixados
 * pro cron fallback (que roda a cada cron-5min e vai disparar na próxima rodada).
 *
 * Resposta: { rearmed: number, skipped_past: number, skipped_tombstone: number, failed: number }
 */
async function handleRearm(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const now = Date.now();
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let rearmed = 0;
  let skippedPast = 0;
  // (#2235 fix F10) Separar tombstones de items passados pra observabilidade.
  // skippedPast = item passado (scheduled_at <= now); skipped_tombstone = cancelled=true.
  let skippedTombstone = 0;
  let failed = 0;

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;

    let entry: QueueEntry;
    try {
      entry = JSON.parse(raw) as QueueEntry;
    } catch {
      failed++;
      continue;
    }

    // (#2245 fix F3, extends #2235 fix F4) Tombstones devem ser deletados independentemente
    // de scheduled_at estar no passado ou no futuro. Antes: a guarda `scheduledMs <= now`
    // vinha primeiro — um tombstone com scheduled_at passado era contado como skippedPast
    // e NÃO deletado, acumulando no KV indefinidamente. Fix: verificar cancelled ANTES
    // de checar se está no passado — tombstone passado ou futuro → deletar sempre.
    if (entry.cancelled) {
      console.log(`[rearm] ${k.name} has tombstone (cancelled=true) — deleting to prevent accumulation`);
      // (#2293 self-review MEDIUM): skippedTombstone++ movido para DENTRO do try —
      // só conta como "tombstone tratado" quando o delete KV de fato tem sucesso.
      // Antes: falha no delete logava warning mas ainda incrementava o counter,
      // reportando skipped_tombstone=1 para um tombstone que permanecia no KV.
      // Agora: delete falhou → failed++ (não skippedTombstone++) — próximo /rearm retenta.
      try {
        await env.LINKEDIN_QUEUE.delete(k.name);
        skippedTombstone++;
      } catch (delErr) {
        failed++;
        console.warn(`[rearm] failed to delete tombstone ${k.name}: ${String(delErr)}`);
      }
      continue;
    }

    const scheduledMs = Date.parse(entry.scheduled_at);
    if (isNaN(scheduledMs) || scheduledMs <= now) {
      // Passado ou inválido (e não é tombstone) — deixar pro cron fallback
      skippedPast++;
      continue;
    }

    // Armar DO alarm pra este item
    try {
      const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
      const doStub = env.LINKEDIN_SCHEDULER.get(doId);
      const armPayload: DoStoredPayload & { scheduledAtMs: number } = {
        scheduledAtMs: scheduledMs,
        key: k.name,
        entry,
        webhookUrl: env.MAKE_WEBHOOK_URL,
        ...(env.MAKE_PIXEL_WEBHOOK_URL !== undefined && { pixelWebhookUrl: env.MAKE_PIXEL_WEBHOOK_URL }),
      };
      const armRes = await doStub.fetch("https://do/arm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(armPayload),
      });
      if (armRes.ok) {
        rearmed++;
        console.log(`[rearm] armed DO alarm for key=${k.name} at=${entry.scheduled_at}`);
      } else {
        failed++;
        console.error(`[rearm] DO arm failed for key=${k.name} status=${armRes.status}`);
      }
    } catch (e) {
      failed++;
      console.error(`[rearm] DO arm exception for key=${k.name}: ${(e as Error).message}`);
    }
  }

  return json({ rearmed, skipped_past: skippedPast, skipped_tombstone: skippedTombstone, failed });
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
    // #1058 — DELETE /queue/:key pra cleanup pós-/diaria-test (simetria com /dlq/)
    if (path.startsWith("/queue/") && request.method === "DELETE") {
      const key = decodeURIComponent(path.slice("/queue/".length));
      return handleQueueDelete(request, env, key);
    }
    // #1140 — POST /fire-now força fireDueItems imediatamente (debug/recovery).
    // Mesma lógica do cron handler; útil quando cron está com lag ou queue
    // tem entries adiantadas manualmente.
    if (path === "/fire-now" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }
      const result = await fireDueItems(env);
      return json({ ok: true, ...result });
    }
    // #1168 — POST /rearm re-arma DO alarms pra items KV legacy pós-deploy.
    // Editor chama 1x após deploy pra garantir que items pré-deploy tenham alarms.
    if (path === "/rearm" && request.method === "POST") {
      return handleRearm(request, env);
    }

    return json(
      {
        error: "not found",
        endpoints: [
          "POST /queue (auth: X-Diaria-Token)",
          "DELETE /queue/:key (auth: X-Diaria-Token)",
          "POST /rearm (auth: X-Diaria-Token) — re-arm DO alarms para items KV legacy",
          "POST /fire-now (auth: X-Diaria-Token)",
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

// Internal exports pra testes (#879 #880 #881 #882 #883 #894 #1168)
export const __test__ = {
  handleEnqueue,
  handleHealth,
  handleList,
  handleDlq,
  handleDlqDelete,
  handleQueueDelete,
  handleRearm,
  fireDueItems,
};
