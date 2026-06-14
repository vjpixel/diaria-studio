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
 *   4. `alarm()` chama `tryClaim()` DIRETAMENTE (sem self-fetch — #2230 bug 3).
 *   5. Se claim ganho: lê payload, dispara webhook Make.
 *   6. Se sucesso: grava `fired:true` + deleta `payload` do storage (#2230 bug 1).
 *      Com payload ausente E fired=true, qualquer alarm posterior via TTL expiry
 *      (claim re-claimado) não tem o quê postar.
 *   7. KV delete é feito pelo Worker cron path após confirmar `fired:true`;
 *      idempotência impede double-fire mesmo se alarm disparar mais de 1x.
 *
 * Idempotência (alarm + cron fallback):
 *   - DO armazena `fired:true` + deleta `payload` após fire bem-sucedido.
 *   - `fireDueItems` (cron path) consulta DO via `/status` antes de disparar
 *     item com `alarm_armed:true`. Se DO reporta `fired:true`, cron apenas
 *     deleta a KV entry sem re-disparar o webhook.
 *   - Sem acesso a DO (ex: DO destruído), cron dispara normalmente (fallback).
 *
 * Protocol interno (fetch ao DO):
 *   POST /arm     body: DoStoredPayload + { scheduledAtMs: number }
 *                 → persiste payload, agenda alarm, retorna { armed: true }
 *   POST /cancel  → cancela alarm, limpa storage (para DELETE /queue/:key)
 *   GET  /status  → retorna { fired: boolean; claiming: boolean; claimed_at: number | null } (consultado por fireDueItems)
 *   POST /claim   → check-and-set atômico de `claiming` dentro de
 *                   blockConcurrencyWhile. Retorna { claimed: boolean }.
 *                   `true` significa "este caller ganhou o claim e pode postar".
 *                   `false` significa "outro caller já está processando" — não postar.
 *                   Implementa exactly-once entre cron↔alarm (#2219 bug 2).
 *                   (#2230 bug 3) alarm() usa tryClaim() DIRETAMENTE — não via self-fetch.
 */
export class LinkedInScheduler {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * tryClaim — lógica de claim atômico chamada DIRETAMENTE pelo alarm() (#2230 bug 3).
   *
   * Evita nested `blockConcurrencyWhile` que ocorria quando alarm() chamava
   * `this.fetch('/claim')`, que internamente entrava em blockConcurrencyWhile.
   * Agora alarm() chama este método diretamente dentro de UM blockConcurrencyWhile.
   *
   * Reutiliza a mesma lógica do endpoint POST /claim (com TTL de claim expirado).
   * O endpoint POST /claim ainda existe para o cron path (fetch externo ao DO).
   */
  async tryClaim(): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const alreadyClaiming = await this.state.storage.get<boolean>("claiming");
      const alreadyFired = await this.state.storage.get<boolean>("fired");
      if (alreadyFired) return false;
      if (alreadyClaiming) {
        // Verificar se o claim expirou (crash mid-flight sem release)
        const claimedAt = await this.state.storage.get<number>("claimed_at");
        const claimExpired = claimedAt !== undefined && (Date.now() - claimedAt) > CLAIM_TTL_MS;
        if (!claimExpired) return false;
        // Claim expirado — logar e re-clamar
        console.warn(`[DO tryClaim] claim expired after ${Date.now() - (claimedAt ?? 0)}ms — re-claiming (crash recovery)`);
      }
      await this.state.storage.put("claiming", true);
      await this.state.storage.put("claimed_at", Date.now());
      return true;
    });
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
      // (#2219 bug 6 fix) Expor `claiming` pra telemetria de crash-mid-flight.
      // Se claiming=true + fired=false, o cron pode detectar via /status que o alarm
      // travou no meio — logar DLQ-style error pra investigação do editor.
      const claiming = (await this.state.storage.get<boolean>("claiming")) ?? false;
      const claimedAt = await this.state.storage.get<number>("claimed_at");
      return new Response(JSON.stringify({ fired, claiming, claimed_at: claimedAt ?? null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /claim — check-and-set atômico pra exactly-once entre cron↔alarm.
    // (#2219 bug 2) O DO event loop serializa tudo, então blockConcurrencyWhile
    // garante que 2 callers concorrentes (alarm + cron) não ganhem o claim
    // simultaneamente. O 1º que chegar seta `claiming:true` + `claimed_at` e
    // retorna { claimed: true }. O 2º lê `claiming:true` e retorna { claimed: false }.
    //
    // (#2219 bug 2 fix) Claim com TTL: se `claimed_at` é mais antigo que
    // CLAIM_TTL_MS, o claim é considerado expirado e pode ser re-claimado.
    // Isso evita que um DO fique travado permanentemente se `/release-claim`
    // falhar transitoriamente (ex: CF retry de alarm sem release prévio).
    if (url.pathname === "/claim" && request.method === "POST") {
      const claimed = await this.state.blockConcurrencyWhile(async () => {
        const alreadyClaiming = await this.state.storage.get<boolean>("claiming");
        const alreadyFired = await this.state.storage.get<boolean>("fired");
        if (alreadyFired) return false;
        if (alreadyClaiming) {
          // Verificar se o claim expirou (crash mid-flight sem release)
          const claimedAt = await this.state.storage.get<number>("claimed_at");
          const claimExpired = claimedAt !== undefined && (Date.now() - claimedAt) > CLAIM_TTL_MS;
          if (!claimExpired) return false;
          // Claim expirado — logar e re-clamar
          console.warn(`[DO claim] claim expired after ${Date.now() - (claimedAt ?? 0)}ms — re-claiming (crash recovery)`);
        }
        await this.state.storage.put("claiming", true);
        await this.state.storage.put("claimed_at", Date.now());
        return true;
      });
      return new Response(JSON.stringify({ claimed }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /status-set-fired — cron path seta fired=true + limpa claiming + payload após
    // fire bem-sucedido. Permite que o DO saiba que o cron disparou, evitando
    // que o alarm() tente re-disparar em CF retry.
    // (#2230 bug 1 fix) Deleta também o `payload` para consistência com o alarm path:
    // mesmo que o alarm() seja re-invocado (TTL+claim expirado), sem payload não há o
    // quê postar — segunda linha de defesa contra double-post.
    if (url.pathname === "/status-set-fired" && request.method === "POST") {
      await this.state.storage.put("fired", true);
      await this.state.storage.delete("payload");  // (#2230 bug 1 fix) payload limpo
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /release-claim — cron ou alarm libera claiming após falha do webhook,
    // permitindo que o próximo retry do cron tente novamente.
    if (url.pathname === "/release-claim" && request.method === "POST") {
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  async alarm(): Promise<void> {
    // (#2230 bug 3 fix) Claim atômico via tryClaim() DIRETAMENTE — sem self-fetch.
    // O self-fetch anterior (`this.fetch('/claim')`) criava nested blockConcurrencyWhile:
    // alarm() rodava em isolamento DO, depois `fetch('/claim')` entrava em outro
    // blockConcurrencyWhile interno, o que pode lançar em algumas runtimes CF.
    // Fix: tryClaim() contém o blockConcurrencyWhile diretamente — 1 nível apenas.
    //
    // (#2219 bug 2) Claim atômico garante exactly-once com cron fallback:
    // blockConcurrencyWhile serializa alarm() e cron — apenas 1 ganha o claim.
    const claimed = await this.tryClaim();
    if (!claimed) {
      console.log("[DO alarm] claim lost — cron already claimed or fired, skipping to avoid dup");
      return;
    }

    const payload = await this.state.storage.get<DoStoredPayload>("payload");
    if (!payload) {
      // Alarm foi cancelado (DELETE /queue) mas alarm já estava enfileirado no CF.
      // Clearing do claim pra não bloquear nada; payload já foi deletado por /cancel.
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
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
        await this.state.storage.delete("claimed_at");
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
        // (#2230 bug 1 fix) Sucesso: gravar fired=true DURÁVEL + limpar payload ANTES
        // de liberar o claim. Dupla proteção contra double-post via alarm re-disparado:
        //   1. fired=true: tryClaim() retorna false imediatamente (caminho rápido).
        //   2. payload deletado: mesmo que o claim TTL expire e alarm() re-entre,
        //      a leitura de payload retorna null → abort sem postar.
        // O comentário anterior "alarm não poderá re-disparar sem KV entry" estava ERRADO
        // (#2230 bug 1): alarm lê DO storage, não KV. Fix: payload limpo no DO storage.
        //
        // Retry de 3x pra garantir que fired=true persiste (transitório CF storage error).
        // Sem retry, uma falha aqui deixa o DO em claiming=true,fired=false → o cron
        // pode re-clamar via TTL e re-postar (double-post).
        let firedPersisted = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.state.storage.put("fired", true);
            await this.state.storage.delete("payload");   // payload limpo — alarm re-entry posta nada
            await this.state.storage.delete("claiming");
            await this.state.storage.delete("claimed_at");
            firedPersisted = true;
            break;
          } catch (storageErr) {
            console.warn(`[DO alarm] storage put fired attempt ${attempt + 1} failed: ${(storageErr as Error).message}`);
            if (attempt < 2) await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
          }
        }
        if (!firedPersisted) {
          // Storage persistentemente indisponível — logar crítico mas não lançar
          // (CF alarm não re-tenta se alarm() não lança; deixamos cron detectar via claiming=true).
          console.error(`[DO alarm] CRITICAL: failed to persist fired=true after 3 attempts — key=${key}; double-post risk if alarm re-fires via TTL`);
        }
        console.log(
          `[DO alarm] fired ok key=${key} target=${webhookTarget} action=${action} destaque=${entry.destaque} fired_persisted=${firedPersisted}`,
        );
        // KV entry permanece até o cron path a encontrar e deletar (com idempotência:
        // cron verifica DO /status, vê fired:true, deleta KV sem re-disparar webhook).
        // Trade-off: item pode aparecer em /list por até 5min após fire. Aceitável.
      } else {
        // Fire falhou — libera o claim pra cron fallback tentar via retry normal.
        await this.state.storage.delete("claiming");
        await this.state.storage.delete("claimed_at");
        const body = await res.text();
        console.error(
          `[DO alarm] fire failed key=${key} status=${res.status}: ${body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      // Timeout ou exception — libera o claim pra cron fallback.
      await this.state.storage.delete("claiming");
      await this.state.storage.delete("claimed_at");
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

    // (#2230 bug 2 fix) Verificar tombstone de cancelamento.
    // Se handleQueueDelete gravou um tombstone (cancelled=true) porque o KV.delete
    // falhou após o DO cancel, o cron deve pular e limpar esta entry sem postar.
    if (entry.cancelled) {
      // (#2235 fix F5) Garantir DO /cancel best-effort ao limpar tombstone: mesmo que o DO
      // cancel já tenha sido feito no handleQueueDelete, o DO pode ter re-armado (rearm).
      // Limpar o payload do DO ao remover o tombstone é a defesa final contra post-após-delete.
      try {
        const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
        const doStub = env.LINKEDIN_SCHEDULER.get(doId);
        await doStub.fetch("https://do/cancel", { method: "POST" });
      } catch { /* non-fatal — DO pode não estar disponível */ }
      await env.LINKEDIN_QUEUE.delete(k.name);
      console.log(`[fire] ${k.name} is a cancellation tombstone — DO cancelled + deleted without firing`);
      continue;
    }

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
        // Fix #F3 (confirmed bug): include `claiming` in the type — previously the cast
        // `as { fired: boolean }` dropped `claiming` from the parsed object, making the
        // crash-detection logic (claiming=true + fired=false) permanently unreachable.
        const status = await statusRes.json() as { fired: boolean; claiming: boolean; claimed_at: number | null };
        if (status.fired) {
          // DO já disparou — apenas limpar KV entry sem re-fire
          await env.LINKEDIN_QUEUE.delete(k.name);
          console.log(`[fire] ${k.name} already fired by DO alarm — cleaning KV (idempotency)`);
          fired++; // conta como fired pra estatísticas
          continue;
        }
        // Telemetria de crash mid-flight: claiming=true + fired=false indica que o alarm()
        // ganhou o claim mas crashou antes de completar o post. Logar erro pra investigação.
        if (status.claiming && !status.fired) {
          const claimedAgo = status.claimed_at ? Date.now() - status.claimed_at : null;
          console.error(`[fire] ${k.name} crash-mid-flight detected: claiming=true, fired=false, claimed_at_ms_ago=${claimedAgo} — cron will attempt re-fire via /claim`);
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

    // (#2219 bug 1 fix) Helper pra liberar o claim no DO após qualquer saída
    // sem post bem-sucedido (DLQ-path, skip, erro). O padrão try/finally é
    // aplicado abaixo: se o cron ganhou o claim mas NÃO postou com sucesso,
    // o claim é liberado via /release-claim pra não travar o DO permanentemente.
    const releaseCronClaim = async () => {
      // Só libera se cronShouldFire=true (significa que ganhamos o claim)
      try {
        const doId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
        const doStub = env.LINKEDIN_SCHEDULER.get(doId);
        await doStub.fetch("https://do/release-claim", { method: "POST" });
      } catch { /* non-fatal — eviction limpará o DO */ }
    };

    // #595 — Resolver webhook URL por target. Default "diaria" pra backward-compat.
    // Pixel target sem MAKE_PIXEL_WEBHOOK_URL configurado → DLQ direto, evita loop.
    const webhookTarget: WebhookTarget = entry.webhook_target ?? "diaria";
    const action: QueueAction = entry.action ?? "post";
    let webhookUrl: string;
    if (webhookTarget === "pixel") {
      if (!env.MAKE_PIXEL_WEBHOOK_URL) {
        // (#2219 bug 1 fix) Liberar claim ANTES de ir pro DLQ — sem isso o DO
        // fica com claiming=true permanente e o alarm fica travado até eviction.
        await releaseCronClaim();
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
        // (#2235 fix) Transicionar DO para fired=true + limpar payload com retry robusto.
        // CRÍTICO: alarm() lê o PAYLOAD do DO storage, NÃO do KV. Sem fired=true E sem
        // payload no DO, o alarm não tem o quê postar mesmo se re-disparar via TTL expiry.
        // Dupla proteção (espelhando o alarm path em alarm()):
        //   1. fired=true: tryClaim() retorna false imediatamente.
        //   2. payload deletado por /status-set-fired: alarm re-entry aborta cedo (payload missing).
        // Sem retry aqui, uma falha silenciosa deixa o DO em claiming=true+fired=false+payload
        // presente → cron pode re-clamar via TTL e re-postar (double-post).
        //
        // (#2235 fix F8) DO stub içado pra fora do loop: idFromName()+get() é O(1) mas
        // chamado 3× no loop original sem necessidade — içar evita redundância e simplifica.
        let firedSetOk = false;
        let sfDoStub: { fetch: (url: string, init?: RequestInit) => Promise<Response> } | null = null;
        try {
          const sfDoId = env.LINKEDIN_SCHEDULER.idFromName(k.name);
          sfDoStub = env.LINKEDIN_SCHEDULER.get(sfDoId);
        } catch { /* binding ausente — sfDoStub permanece null */ }
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!sfDoStub) break;
          try {
            const sfRes = await sfDoStub.fetch("https://do/status-set-fired", { method: "POST" });
            if (sfRes.ok) {
              firedSetOk = true;
              break;
            }
            console.warn(`[fire] /status-set-fired attempt ${attempt + 1} returned ${sfRes.status} for key=${k.name}`);
          } catch (sfErr) {
            // (#2235 fix F9) String(sfErr) em vez de (sfErr as Error).message — undefined pra não-Error
            console.warn(`[fire] /status-set-fired attempt ${attempt + 1} failed for key=${k.name}: ${String(sfErr)}`);
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        }
        if (!firedSetOk) {
          // Falha persistente: KV já deletado, mas DO ainda tem payload + claiming=true.
          // (#2235 fix F1) Chamar /cancel best-effort: sem payload, alarm re-entry não tem o quê
          // postar mesmo que re-claime via TTL. Invariante: payload limpo ⇒ sem re-post.
          // Se /cancel também falhar, NÃO há mais o que fazer (KV já deletado) — logar crítico.
          let cancelledViaCancel = false;
          if (sfDoStub) {
            try {
              const cancelRes = await sfDoStub.fetch("https://do/cancel", { method: "POST" });
              cancelledViaCancel = cancelRes.ok;
              if (cancelRes.ok) {
                console.warn(`[fire] /status-set-fired failed after 3 attempts for key=${k.name} — called /cancel to clear payload (double-post prevention)`);
              } else {
                console.error(`[fire] CRITICAL: /status-set-fired AND /cancel failed for key=${k.name} status=${cancelRes.status} — DO payload may remain, double-post risk if alarm re-fires via TTL`);
              }
            } catch (cancelErr) {
              console.error(`[fire] CRITICAL: /status-set-fired AND /cancel threw for key=${k.name}: ${String(cancelErr)} — DO payload may remain, double-post risk if alarm re-fires via TTL`);
            }
          } else {
            console.error(`[fire] CRITICAL: /status-set-fired skipped (DO binding absent) for key=${k.name} — double-post risk if alarm re-fires via TTL`);
          }
          void cancelledViaCancel; // loggado acima
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

    const scheduledMs = Date.parse(entry.scheduled_at);
    if (isNaN(scheduledMs) || scheduledMs <= now) {
      // Passado ou inválido — deixar pro cron fallback
      skippedPast++;
      continue;
    }

    // (#2235 fix F4) Tombstones com scheduled_at futuro acumulam no KV porque nem
    // o cron (não são processados — cancelamento impediu post), nem o rearm anterior
    // (só pulava sem deletar) os limpavam. Fix: ao encontrar tombstone com scheduled_at
    // futuro, deletar (item já cancelado — não tem porquê re-armar).
    // Redundante com o cron cleanup (que cobre tombstones passados), mas essencial
    // pra limpar tombstones que ainda estão no futuro (cron não os toca até a hora).
    if (entry.cancelled) {
      console.log(`[rearm] ${k.name} has tombstone (cancelled=true) — deleting to prevent accumulation`);
      try {
        await env.LINKEDIN_QUEUE.delete(k.name);
      } catch (delErr) {
        console.warn(`[rearm] failed to delete tombstone ${k.name}: ${String(delErr)}`);
      }
      skippedTombstone++;
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
