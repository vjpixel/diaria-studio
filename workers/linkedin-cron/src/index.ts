/**
 * diaria-linkedin-cron — Cloudflare Worker (#TBD)
 *
 * Fila de posts agendados pra diar.ia.br. Nasceu exclusivo pro LinkedIn
 * (substituindo o agendamento via Make.com Data Store, que não funcionou —
 * ver `feedback_make_searchrecord_mapping_unsolved.md`), e desde #3817
 * também agenda o Instagram — mesmo Worker, mesma fila KV, campo `channel`
 * na entry decide o branch de disparo (ver dispatch.ts). Motivo do Instagram
 * ter entrado aqui em vez de ganhar Worker próprio: a API de Content
 * Publishing do Instagram não tem agendamento nativo (media_publish sempre
 * publica na hora) e o media container expira em 24h — a mesma infra de
 * agendamento preciso (DO alarms) + guardar payload completo até o disparo
 * já resolvia exatamente esse problema pro LinkedIn.
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
 *   DIARIA_TOKEN                   → header X-Diaria-Token pra autenticar /queue, /list e /dlq
 *   MAKE_WEBHOOK_URL               → URL do webhook Make (Scenario A "Integration LinkedIn")
 *   MAKE_WEBHOOK_API_KEY            → (#3903) header x-make-apikey enviado no POST ao webhook
 *                                    Make acima. Opcional — migração incremental: ausente = POST
 *                                    sem o header (comportamento atual). Reativa o
 *                                    authenticationMethod que o scenario ANTERIOR (2270381) já tinha.
 *   INSTAGRAM_BUSINESS_ACCOUNT_ID  → (#3817) conta @diar.ia.br pra channel="instagram"
 *   INSTAGRAM_ACCESS_TOKEN         → (#3817) token de página com escopo instagram_content_publish
 *   INSTAGRAM_VJPIXEL_ACCOUNT_ID   → (#10823) conta do Instagram vinculada à página VJ pixel
 *                                    (`ig_account: "vjpixel"`) — opcional; ausente = o enqueue
 *                                    recusa entries dessa conta (400 `instagram_account_creds_missing`)
 *   INSTAGRAM_VJPIXEL_ACCESS_TOKEN → (#10823) token da página VJ pixel com instagram_content_publish
 *   THREADS_ACCESS_TOKEN           → (#3944 Parte B) token de longa duração do app Threads da Meta
 *   THREADS_USER_ID                → (#3944 Parte B) Threads user ID da conta @diar.ia.br
 *   LINKEDIN_ACCESS_TOKEN          → (#8052) token com escopo w_organization_social (ou w_member_social)
 *                                    pra API DIRETA do LinkedIn (Images API + Posts API) — usado SÓ
 *                                    pelo caminho carrossel (image_urls > 1). O post single-image
 *                                    continua indo pelo webhook Make (MAKE_WEBHOOK_URL acima).
 *   LINKEDIN_AUTHOR_URN            → (#8052) URN da página/perfil que publica o carrossel
 *                                    (urn:li:organization:{id} ou urn:li:person:{id})
 * Vars (via [vars] no wrangler.toml, não-secretas):
 *   INSTAGRAM_API_VERSION          → (#3817) default "v25.0" se ausente (aplicado em dispatch.ts)
 *   THREADS_API_VERSION            → (#3944 Parte B) default "v1.0" se ausente (aplicado em dispatch.ts)
 *   LINKEDIN_API_VERSION           → (#8052) header LinkedIn-Version (YYYYMM), default "202401" se
 *                                    ausente (aplicado em dispatch.ts)
 */

export interface Env {
  LINKEDIN_QUEUE: KVNamespace;
  DIARIA_TOKEN: string;
  MAKE_WEBHOOK_URL: string;
  // #595 — webhook URL do scenario Make "Pixel LinkedIn" (vjpixel personal,
  // só faz comments na Diar.ia company page). Opcional pra backward-compat:
  // se ausente, items com webhook_target="pixel" vão pra DLQ com reason claro.
  MAKE_PIXEL_WEBHOOK_URL?: string;
  // #3903 — header x-make-apikey enviado em todo POST ao webhook Make (diaria
  // e pixel). Opcional pra backward-compat: ausente = POST sem o header
  // (comportamento atual, sem auth) — ver dispatch.ts::fireLinkedIn.
  MAKE_WEBHOOK_API_KEY?: string;
  // #1168 — Durable Object namespace pra alarms por item.
  LINKEDIN_SCHEDULER: DurableObjectNamespace;
  // #3817 — credenciais Graph API pro canal Instagram (Content Publishing).
  // Opcionais pra backward-compat: se ausentes quando um item channel="instagram"
  // for disparado, vai pra DLQ com motivo claro (mesmo padrão do
  // MAKE_PIXEL_WEBHOOK_URL ausente, ver dispatch.ts::resolveInstagramCreds).
  INSTAGRAM_BUSINESS_ACCOUNT_ID?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  INSTAGRAM_API_VERSION?: string; // default "v25.0" aplicado em dispatch.ts
  // #10823 — 2ª conta do Instagram (a vinculada à página VJ pixel), usada por
  // entries com `ig_account: "vjpixel"` (Reels do /diaria-shorts). Mesma
  // versão de API da conta da diar.ia.br. Opcionais: ausentes = o enqueue
  // recusa entries dessa conta (fail-early, mesmo racional do #8303).
  INSTAGRAM_VJPIXEL_ACCOUNT_ID?: string;
  INSTAGRAM_VJPIXEL_ACCESS_TOKEN?: string;
  // #3944 Parte B — credenciais Threads API pro canal "threads". Opcionais pra
  // backward-compat: se ausentes quando um item channel="threads" for
  // disparado, vai pra DLQ com motivo claro (mesmo padrão do Instagram, ver
  // dispatch.ts::resolveThreadsCreds).
  THREADS_ACCESS_TOKEN?: string;
  THREADS_USER_ID?: string;
  THREADS_API_VERSION?: string; // default "v1.0" aplicado em dispatch.ts
  // #8052 — credenciais da API DIRETA do LinkedIn (Images API + Posts API),
  // usadas SÓ pelo caminho carrossel (image_urls > 1). Opcionais pra
  // backward-compat: se ausentes quando uma entry linkedin com carrossel for
  // disparada, vai pra DLQ com motivo claro (mesmo padrão do Instagram/
  // Threads, ver dispatch.ts::resolveLinkedInCreds). O post single-image
  // continua indo pelo webhook Make (MAKE_WEBHOOK_URL), intocado.
  LINKEDIN_ACCESS_TOKEN?: string;
  LINKEDIN_AUTHOR_URN?: string;
  LINKEDIN_API_VERSION?: string; // default "202401" aplicado em dispatch.ts
  // #9569 — webhook opcional (Slack/Discord/etc., aceita JSON com `text`) pro
  // alarme de DLQ e (#9618) pro refresh do token Threads falhando com o token
  // já perto de vencer. Ausente = só console.error.
  ALERT_WEBHOOK_URL?: string;
}

