/**
 * meta-capi.ts (#5504)
 *
 * Conversions API (server-side) da Meta para o evento `CompleteRegistration`
 * — fecha o gap descrito na issue: o pixel `1285191740325112` só recebia
 * `PageView` client-side desde a criação (dez/2025), então não existia
 * Event Match Quality nem sinal de conversão pra a Meta otimizar por
 * cadastro (`server_last_fired_time` na epoch Unix, confirmado ao vivo em
 * 16/08/2026).
 *
 * Escopo desta issue: pontos de disparo (a) formulários próprios —
 * `workers/poll/src/subscribe.ts`, `workers/cursos/src/subscribe.ts`,
 * `workers/reativar/src/index.ts` — e (b) batch server-side a partir do
 * snapshot Beehiiv (`scripts/meta-capi-batch-send.ts`). O ponto (c)
 * (`/confirmado`) fica fora de escopo, marcado como "opcional depois" na
 * issue.
 *
 * ## Fronteira `lib/shared/` (#2747)
 *
 * Só Web Crypto (`crypto.subtle`) e `fetch` globais — zero import de
 * `node:*` — pra rodar idêntico em Node (scripts, testes) e no runtime
 * Cloudflare Workers, mesmo padrão de `poll-token.ts` (ver docstring desse
 * arquivo pro precedente completo).
 *
 * ## Privacidade — só o HASH viaja pra Meta
 *
 * O e-mail em claro NUNCA sai deste módulo em direção à rede. `hashEmailForMeta`
 * normaliza (trim + lowercase, exigência documentada da Meta pro matching
 * funcionar) e aplica SHA-256 — só o hex do digest entra em `user_data.em`.
 * Nenhuma função aqui loga o e-mail cru; os campos de log estruturado (nos
 * workers que chamam este módulo) seguem o mesmo cuidado já usado em
 * `activateSubscription`/`subscribeToBeehiiv` (nunca logar PII).
 *
 * ## `event_id` determinístico — dedup contra evento client-side futuro
 *
 * A Meta deduplica eventos server-side × client-side pelo par
 * (`event_name`, `event_id`) quando os dois carregam o MESMO `event_id`
 * dentro de uma janela de tempo (doc oficial: dedup key). Derivar o
 * `event_id` de (e-mail normalizado, data do cadastro) — em vez de um
 * UUID aleatório por chamada — significa que reenviar o MESMO cadastro
 * (retry, reprocessamento do batch) produz sempre o mesmo id: a Meta
 * absorve o reenvio como duplicata em vez de contar 2 conversões, e um
 * eventual pixel client-side futuro no mesmo evento/dia pode reusar a
 * mesma fórmula pra deduplicar contra o server-side sem coordenação extra.
 *
 * ## Fail-soft obrigatório (#5504, item de aceite explícito na issue)
 *
 * `sendCompleteRegistrationEvent` NUNCA lança e NUNCA deixa a ausência do
 * token virar erro visível pro caller — token ausente é no-op silencioso
 * (`reason: "not_configured"`), mesmo padrão documentado em
 * `workers/reativar/src/index.ts:309-310`. O cadastro em si (Beehiiv) já
 * terá sido confirmado ANTES desta chamada em todo call site — telemetria
 * de anúncio nunca pode derrubar ou atrasar de forma visível um cadastro
 * real.
 */

/** Dataset (pixel) ID confirmado ao vivo na issue #5504 — não é secret (é
 * público em qualquer página que carregue o pixel via `fbq('init', ...)`),
 * por isso vive como constante, não como env var. `META_CAPI_DATASET_ID`
 * segue disponível como override opcional pros callers que quiserem manter
 * um teste/staging separado sem editar código. */
export const META_CAPI_DEFAULT_DATASET_ID = "1285191740325112";

/** Versão do Graph API usada pelo endpoint de eventos server-side. Mesma
 * família de constante que `FACEBOOK_API_VERSION` (`.env.example`) usa pro
 * Graph API de publicação — CAPI é um endpoint distinto do mesmo produto,
 * override tem o mesmo nome de padrão (`apiVersion` no options bag). */
export const META_CAPI_DEFAULT_API_VERSION = "v21.0";

/** Timeout do fetch pra CAPI — mesmo racional de `SUBSCRIBE_FETCH_TIMEOUT_MS`
 * (`workers/poll/src/subscribe.ts`): um hang aqui nunca pode travar o
 * handler de cadastro que disparou o evento. */
export const META_CAPI_FETCH_TIMEOUT_MS = 8000;

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Normalização exigida pela Meta antes do hash de `em` — trim + lowercase.
 * Pure, sem I/O — testável isoladamente. */
