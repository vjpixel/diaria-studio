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

// ── LinkedInScheduler — Durable Object (#1168) ────────────────────────────

/**
 * Payload armazenado no DO storage, contendo tudo que alarm() precisa pra
 * disparar o webhook sem acesso ao KV ou ao env do Worker.
 */
export interface DoStoredPayload {
  key: string;               // KV key do item (usado em logs)
  entry: QueueEntry;         // entry completa (texto, webhook_target, action, etc.)
  webhookUrl: string;        // MAKE_WEBHOOK_URL resolvido no momento do enqueue
  pixelWebhookUrl?: string;  // MAKE_PIXEL_WEBHOOK_URL (opcional)
}

/**
 * LinkedInScheduler — Durable Object (#1168).
 * 1 instância por item de fila: `idFromName(queueKey)`.
 *
 * Design (1 DO por item vs 1 scheduler central):
 *   - 1 DO por item: alarme isolado, falha de 1 item não afeta outros, sem
 *     lógica de "re-arm pra próximo item mais cedo". Escolha adotada.
 *   - 1 scheduler central: 1 DO com alarm sempre no próximo item mais cedo;
 *     após fire, re-arm pro seguinte. Mais complexo; falha de 1 item pode
 *     bloquear o scheduler global.
 *
 * Fluxo:
 *   1. `handleEnqueue` chama DO via `/arm` com `DoStoredPayload`.
 *   2. DO persiste payload + chama `state.storage.setAlarm(scheduledAtMs)`.
 *   3. Em `scheduledAtMs`, CF invoca `alarm()`.
 *   4. `alarm()` lê payload do storage, dispara webhook Make.
 *   5. Se sucesso: grava `fired:true` em storage (idempotência contra cron fallback).
 *   6. KV delete é feito pelo Worker `handleEnqueue` via idFromName — a entry KV
 *      permanece até o cron a processar; idempotência impede double-fire.
 *
 * Idempotência (alarm + cron fallback):
 *   - DO armazena `fired:true` após fire bem-sucedido.
 *   - `fireDueItems` (cron path) consulta DO via `/status` antes de disparar
 *     item com `alarm_armed:true`. Se DO reporta `fired:true`, cron apenas
 *     deleta a KV entry sem re-disparar o webhook.
 *   - Sem acesso a DO (ex: DO destruído), cron dispara normalmente (fallback).
 *
 * Protocol interno (fetch ao DO):
 *   POST /arm     body: DoStoredPayload + { scheduledAtMs: number }
 *                 → persiste payload, agenda alarm, retorna { armed: true }
 *   POST /cancel  → cancela alarm, limpa storage (para DELETE /queue/:key)
 *   GET  /status  → retorna { fired: boolean } (consultado por fireDueItems)
 *   POST /claim   → check-and-set atômico de `claiming` dentro de
 *                   blockConcurrencyWhile. Retorna { claimed: boolean }.
 *                   `true` significa "este caller ganhou o claim e pode postar".
 *                   `false` significa "outro caller já está processando" — não postar.
 *                   Implementa exactly-once entre cron↔alarm (#2219 bug 2).
 */
export class LinkedInScheduler {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/arm" && request.method === "POST") {
      const body = await request.json() as DoStoredPayload & { scheduledAtMs: number };
      // Persiste tudo que alarm() precisará — inclusive entry completa + webhook URLs
      const { scheduledAtMs, ...payload } = body;
      await this.state.storage.put("payload", payload satisfies DoStoredPayload);
      // setAlarm sobrescreve alarm anterior — idempotente pra re-arm
      await this.state.storage.setAlarm(scheduledAtMs);