export type WebhookTarget = "diaria" | "pixel";

/**
 * `destaque` aceito em POST /queue. Exportado (#9568) pra o teste de contrato
 * comparar com o que os publishers da diária emitem — `um` (4º post, item USE
 * MELHOR) entrou aqui; sem ele o Worker devolvia 400 e o 4º post nunca agendava.
 */
// #10766: `eia-{AAMMDD}` (post avulso do "É IA?") saiu — o quiz não é mais
// publicado nas redes, só na newsletter. Recusar no enqueue é o guard pra não voltar.
// #10823: `shorts` — Reels do vídeo curto da edição (/diaria-shorts).
export const QUEUE_DESTAQUE_RE = /^(d[123]|um|shorts|weekly(-[a-z]+)?|especial(-[a-z]+)?)$/;
export type QueueAction = "post" | "comment";
// #3817/#3944 Parte B — canal de disparo. Ausente/undefined = "linkedin" SEMPRE
// (backward-compat obrigatória: entries já em produção no KV nunca tiveram este campo).
export type QueueChannel = "linkedin" | "instagram" | "threads";
/**
 * #10823 — conta do Instagram que publica a entry. Ausente = "diaria" SEMPRE
 * (backward-compat: entries já no KV nunca tiveram este campo).
 */
export type InstagramAccount = "diaria" | "vjpixel";
export const INSTAGRAM_ACCOUNTS: readonly InstagramAccount[] = ["diaria", "vjpixel"];
/** #10823 — a Graph API aceita no máximo 3 colaboradores por mídia. */
export const MAX_COLLABORATORS = 3;
/** #10823 — username do Instagram: letras, dígitos, `.` e `_`, até 30. */
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

/** #10922 — container de Reels em processamento, retomável entre voltas. */
export interface ReelsContainerRef {
  id: string;
  /** ISO 8601 — o container expira 24 h depois de criado. */
  created_at: string;
}

export interface QueueEntry {
  text: string;
  image_url: string | null;
  scheduled_at: string; // ISO 8601
  destaque: string; // d1 | d2 | d3 | um (#9568) | weekly[-mode] | especial[-mode]
  created_at: string;
  retry_count?: number; // #880 — incrementado a cada falha de fetch
  // #595 — fields opcionais pra suportar comments. Default `webhook_target`
  // = "diaria" e `action` = "post" pra backward-compat com entries antigas.
  webhook_target?: WebhookTarget;
  action?: QueueAction;
  parent_destaque?: string; // qual destaque o comment pertence (auditoria)
  // #3817 — canal de disparo. Ver QueueChannel acima — default "linkedin".
  channel?: QueueChannel;
  // #4153 — lista de imagens pro carrossel do Instagram (5 cards do post
  // semanal, 1 por dia). ALÉM de `image_url` acima, nunca no lugar dele —
  // entries já no KV de produção antes desta issue nunca tiveram este campo
  // (mesma disciplina de backward-compat do `channel` ausente, #3817).
  // Semântica em dispatch.ts::fireInstagram: length > 1 = carrossel (fluxo de
  // 3 passos da Graph API); length === 1 ou ausente = caminho single-image de
  // sempre (via `image_urls[0]` ou `image_url`, indistinguível pro caller).
  image_urls?: string[];
  // #10823 — Reels agendado. `media_type: "REELS"` exige `channel: "instagram"`
  // e `video_url` público (https); `image_url`/`image_urls` não se aplicam.
  // Ausente = post de imagem/carrossel de sempre.
  media_type?: "REELS";
  video_url?: string;
  /** #10823 — usernames convidados como collab (só com media_type=REELS, ≤3). */
  collaborators?: string[];
  /** #10823 — conta do Instagram que publica (default "diaria"). Ver InstagramAccount. */
  ig_account?: InstagramAccount;
  /**
   * #10906 — chave idempotente do enqueue, quando o caller manda. Define o
   * segmento final da key (`idempotentQueueUuid`): o mesmo POST repetido cai
   * na MESMA key e no MESMO Durable Object, nunca numa 2ª entry. Ausente =
   * uuid aleatório de sempre.
   */
  idempotency_key?: string;
  /**
   * #10922 — container de Reels criado numa volta anterior que não chegou a
   * publicar (não ficou FINISHED dentro do teto do poll, ou o `media_publish`
   * falhou). A volta seguinte retoma ESTE container em vez de criar outro, então
   * o tempo de processamento da Meta soma entre as voltas em vez de recomeçar do
   * zero (vertical de 275 MB em 261022). Gravado só pelo Worker, nunca aceito
   * no POST /queue.
   */
  reels_container?: ReelsContainerRef;
  // (#2230 bug 2 fix) Tombstone de cancelamento: setado por handleQueueDelete quando
  // o KV.delete falha após o DO cancel. O cron detecta este flag, pula o item sem
  // postar, e o deleta do KV (cleanup do tombstone).
  cancelled?: boolean;
  // (#7626) Motivo da última falha — gravado SÓ ao mover pra dlq: (fire.ts,
  // nos pontos que escrevem lá: outcome.status="dlq" instantâneo, retry
  // esgotado e envio ambíguo — `last_error` começando por `send_unknown:`,
  // post que pode ter saído e não foi refeito, #11106). Antes deste campo, o motivo só existia em console.error
  // efêmero do Worker — sem acesso a `wrangler tail` em tempo real no
  // momento exato da falha, uma entry em DLQ virava um "post sumiu" sem
  // diagnóstico possível (achado ao vivo: 2 posts semanais de Instagram
  // caíram em DLQ em 260907 e só foram notados 260908, achado #7626).
  // Nunca setado em entries "queue:" ativas — só em "dlq:".
  last_error?: string;
}