export function normalizeEmailForMeta(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 hex do e-mail já normalizado — o único formato que trafega pra
 * Meta em `user_data.em`. Mesma entrada (mesmo e-mail, variando
 * maiúsculas/espaços) sempre produz o mesmo hash. */
export async function hashEmailForMeta(email: string): Promise<string> {
  return sha256Hex(normalizeEmailForMeta(email));
}

/**
 * `event_id` determinístico do `CompleteRegistration` — hash de
 * (e-mail normalizado, dia UTC do `event_time`). Mesmo par sempre produz o
 * mesmo id: reenviar o mesmo cadastro no mesmo dia (retry do handler,
 * reprocessamento do batch) é uma DUPLICATA pra Meta, nunca uma 2ª
 * conversão — ver rationale completo no docstring do módulo.
 *
 * `eventTimeSeconds`: Unix epoch em SEGUNDOS (mesma unidade de
 * `event_time` do payload CAPI e de `BeehiivBackupSubscriber.created`).
 */
export async function computeCompleteRegistrationEventId(
  email: string,
  eventTimeSeconds: number,
): Promise<string> {
  const normalized = normalizeEmailForMeta(email);
  const day = new Date(eventTimeSeconds * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return sha256Hex(`capi:completeregistration:${normalized}:${day}`);
}

export type MetaCapiActionSource = "website" | "system_generated" | "email";

export interface MetaCapiCompleteRegistrationEvent {
  event_name: "CompleteRegistration";
  event_time: number;
  event_source_url: string;
  action_source: MetaCapiActionSource;
  event_id: string;
  user_data: { em: [string] };
}

export interface BuildCompleteRegistrationEventInput {
  /** E-mail em claro do assinante — nunca é incluído no evento resultante,
   * só o hash (`hashEmailForMeta`). */
  email: string;
  /** URL da página/endpoint onde o cadastro aconteceu (`event_source_url`,
   * campo exigido pela Meta pra `action_source: "website"`). */
  eventSourceUrl: string;
  /** Unix epoch em segundos do momento do cadastro. Default: agora — usado
   * pelos 3 handlers de formulário (item (a) do escopo). O batch (item (b))
   * passa o `created` real do snapshot Beehiiv, preservando o timestamp
   * histórico do cadastro em vez de "agora" (momento do reprocessamento). */
  eventTimeSeconds?: number;
  /** `"website"` (default, cadastro veio de um form nosso) ou
   * `"system_generated"` (batch reprocessando um snapshot — não é uma
   * ação de navegador no momento do envio). */
  actionSource?: MetaCapiActionSource;
}

/** Monta o evento `CompleteRegistration` pronto pra `sendMetaCapiEvent` —
 * pure exceto pelo hash assíncrono (Web Crypto). Nunca envia rede; separado
 * de `sendMetaCapiEvent` pra ser testável sem mock de fetch. */
export async function buildCompleteRegistrationEvent(
  input: BuildCompleteRegistrationEventInput,
): Promise<MetaCapiCompleteRegistrationEvent> {
  const eventTime = input.eventTimeSeconds ?? Math.floor(Date.now() / 1000);
  const [em, eventId] = await Promise.all([
    hashEmailForMeta(input.email),
    computeCompleteRegistrationEventId(input.email, eventTime),
  ]);
  return {
    event_name: "CompleteRegistration",
    event_time: eventTime,
    event_source_url: input.eventSourceUrl,
    action_source: input.actionSource ?? "website",
    event_id: eventId,
    user_data: { em: [em] },
  };
}

export type MetaCapiSendResult =
  | { ok: true; status: number }
  | { ok: false; status: number; reason: "not_configured" | "meta_error" | "network_error" };

export interface SendMetaCapiEventOptions {
  /** `META_CAPI_ACCESS_TOKEN` — `undefined`/`""` é tratado como "não
   * configurado" (no-op), nunca como erro. */
  accessToken: string | undefined;
  datasetId?: string;
  apiVersion?: string;
  /** Override do host base — só pra teste (evita mock de `fetchImpl` só pra
   * trocar o domínio). Default: `https://graph.facebook.com/{apiVersion}`. */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** `test_event_code` do Events Manager — a issue exige validar contra o
   * modo de teste ANTES de mandar evento de produção. Nunca setado por
   * padrão; caller passa explicitamente durante a validação manual. */
  testEventCode?: string;
}

/** POST cru do evento já montado pra `{dataset_id}/events`. Nunca lança —
 * qualquer falha de rede/parse volta como `MetaCapiSendResult` com
 * `ok: false`, mesmo padrão de `subscribeToBeehiiv`/`activateSubscription`. */
export async function sendMetaCapiEvent(
  event: MetaCapiCompleteRegistrationEvent,
  options: SendMetaCapiEventOptions,
): Promise<MetaCapiSendResult> {
  const accessToken = options.accessToken;
  if (!accessToken) {
    return { ok: false, status: 503, reason: "not_configured" };
  }

  const datasetId = options.datasetId ?? META_CAPI_DEFAULT_DATASET_ID;
  const apiVersion = options.apiVersion ?? META_CAPI_DEFAULT_API_VERSION;
  const base = options.apiBaseUrl ?? `https://graph.facebook.com/${apiVersion}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  const body: Record<string, unknown> = {
    data: [event],
    access_token: accessToken,
  };
  if (options.testEventCode) body.test_event_code = options.testEventCode;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/${datasetId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(META_CAPI_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, reason: "network_error" };
  }
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, reason: "meta_error" };
}

/**
 * Wrapper de conveniência — monta + envia o `CompleteRegistration` num
 * único call, NUNCA lança (try/catch envolve tudo, incluindo o hash e a
 * montagem do payload). É esta função que os 3 handlers de formulário (item
 * (a) do escopo) e o batch (item (b)) chamam — nenhum deles precisa saber
 * do formato do payload CAPI, só do resultado fail-soft.
 *
 * Sem `accessToken` configurado, retorna `not_configured` SEM sequer montar
 * o evento (poupa o hash) — mesmo contrato de `sendMetaCapiEvent`.
 */
export async function sendCompleteRegistrationEvent(
  input: BuildCompleteRegistrationEventInput,
  options: SendMetaCapiEventOptions,
): Promise<MetaCapiSendResult> {
  if (!options.accessToken) return { ok: false, status: 503, reason: "not_configured" };
  try {
    const event = await buildCompleteRegistrationEvent(input);
    return await sendMetaCapiEvent(event, options);
  } catch {
    // Qualquer exceção inesperada (ex: Web Crypto indisponível num runtime
    // atípico) também vira no-op fail-soft — telemetria de anúncio nunca
    // pode propagar uma exceção pro caller do cadastro.
    return { ok: false, status: 502, reason: "network_error" };
  }
}