      return new Response(JSON.stringify({ armed: true, scheduledAtMs }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      // deleteAll limpa payload + fired + claiming; deleteAlarm cancela o alarm.
      // Ordem: deleteAlarm primeiro pra evitar janela onde o alarm dispara mas
      // o storage ainda tem payload (risco baixo mas defensivo).
      await this.state.storage.deleteAlarm();
      await this.state.storage.deleteAll();
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const fired = (await this.state.storage.get<boolean>("fired")) ?? false;
      return new Response(JSON.stringify({ fired }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /claim — check-and-set atômico pra exactly-once entre cron↔alarm.
    // (#2219 bug 2) O DO event loop serializa tudo, então blockConcurrencyWhile
    // garante que 2 callers concorrentes (alarm + cron) não ganhem o claim
    // simultaneamente. O 1º que chegar seta `claiming:true` e retorna { claimed: true }.
    // O 2º lê `claiming:true` e retorna { claimed: false } — não posta.
    if (url.pathname === "/claim" && request.method === "POST") {
      const claimed = await this.state.blockConcurrencyWhile(async () => {
        const alreadyClaiming = await this.state.storage.get<boolean>("claiming");
        const alreadyFired = await this.state.storage.get<boolean>("fired");
        if (alreadyClaiming || alreadyFired) return false;
        await this.state.storage.put("claiming", true);
        return true;
      });
      return new Response(JSON.stringify({ claimed }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /status-set-fired — cron path seta fired=true + limpa claiming após
    // fire bem-sucedido. Permite que o DO saiba que o cron disparou, evitando
    // que o alarm() tente re-disparar em CF retry.
    if (url.pathname === "/status-set-fired" && request.method === "POST") {
      await this.state.storage.put("fired", true);
      await this.state.storage.delete("claiming");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /release-claim — cron ou alarm libera claiming após falha do webhook,
    // permitindo que o próximo retry do cron tente novamente.
    if (url.pathname === "/release-claim" && request.method === "POST") {
      await this.state.storage.delete("claiming");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  async alarm(): Promise<void> {
    // (#2219 bug 2) Claim atômico via /claim — exactly-once com cron fallback.
    // blockConcurrencyWhile garante que alarm() e cron não podem ganhar o claim
    // simultaneamente mesmo em corrida. Se o cron ganhou antes, `claimed` = false.
    const claimRes = await this.fetch(new Request("https://do/claim", { method: "POST" }));
    const claimData = await claimRes.json() as { claimed: boolean };
    if (!claimData.claimed) {
      console.log("[DO alarm] claim lost — cron already claimed, skipping to avoid dup");
      return;
    }

    const payload = await this.state.storage.get<DoStoredPayload>("payload");
    if (!payload) {
      // Alarm foi cancelado (DELETE /queue) mas alarm já estava enfileirado no CF.
      // Clearing do claim pra não bloquear nada; payload já foi deletado por /cancel.
      await this.state.storage.delete("claiming");
      console.error("[DO alarm] payload missing after claim — alarm was cancelled, aborting");
      return;
    }

    const { key, entry, webhookUrl: defaultWebhookUrl, pixelWebhookUrl } = payload;
    const webhookTarget: WebhookTarget = entry.webhook_target ?? "diaria";
    const action: QueueAction = entry.action ?? "post";

    let webhookUrl: string;
    if (webhookTarget === "pixel") {
      if (!pixelWebhookUrl) {
        // Configuração incompleta — libera claim pra cron tentar (vai pra DLQ direto).
        await this.state.storage.delete("claiming");
        console.error(`[DO alarm] pixel entry ${key} but pixelWebhookUrl not stored — releasing claim`);
        return;
      }
      webhookUrl = pixelWebhookUrl;
    } else {
      webhookUrl = defaultWebhookUrl;
    }

    // (#2219 bug 3) Estado 2 fases: `claiming:true` (claim ganho, fetch em andamento)
    // → `fired:true` + delete `claiming` (SÓ após sucesso do webhook).
    //
    // Trade-off dup×loss:
    //   - Se setar fired ANTES do fetch (padrão anterior): crash mid-flight → fired=true
    //     mas o post não aconteceu → item perdido silenciosamente (cron vê fired=true,
    //     deleta KV sem postar). Escolha: LOSS (o pior caso).
    //   - Com 2 fases: crash mid-flight → claiming=true, fired=false/undefined →
    //     o cron vê `claiming` (não `fired`) e re-tenta → risco de dup se o webhook
    //     foi parcialmente entregue mas retornou erro por timeout. Escolha: possível DUP.
    //   - Dup é preferível a LOSS para posts LinkedIn: dup é visível (editor pode deletar
    //     o duplicado); post perdido é invisível e passa a falsa impressão de sucesso.
    //   - O claim atomico (via /claim) já elimina o dup CRON↔ALARM (o caso 90%);
    //     o dup residual é apenas no cenário de crash mid-flight + cron re-tenta
    //     (cenário extremamente raro — CF DO tem retry interno).
    //
    // Telemetria de item-loss: cron detecta `claiming=true` sem `fired=true` e loga
    // DLQ-style error pra investigação, permitindo recuperação manual pelo editor.

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          image_url: entry.image_url,
          scheduled_at: entry.scheduled_at,
          destaque: entry.destaque,
          action,
          ...(entry.parent_destaque !== undefined && { parent_destaque: entry.parent_destaque }),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
        // Sucesso: transicionar claiming → fired (2ª fase).
        // fired=true é o sinal pro cron de que não precisa re-disparar.
        await this.state.storage.put("fired", true);
        await this.state.storage.delete("claiming");
        console.log(
          `[DO alarm] fired ok key=${key} target=${webhookTarget} action=${action} destaque=${entry.destaque}`,
        );
        // KV entry permanece até o cron path a encontrar e deletar (com idempotência:
        // cron verifica DO /status, vê fired:true, deleta KV sem re-disparar webhook).
        // Trade-off: item pode aparecer em /list por até 5min após fire. Aceitável.
      } else {
        // Fire falhou — libera o claim pra cron fallback tentar via retry normal.
        await this.state.storage.delete("claiming");
        const body = await res.text();
        console.error(
          `[DO alarm] fire failed key=${key} status=${res.status}: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      // Timeout ou exception — libera o claim pra cron fallback.
      await this.state.storage.delete("claiming");
      const err = e as Error;
      console.error(`[DO alarm] fire exception key=${key}: ${err.message}`);
    }
  }
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
  await env.LINKEDIN_QUEUE.delete(key);

  // (#2219 bug 1) Cancelar o alarm do DO correspondente — sem isso, o DO alarm
  // dispara de qualquer jeito e posta no LinkedIn mesmo após o editor cancelar.
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

  return json({ deleted: true, key, do_alarm_cancelled: doAlarmCancelled });
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

    // (#2219 bug 2) Exactly-once via /claim atômico no DO.
    // O cron usa POST /claim em vez de GET /status-then-fire: o DO testa-e-seta
    // `claiming` dentro de blockConcurrencyWhile, eliminando a janela de corrida
    // onde cron lê fired=false, alarm() também lê fired=false, e ambos postam.
    //
    // Resultado possível:
    //   claimed=true  → este caller (cron) ganhou; pode postar
    //   claimed=false → alarm() ou outro cron já ganhou o claim; apenas limpar KV
    //   DO unavailable → fallback: cron dispara normalmente (compat com deploys antigos)
    //
    // (#2219 bug 3) Telemetria de item-loss: se o DO reporta claiming=true sem
    // fired=true (crash mid-flight do alarm), o cron detecta via /status e loga
    // error pra o editor investigar (em vez de silenciosamente pular).
    let cronShouldFire = true; // default = fallback (DO indisponível)
    try {
      const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
      const doStub = env.LINKEDIN_SCHEDULER.get(doId);

      // Verificar estado atual antes de tentar claim:
      // Se fired=true → alarm já completou com sucesso, apenas limpar KV.
      // Se claiming=true mas fired=false → crash mid-flight detectado, logar.
      const statusRes = await doStub.fetch("https://do/status", { method: "GET" });
      if (statusRes.ok) {
        const status = await statusRes.json() as { fired: boolean };
        if (status.fired) {
          // DO já disparou — apenas limpar KV entry sem re-fire
          await env.LINKEDIN_QUEUE.delete(k.name);
          console.log(`[fire] ${k.name} already fired by DO alarm — cleaning KV (idempotency)`);
          fired++; // conta como fired pra estatísticas
          continue;
        }
      }

      // Tentar ganhar o claim atômico. Se alarm() já ganhou (ou está em andamento),
      // não disparamos — evita dup cron↔alarm.
      const claimRes = await doStub.fetch("https://do/claim", { method: "POST" });
      if (claimRes.ok) {
        const claimData = await claimRes.json() as { claimed: boolean };
        if (!claimData.claimed) {
          // Alarm (ou outro cron) ganhou o claim — não postar.
          // Item será limpo na próxima rodada do cron quando fired=true.
          console.log(`[fire] ${k.name} claim lost — alarm or peer cron already claimed, skipping`);
          cronShouldFire = false;
        }
        // Se claimed=true: cronShouldFire permanece true, cron dispara normalmente.
      }
      // Se claimRes não ok: fallback — cron dispara normalmente
    } catch {
      // DO indisponível ou binding ausente — cron dispara normalmente (fallback)
    }

    if (!cronShouldFire) continue;

    // #595 — Resolver webhook URL por target. Default "diaria" pra backward-compat.
    // Pixel target sem MAKE_PIXEL_WEBHOOK_URL configurado → DLQ direto, evita loop.
    const webhookTarget: WebhookTarget = entry.webhook_target ?? "diaria";
    const action: QueueAction = entry.action ?? "post";
    let webhookUrl: string;
    if (webhookTarget === "pixel") {
      if (!env.MAKE_PIXEL_WEBHOOK_URL) {
        // Sem URL Pixel → DLQ imediato (não retry, não dá pra resolver).
        const dlqKey = buildDlqKey(k.name, entry.scheduled_at);
        await env.LINKEDIN_QUEUE.put(
          dlqKey,
          JSON.stringify({ ...entry, retry_count: MAX_RETRIES }),
          { expirationTtl: DLQ_TTL_SECONDS },
        );
        await env.LINKEDIN_QUEUE.delete(k.name);
        console.error(
          `[fire] ${k.name} dropped to dlq: webhook_target=pixel but MAKE_PIXEL_WEBHOOK_URL not configured (dlq_key=${dlqKey})`,
        );
        dlq++;
        continue;
      }
      webhookUrl = env.MAKE_PIXEL_WEBHOOK_URL;
    } else {
      webhookUrl = env.MAKE_WEBHOOK_URL;
    }

    // Disparar webhook Make (#881 — com timeout)
    let succeeded = false;
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          image_url: entry.image_url,
          scheduled_at: entry.scheduled_at,
          destaque: entry.destaque,
          // #595 — forward action + parent_destaque pro Make scenario.
          // Make Diar.ia faz Router por action; Pixel só aceita "comment".
          action,
          ...(entry.parent_destaque !== undefined && { parent_destaque: entry.parent_destaque }),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) {
        await env.LINKEDIN_QUEUE.delete(k.name);
        // Transicionar DO para fired=true (idempotência: alarm() não re-disparará
        // se CF tentar re-invocar após o cron ter disparado via claim).
        try {
          const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
          const doStub = env.LINKEDIN_SCHEDULER.get(doId);
          await doStub.fetch("https://do/status-set-fired", { method: "POST" });
        } catch {
          // Non-fatal — cron já deletou KV; alarm() não poderá re-disparar sem KV entry.
        }
        console.log(
          `[fire] ${k.name} fired (target=${webhookTarget} action=${action} destaque=${entry.destaque}, scheduled=${entry.scheduled_at})`,
        );
        fired++;
        succeeded = true;
      } else {
        const body = await res.text();
        // Liberar claim no DO pra próximo retry do cron poder tentar de novo.
        try {
          const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
          const doStub = env.LINKEDIN_SCHEDULER.get(doId);
          await doStub.fetch("https://do/release-claim", { method: "POST" });
        } catch { /* non-fatal */ }
        console.error(
          `[fire] ${k.name} make webhook returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      const err = e as Error;
      // Liberar claim no DO pra próximo retry do cron poder tentar de novo.
      try {
        const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
        const doStub = env.LINKEDIN_SCHEDULER.get(doId);
        await doStub.fetch("https://do/release-claim", { method: "POST" });
      } catch { /* non-fatal */ }
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
 * Resposta: { rearmed: number, skipped_past: number, failed: number }
 */
async function handleRearm(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const now = Date.now();
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let rearmed = 0;
  let skippedPast = 0;
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

    const scheduledMs = Date.parse(entry.scheduled_at);
    if (isNaN(scheduledMs) || scheduledMs <= now) {
      // Passado ou inválido — deixar pro cron fallback
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

  return json({ rearmed, skipped_past: skippedPast, failed });
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