// ── Constantes ─────────────────────────────────────────────────────────────

export const MAX_RETRIES = 5; // #880 — após isso, vai pra dlq:
export const FETCH_TIMEOUT_MS = 30_000; // #881 — timeout por fetch ao Make
export const MAX_TEXT_LENGTH = 10_000; // #882 — limite de caracteres do post
export const MAX_URL_LENGTH = 2_000; // #882 — limite de comprimento de image_url
// #4153 — limites do carrossel da Graph API do Instagram (2 a 10 itens).
// CAROUSEL_MIN_ITEMS é só documentacional aqui: `image_urls` com 1 item é
// válido (caminho single-image, não-carrossel — ver dispatch.ts::fireInstagram),
// então o enforcement em handleEnqueue só rejeita 0 (vazio) e >10 (acima do
// máximo). O mínimo de 2 pra ser um carrossel de fato é natural: length > 1
// já implica length >= 2.
export const CAROUSEL_MIN_ITEMS = 2;
export const CAROUSEL_MAX_ITEMS = 10;
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
 * #10906 — formato aceito em `idempotency_key` no POST /queue. Curto e sem
 * espaço: vira hash, mas o valor cru fica gravado na entry pra auditoria.
 */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * #10906 — uuid DETERMINÍSTICO a partir da chave idempotente (SHA-256, 128
 * bits, no formato 8-4-4-4-12). Formato de uuid de propósito: a key continua
 * casando `QUEUE_KEY_NEW_RE` (schema novo, não legacy) e `buildDlqKey` segue
 * extraindo o segmento depois do último `:`.
 *
 * Por que a key e não um índice à parte: com a key igual, duas requisições
 * concorrentes que passem juntas pelo `get` gravam a MESMA entry e armam o
 * MESMO Durable Object (`idFromName(key)`), cujo claim/`fired` já garante um
 * disparo só. Um índice `idem:` dependeria da consistência eventual do KV.
 */
export async function idempotentQueueUuid(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idempotencyKey));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * #10992 item 2 — nome do DO-índice de uma chave idempotente. A queue key leva
 * o horário (`queue:{iso}:{uuid}`), então o mesmo pedido com outro
 * `scheduled_at` cai em OUTRA key e outro DO; o índice (por uuid, sem horário)
 * guarda qual key é a atual pra o enqueue achar e substituir a anterior.
 */
export function idempotencyIndexName(uuid: string): string {
  return `idem:${uuid}`;
}

/** #10992 — estado do DO de uma queue key; `null` = DO inalcançável/ilegível. */
export interface DoFireState {
  fired: boolean;
  /** `claiming` ainda dentro do `CLAIM_TTL_MS` = disparo em andamento. */
  inFlight: boolean;
}

/** #11107 — `/cancel` que o DO recusa (409) se um disparo estiver em andamento. */
const CANCEL_IF_NOT_CLAIMING: RequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ if_not_claiming: true }),
};

/**
 * #11215 — o `/cancel` condicional devolve 409 em dois casos: disparo em
 * andamento (`claiming`) ou DO que já disparou (`fired`/`send_unknown`). O
 * cliente precisa saber qual: no 2º o post já saiu e tentar de novo não serve.
 */
async function cancelConflictReason(res: Response): Promise<"already_fired" | "fire_in_progress"> {
  try {
    const body = (await res.json()) as { fired?: unknown };
    return body.fired === true ? "already_fired" : "fire_in_progress";
  } catch {
    return "fire_in_progress";
  }
}

function doStub(env: Env, name: string): DurableObjectStub {
  return env.LINKEDIN_SCHEDULER.get(env.LINKEDIN_SCHEDULER.idFromName(name));
}

async function readDoFireState(env: Env, queueKey: string): Promise<DoFireState | null> {
  try {
    const res = await doStub(env, queueKey).fetch("https://do/status", { method: "GET" });
    if (!res.ok) return null;
    const s = (await res.json()) as { fired?: unknown; claiming?: unknown; claimed_at?: unknown };
    const claimedAt = typeof s.claimed_at === "number" ? s.claimed_at : null;
    const inFlight = s.claiming === true && (claimedAt === null || Date.now() - claimedAt <= CLAIM_TTL_MS);
    return { fired: s.fired === true, inFlight };
  } catch {
    return null;
  }
}

async function readIdempotencyIndex(env: Env, indexName: string): Promise<string | null> {
  try {
    const res = await doStub(env, indexName).fetch("https://do/idem", { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as { queue_key?: unknown };
    return typeof body.queue_key === "string" && body.queue_key.startsWith("queue:") ? body.queue_key : null;
  } catch (e) {
    console.warn(`[enqueue] índice idempotente ${indexName} ilegível: ${(e as Error).message} (#10992)`);
    return null;
  }
}

async function writeIdempotencyIndex(env: Env, indexName: string, queueKey: string): Promise<void> {
  try {
    const res = await doStub(env, indexName).fetch("https://do/idem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queue_key: queueKey }),
    });
    if (!res.ok) console.warn(`[enqueue] índice idempotente ${indexName} não gravado: HTTP ${res.status} (#10992)`);
  } catch (e) {
    console.warn(`[enqueue] índice idempotente ${indexName} não gravado: ${(e as Error).message} (#10992)`);
  }
}

/**
 * #10992 item 1 — resposta de conflito do enqueue idempotente: o pedido não
 * agenda nada (o DO daquela key já disparou, ou está disparando). Antes, o
 * Worker respondia 202 `alarm_armed: true` e o cliente registrava "agendado"
 * para algo que nunca saía.
 */
function idempotentConflict(error: "already_fired" | "fire_in_progress", key: string): Response {
  const message =
    error === "already_fired"
      ? "este pedido (idempotency_key) já foi disparado — nada novo foi agendado. Confira a conta antes de publicar de novo."
      : "este pedido (idempotency_key) está sendo disparado agora — nada foi alterado. Tente de novo em alguns minutos.";
  return json({ error, message, key }, 409);
}

/**
 * #10917 — campos que definem O QUE é publicado. Ficam de fora os de estado
 * (`created_at`, `retry_count`, `cancelled`, `last_error`...), que mudam sem
 * que o pedido mude.
 */
const IDEMPOTENT_CONTENT_FIELDS = [
  "text",
  "image_url",
  "image_urls",
  "scheduled_at",
  "destaque",
  "webhook_target",
  "action",
  "parent_destaque",
  "channel",
  "media_type",
  "video_url",
  "collaborators",
  "ig_account",
] as const satisfies readonly (keyof QueueEntry)[];

/**
 * #10917 — o que fazer quando o POST /queue com `idempotency_key` encontra
 * uma entry na key: `duplicate` (mesmo conteúdo, entry viva: retry do
 * cliente), `cancelled` (tombstone do DELETE /queue) ou `changed` (conteúdo
 * diferente, ou entry ilegível). Só `duplicate` deixa a entry como está.
 */
export function classifyIdempotentExisting(existingRaw: string, incoming: QueueEntry): "duplicate" | "cancelled" | "changed" {
  let existing: QueueEntry;
  try {
    existing = JSON.parse(existingRaw) as QueueEntry;
  } catch {
    return "changed";
  }
  if (existing === null || typeof existing !== "object") return "changed";
  if (existing.cancelled === true) return "cancelled";
  return sameQueueContent(existing, incoming) ? "duplicate" : "changed";
}

/**
 * #10917/#11024 — duas entries publicam a MESMA coisa (mesmos
 * `IDEMPOTENT_CONTENT_FIELDS`)? Usado pelo enqueue idempotente e pelo `/arm`
 * do DO, que só preserva o container de Reels guardado quando o conteúdo
 * re-armado é o mesmo.
 */
export function sameQueueContent(a: QueueEntry, b: QueueEntry): boolean {
  const project = (e: QueueEntry) => JSON.stringify(IDEMPOTENT_CONTENT_FIELDS.map((f) => e[f] ?? null));
  return project(a) === project(b);
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
export * from "./dispatch";
export * from "./maintenance";
import { withRefreshedThreadsToken, maybeRefreshThreadsToken, alertNewDlqEntries, shouldSweepDlq } from "./maintenance";
import { resolveInstagramCreds, resolveInstagramVjpixelCreds, resolveThreadsCreds, resolveLinkedInCreds } from "./dispatch";

/**
 * #10823 — valida os campos de Reels (`media_type`, `video_url`,
 * `collaborators`) e a conta do Instagram (`ig_account`). Devolve o corpo do
 * 400 ou `null` quando está tudo certo. Puro sobre `body` + `env` (só lê se a
 * credencial da 2ª conta existe).
 */
export function validateReelsFields(
  body: Partial<QueueEntry>,
  env: Env,
): { body: { error: string; code?: string } } | null {
  const isInstagram = body.channel === "instagram";
  if (body.ig_account !== undefined) {
    if (!INSTAGRAM_ACCOUNTS.includes(body.ig_account as InstagramAccount)) {
      return { body: { error: `ig_account must be one of: ${INSTAGRAM_ACCOUNTS.join(", ")}` } };
    }
    if (!isInstagram) return { body: { error: "ig_account only applies to channel='instagram'" } };
    if (body.ig_account === "vjpixel" && !resolveInstagramVjpixelCreds(env)) {
      return {
        body: {
          error:
            "ig_account='vjpixel' requer INSTAGRAM_VJPIXEL_ACCOUNT_ID e INSTAGRAM_VJPIXEL_ACCESS_TOKEN configurados no Worker — não configurados",
          code: "instagram_account_creds_missing",
        },
      };
    }
  }
  if (body.media_type !== undefined && body.media_type !== "REELS") {
    return { body: { error: "media_type must be 'REELS' (omit for image/carousel posts)" } };
  }
  const isReels = body.media_type === "REELS";
  if (!isReels) {
    if (body.video_url !== undefined) return { body: { error: "video_url requires media_type='REELS'" } };
    if (body.collaborators !== undefined) return { body: { error: "collaborators requires media_type='REELS'" } };
    return null;
  }
  if (!isInstagram) return { body: { error: "media_type='REELS' requires channel='instagram'" } };
  if (body.image_url || body.image_urls !== undefined) {
    return { body: { error: "media_type='REELS' does not take image_url/image_urls (use video_url)" } };
  }
  if (typeof body.video_url !== "string" || !body.video_url) {
    return { body: { error: "video_url is required when media_type='REELS'" } };
  }
  if (body.video_url.length > MAX_URL_LENGTH) {
    return { body: { error: `video_url exceeds ${MAX_URL_LENGTH} chars` } };
  }
  if (!/^https:\/\//.test(body.video_url)) {
    return { body: { error: "video_url must be a public https URL (the Graph API fetches it)" } };
  }
  if (body.collaborators !== undefined) {
    if (!Array.isArray(body.collaborators)) return { body: { error: "collaborators must be an array of usernames" } };
    if (body.collaborators.length > MAX_COLLABORATORS) {
      return { body: { error: `collaborators exceeds the Graph API max of ${MAX_COLLABORATORS}` } };
    }
    for (const c of body.collaborators as unknown[]) {
      if (typeof c !== "string" || !IG_USERNAME_RE.test(c)) {
        return { body: { error: `collaborators must contain Instagram usernames (got ${JSON.stringify(c)})` } };
      }
    }
  }
  return null;
}

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

  // Validar destaque — d1/d2/d3 (diário) ou weekly[-mode] (#4146/#4483
  // carrossel semanal; #5330 renomeou "weekly" pra "weekly-clicked" /
  // "weekly-highlights", mas "weekly" cru segue aceito — entries antigas no
  // KV/DLQ e qualquer chamador que ainda não migrou não devem quebrar).
  // `eia-{AAMMDD}` (quiz "É IA?") foi aceito até o #10766 — o quiz não sai
  // mais nas redes, então o enqueue recusa.
  // `um`: 4º post diário (item USE MELHOR, #9568) — publish-linkedin/instagram/threads.
  if (!QUEUE_DESTAQUE_RE.test(body.destaque as string)) {
    return json({ error: "destaque must be d1, d2, d3, um, shorts, weekly[-mode], or especial[-mode]" }, 400);
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

  // #3817/#3944 Parte B — Validar channel (opcional; ausente = "linkedin"
  // default aplicado em dispatch.ts::fireQueueEntry — backward-compat com
  // entries já no KV).
  if (
    body.channel !== undefined &&
    body.channel !== "linkedin" &&
    body.channel !== "instagram" &&
    body.channel !== "threads"
  ) {
    return json({ error: "channel must be 'linkedin', 'instagram', or 'threads'" }, 400);
  }
  // #4153 — Validar image_urls (opcional; lista pro carrossel do Instagram).
  // Independente de channel: o campo é genérico em QueueEntry, só o dispatch
  // do Instagram de fato consome. Validar ANTES de enfileirar (não só no
  // disparo) — publicar um carrossel com contagem inválida falharia horas
  // depois na Graph API, e o post promete N dias no texto.
  if (body.image_urls !== undefined) {
    if (!Array.isArray(body.image_urls)) {
      return json({ error: "image_urls must be an array of strings" }, 400);
    }
    const imageUrls = body.image_urls as unknown[];
    if (imageUrls.length === 0) {
      return json(
        { error: "image_urls must not be empty (omit the field to use image_url alone)" },
        400,
      );
    }
    if (imageUrls.length > CAROUSEL_MAX_ITEMS) {
      return json(
        {
          error: `image_urls exceeds the Instagram carousel max of ${CAROUSEL_MAX_ITEMS} items (got ${imageUrls.length})`,
        },
        400,
      );
    }
    for (const u of imageUrls) {
      if (typeof u !== "string") {
        return json({ error: "image_urls must contain only strings" }, 400);
      }
      if (u.length > MAX_URL_LENGTH) {
        return json(
          { error: `image_urls item exceeds ${MAX_URL_LENGTH} chars` },
          400,
        );
      }
    }
  }

  // #10823 — Reels agendado + conta do Instagram por entry. Validado no
  // enqueue pelo mesmo motivo dos guards abaixo: um payload inválido só
  // falharia no disparo, horas depois, com o store local dizendo "agendado".
  const reelsError = validateReelsFields(body, env);
  if (reelsError) return json(reelsError.body, 400);

  // #10906 — chave idempotente (opcional). Validada antes de qualquer escrita.
  if (body.idempotency_key !== undefined) {
    if (typeof body.idempotency_key !== "string" || !IDEMPOTENCY_KEY_RE.test(body.idempotency_key)) {
      return json({ error: "idempotency_key must match [A-Za-z0-9._:-]{1,128}" }, 400);
    }
  }

  // Instagram Graph API (Content Publishing) exige imagem — sem ela o
  // container nem chega a ser criado. Falhar aqui (enqueue) é melhor que
  // falhar só no disparo, horas/dias depois. #4153 — `image_urls` (não-vazio,
  // já validado acima) também satisfaz esta exigência, não só `image_url`.
  if (
    body.channel === "instagram" &&
    body.media_type !== "REELS" &&
    !body.image_url &&
    !(Array.isArray(body.image_urls) && body.image_urls.length > 0)
  ) {
    return json({ error: "image_url or image_urls is required when channel='instagram'" }, 400);
  }
  // #8303 — channel=linkedin (ou ausente, default de backward-compat) com
  // carrossel (image_urls com >1 item) publica via API DIRETA do LinkedIn
  // (fireLinkedInCarousel, #8052), que exige LINKEDIN_ACCESS_TOKEN +
  // LINKEDIN_AUTHOR_URN no Worker (ver resolveLinkedInCreds em dispatch.ts).
  // Sem essa checagem, o enqueue aceitava o POST (esta rota não validava
  // credencial), o caller registrava status "scheduled" e só no disparo
  // (fireQueueEntry) é que caía no DLQ silenciosamente — o store local
  // afirmava um envio que nunca sairia. Mesmo racional dos guards de
  // image_url (Instagram) e de tamanho de texto (Threads) acima: falhar aqui
  // (enqueue, com erro que o caller propaga) é melhor que falhar só no
  // disparo, horas/dias depois. Single-image (webhook Make) não exige essa
  // credencial — só o caminho carrossel.
  const linkedInChannel = body.channel === undefined || body.channel === "linkedin";
  const linkedInImageCount = Array.isArray(body.image_urls)
    ? body.image_urls.length
    : body.image_url
      ? 1
      : 0;
  if (linkedInChannel && linkedInImageCount > 1 && !resolveLinkedInCreds(env)) {
    // `code` machine-readable (além de `error` em prosa) — o caller
    // (`scripts/lib/worker-queue-client.ts::postToWorkerQueue`) o propaga
    // via `WorkerQueueError.code` pra `publish-weekly-social.ts` ramificar
    // sem parsear a mensagem de erro (#8303).
    return json(
      {
        error:
          "channel='linkedin' com carrossel (image_urls) requer LINKEDIN_ACCESS_TOKEN e LINKEDIN_AUTHOR_URN configurados no Worker (API direta, #8052) — não configurados",
        code: "linkedin_creds_missing",
      },
      400,
    );
  }
  // #3944 Parte B — chunking agendado (thread multi-post via reply_to_id)
  // não é suportado no Worker: risco de duplicar posts em retry automático.
  // Falhar aqui (enqueue) é melhor que a Threads API truncar silenciosamente
  // ou o disparo falhar horas depois — mesmo racional do guard de image_url
  // acima.
  if (body.channel === "threads" && typeof body.text === "string" && body.text.length > 500) {
    return json(
      { error: "text must be ≤500 chars when channel='threads' (chunking agendado não suportado, ver #3944 Parte B)" },
      400,
    );
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

  // #10906 — com `idempotency_key`, o uuid sai dela (determinístico): um POST
  // repetido pelo retry do cliente (resposta perdida depois do commit) cai na
  // mesma key em vez de criar uma 2ª entry que publicaria o mesmo Reels de novo.
  const uuid = body.idempotency_key !== undefined ? await idempotentQueueUuid(body.idempotency_key) : crypto.randomUUID();
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
    // #3817 — omitido se undefined: entries sem channel resolvem "linkedin" (default)
    ...(body.channel !== undefined && { channel: body.channel as QueueEntry["channel"] }),
    // #4153 — omitido se undefined: entries sem image_urls usam image_url (single-image)
    ...(body.image_urls !== undefined && { image_urls: body.image_urls as string[] }),
    // #10823 — omitidos se undefined: entries sem eles seguem o caminho de imagem da conta diar.ia.br
    ...(body.media_type !== undefined && { media_type: body.media_type }),
    ...(body.video_url !== undefined && { video_url: body.video_url }),
    ...(body.collaborators !== undefined && { collaborators: body.collaborators }),
    ...(body.ig_account !== undefined && { ig_account: body.ig_account }),
    ...(body.idempotency_key !== undefined && { idempotency_key: body.idempotency_key }),
  };
  // #11133 — a reserva cobre cancel → KV put → arm; finally libera o
  // fallback também nas saídas de erro. O token impede liberar claim alheio.
  let replacementToken: string | undefined;
  try {
  let previousRaw: string | null = null;
  let replaced = false;
  let contentChanged = false; // #11026
  let previousKey: string | null = null;
  const indexName = body.idempotency_key !== undefined ? idempotencyIndexName(uuid) : null;
  if (body.idempotency_key !== undefined && indexName !== null) {
    // Entry já na fila com essa chave e o MESMO conteúdo = repetição do mesmo
    // enqueue (retry depois de resposta perdida). Devolve a key existente sem
    // regravar nem re-armar (a 1ª requisição já armou o DO; se não armou, o
    // cron */5 cobre). 200 e não 202: nada novo foi enfileirado.
    //
    // #10917 — duas exceções, ambas regravam a entry e re-armam o DO:
    //  - tombstone (`cancelled:true`, DELETE /queue cujo KV.delete falhou):
    //    o item foi cancelado; o reenfileiramento é um pedido novo, não
    //    duplicata. Antes, respondia `duplicate` e o cron apagava o tombstone:
    //    o Reels reenfileirado nunca saía.
    //  - conteúdo diferente (ex.: legenda nova no mesmo slot): a entry passa a
    //    ter o conteúdo novo, na MESMA key e no MESMO DO (`/arm` sobrescreve o
    //    payload), então continua saindo um post só. Antes, o conteúdo novo
    //    era descartado em silêncio.
    //
    // #10992 item 1 — o DO desta key guarda `fired=true` depois do disparo
    // (e o cron apaga a entry do KV). Regravar e re-armar ali respondia 202
    // `alarm_armed: true`, mas `tryClaim()` recusava e nada saía. Com o DO já
    // disparado (ou disparando), a única resposta honesta é 409 — exceto a
    // duplicata exata com a entry ainda no KV, que é o retry do cliente de um
    // pedido que de fato saiu (200 `duplicate`, agora com `fired: true`).
    const here = await readDoFireState(env, key);
    const existingRaw = await env.LINKEDIN_QUEUE.get(key);
    previousRaw = existingRaw;
    if (existingRaw !== null) {
      const verdict = classifyIdempotentExisting(existingRaw, entry);
      if (verdict === "duplicate") {
        console.log(`[enqueue] idempotency_key=${body.idempotency_key} já enfileirada em ${key} — duplicata ignorada (#10906)`);
        return json(
          {
            queued: true,
            duplicate: true,
            key,
            scheduled_at: body.scheduled_at as string,
            destaque: body.destaque as string,
            ...(here?.fired && { fired: true }),
          },
          200,
        );
      }
      replaced = true;
      contentChanged = verdict === "changed";
      console.log(`[enqueue] idempotency_key=${body.idempotency_key} em ${key}: ${verdict === "cancelled" ? "entry cancelada (tombstone)" : "conteúdo mudou"} — regravando e re-armando (#10917)`);
    }
    if (here?.fired) return idempotentConflict("already_fired", key);
    if (here?.inFlight) return idempotentConflict("fire_in_progress", key);

    // #11026/#11029 — conteúdo mudou: o DO desta key ainda guarda o container
    // de Reels (#10922) E o payload/alarm da versão antiga. O `/arm` os
    // sobrescreve, mas só roda DEPOIS do KV put e a falha dele é não fatal: com
    // o `/arm` falhando (ou o cron rodando entre o put e o `/arm`), o `/claim`
    // devolveria o container antigo, ou o alarm (mesmo `scheduledAtMs`, mesma
    // key) publicaria o payload antigo. `/cancel` limpa payload, container e
    // alarm de uma vez (`fired`/`inFlight` já foram checados acima); se o
    // `/arm` falhar depois, o cron publica o conteúdo novo a partir do KV. Sem
    // conseguir cancelar, nada é gravado (503).
    if (contentChanged) {
      let clearOk = false;
      try {
        // #11107 — o alarm/cron pode ganhar o /claim entre o /status acima e
        // este cancel; `if_not_claiming` faz o DO recusar (409) em vez de
        // apagar o `claiming` de um disparo em curso.
        replacementToken = crypto.randomUUID();
        const clearRes = await doStub(env, key).fetch("https://do/cancel", {
          ...CANCEL_IF_NOT_CLAIMING,
          body: JSON.stringify({ if_not_claiming: true, replacement_token: replacementToken, replacement_entry: entry }),
        });
        if (clearRes.status === 409) return idempotentConflict(await cancelConflictReason(clearRes), key);
        clearOk = clearRes.ok;
      } catch (e) {
        console.warn(`[enqueue] cancel do DO ${key} (conteúdo mudado) falhou: ${(e as Error).message} (#11029)`);
      }
      if (!clearOk) {
        return json(
          {
            error: "reels_container_clear_failed",
            message: "não deu pra descartar o agendamento e o vídeo preparado da versão anterior deste pedido — nada foi alterado; tente de novo.",
            key,
          },
          503,
        );
      }
    }

    // #10992 item 2 — mesmo pedido, OUTRO horário: a key nova não tem entry,
    // mas o índice aponta a anterior. Sem isto saíam 2 Reels (um por key/DO).
    // A anterior é cancelada e removida antes de gravar a nova; se ela já
    // disparou ou está disparando, 409 (o Reels já saiu, ou está saindo).
    const indexedKey = await readIdempotencyIndex(env, indexName);
    if (indexedKey !== null && indexedKey !== key) {
      const prev = await readDoFireState(env, indexedKey);
      if (prev?.fired) return idempotentConflict("already_fired", indexedKey);
      if (prev?.inFlight) return idempotentConflict("fire_in_progress", indexedKey);
      let cancelOk = false;
      try {
        const cancelRes = await doStub(env, indexedKey).fetch("https://do/cancel", CANCEL_IF_NOT_CLAIMING); // #11107
        if (cancelRes.status === 409) return idempotentConflict(await cancelConflictReason(cancelRes), indexedKey);
        cancelOk = cancelRes.ok;
      } catch (e) {
        console.warn(`[enqueue] cancel do DO ${indexedKey} falhou: ${(e as Error).message} (#10992)`);
      }
      if (!cancelOk) {
        // Sem cancelar o alarm antigo, gravar a key nova publicaria 2 vezes.
        return json(
          {
            error: "reschedule_cancel_failed",
            message: "não deu pra cancelar o agendamento anterior deste pedido — nada foi alterado; tente de novo.",
            key: indexedKey,
          },
          503,
        );
      }
      await env.LINKEDIN_QUEUE.delete(indexedKey);
      previousKey = indexedKey;
      replaced = true;
      console.log(`[enqueue] idempotency_key=${body.idempotency_key}: horário mudou, ${indexedKey} cancelada e substituída por ${key} (#10992)`);
    }
  }
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
  let armConflict: "fire_in_progress" | "already_fired" | null = null;
  try {
    const doId = env.LINKEDIN_SCHEDULER.idFromName(key);
    const doStub = env.LINKEDIN_SCHEDULER.get(doId);
    // #3817/#3944 Parte B — capturar credenciais Instagram/Threads no momento
    // do enqueue, igual já é feito com webhookUrl/pixelWebhookUrl: o DO não
    // tem acesso a `env` no alarm() (só ao payload persistido), então tudo
    // que o disparo precisar tem que estar aqui.
    const igCreds = resolveInstagramCreds(env);
    const igVjpixelCreds = resolveInstagramVjpixelCreds(env); // #10823
    const threadsCreds = resolveThreadsCreds(env);
    const linkedinCreds = resolveLinkedInCreds(env); // #8052
    const armPayload: DoStoredPayload & { scheduledAtMs: number; replacement_token?: string } = {
      ...(replacementToken !== undefined && { replacement_token: replacementToken }),
      scheduledAtMs: scheduledMs,
      key,
      entry,
      webhookUrl: env.MAKE_WEBHOOK_URL,
      ...(env.MAKE_PIXEL_WEBHOOK_URL !== undefined && { pixelWebhookUrl: env.MAKE_PIXEL_WEBHOOK_URL }),
      ...(env.MAKE_WEBHOOK_API_KEY !== undefined && { webhookApiKey: env.MAKE_WEBHOOK_API_KEY }),
      ...(igCreds !== undefined && { instagram: igCreds }),
      ...(igVjpixelCreds !== undefined && { instagramVjpixel: igVjpixelCreds }),
      ...(threadsCreds !== undefined && { threads: threadsCreds }),
      ...(linkedinCreds !== undefined && { linkedin: linkedinCreds }),
    };
    const armRes = await doStub.fetch("https://do/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(armPayload),
    });
    alarmArmed = armRes.ok;
    if (armRes.status === 409) {
      // #10992/#11035 — o DO disparou ou ganhou o claim entre /status e /arm.
      // Propagar o conflito correto ao cliente em vez de confirmar o agendamento.
      const conflict = await armRes.json() as { claiming?: boolean };
      const reason = conflict.claiming ? "fire_in_progress" : "already_fired";
      console.warn(`[enqueue] DO de ${key} recusou /arm: ${reason}`);
      armConflict = reason;
    }
    else if (!armRes.ok) {
      console.warn(`[enqueue] DO arm failed for key=${key} status=${armRes.status} — cron fallback active`);
    }
  } catch (e) {
    // DO indisponível / binding ausente — não bloquear o enqueue
    console.warn(`[enqueue] DO arm exception for key=${key}: ${(e as Error).message} — cron fallback active`);
  }

  // #11044 — /arm pode perder a corrida para o claim depois do KV put.
  // Restaurar fora do catch fail-soft: falha no rollback nunca confirma 202.
  if (armConflict !== null) {
    // #11133 — com reserva, um claim após TTL só pode disparar a entry nova
    // (replacement_entry no DO). Não devolver a antiga por cima desse disparo.
    if (replacementToken === undefined) {
      if (previousRaw === null) await env.LINKEDIN_QUEUE.delete(key);
      else await env.LINKEDIN_QUEUE.put(key, previousRaw);
    }
    return idempotentConflict(armConflict, key);
  }

  // #10992 item 2 — o índice passa a apontar a key atual (fail-soft: sem ele,
  // só a troca de horário deixa de ser detectada; o resto segue igual).
  if (indexName !== null) await writeIdempotencyIndex(env, indexName, key);

  return json(
    {
      queued: true,
      key,
      scheduled_at: entry.scheduled_at,
      destaque: entry.destaque,
      alarm_armed: alarmArmed,
      ...(replaced && { replaced: true }),
      ...(previousKey !== null && { previous_key: previousKey }),
    },
    202,
  );
  } finally {
    // #11133 — put/arm terminou (inclusive falha): libera fallback sem abrir
    // a janela em que o cron reivindicava o conteúdo anterior ao KV put.
    if (replacementToken !== undefined) {
      try {
        await doStub(env, key).fetch("https://do/release-replacement", {
          method: "POST",
          body: JSON.stringify({ replacement_token: replacementToken }),
        });
      } catch { /* TTL recupera reserva se o DO estiver indisponível */ }
    }
  }
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
      // #3817/#3944 Parte B — mesma captura de credenciais Instagram/Threads
      // do enqueue (handleEnqueue), necessária pra items legacy re-armados
      // após um deploy que introduziu channel="instagram"/"threads" ou
      // rotacionou o secret.
      const igCreds = resolveInstagramCreds(env);
      const igVjpixelCreds = resolveInstagramVjpixelCreds(env); // #10823
      const threadsCreds = resolveThreadsCreds(env);
      const linkedinCreds = resolveLinkedInCreds(env); // #8052
      const armPayload: DoStoredPayload & { scheduledAtMs: number } = {
        scheduledAtMs: scheduledMs,
        key: k.name,
        entry,
        webhookUrl: env.MAKE_WEBHOOK_URL,
        ...(env.MAKE_PIXEL_WEBHOOK_URL !== undefined && { pixelWebhookUrl: env.MAKE_PIXEL_WEBHOOK_URL }),
        ...(env.MAKE_WEBHOOK_API_KEY !== undefined && { webhookApiKey: env.MAKE_WEBHOOK_API_KEY }),
        ...(igCreds !== undefined && { instagram: igCreds }),
        ...(igVjpixelCreds !== undefined && { instagramVjpixel: igVjpixelCreds }),
        ...(threadsCreds !== undefined && { threads: threadsCreds }),
        ...(linkedinCreds !== undefined && { linkedin: linkedinCreds }),
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
      return handleEnqueue(request, await withRefreshedThreadsToken(env));
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
      const result = await fireDueItems(await withRefreshedThreadsToken(env));
      return json({ ok: true, ...result });
    }
    // #1168 — POST /rearm re-arma DO alarms pra items KV legacy pós-deploy.
    // Editor chama 1x após deploy pra garantir que items pré-deploy tenham alarms.
    if (path === "/rearm" && request.method === "POST") {
      return handleRearm(request, await withRefreshedThreadsToken(env));
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // #9569 — refresh do token Threads (ainda válido) + overlay do KV antes de disparar.
        await maybeRefreshThreadsToken(env).catch((e) => console.error(`[cron] threads-refresh: ${e}`));
        const result = await fireDueItems(await withRefreshedThreadsToken(env));
        console.log(`[cron] fired=${result.fired} errors=${result.errors} dlq=${result.dlq}`);
        // #9618 — varredura de DLQ custa KV `list`: só no topo da hora ou quando este disparo gerou DLQ.
        if (shouldSweepDlq(event?.scheduledTime ?? NaN, result.dlq)) {
          await alertNewDlqEntries(env).catch((e) => console.error(`[cron] dlq-alert: ${e}`));
        }
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
