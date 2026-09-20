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
 * (`/confirmada`, era `/confirmado` antes do #8539) fica fora de escopo,
 * marcado como "opcional depois" na issue.
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
 * Desde o #8388 o evento também carrega `client_ip_address`,
 * `client_user_agent`, `fbp` e `fbc` — esses NÃO são hasheados (a Meta
 * exige em claro; hashear invalida o match), então o título acima vale pro
 * E-MAIL, não pro evento inteiro. O que não mudou: nada disso entra em log
 * (ver `MetaCapiLogEvent`), nada disso é persistido por este módulo, e os
 * 4 são exatamente os sinais que o pixel client-side já entregaria à Meta
 * a partir do navegador do visitante.
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

/**
 * #8388 item 1 — `custom_data.value`/`custom_data.currency` do
 * `CompleteRegistration`.
 *
 * O Events Manager do dataset `Diar.ia` levantou "Send higher quality
 * currency data for better performance optimization" (High priority, 1 ad
 * set afetado) porque NENHUM dos dois caminhos que alimentam o evento
 * mandava valor: nem o pixel client-side (tag do GTM, só `content_name` +
 * `status`), nem este módulo (montava `user_data` e nenhum `custom_data`).
 * Sem valor, a Meta não consegue otimizar por valor.
 *
 * Decisão do editor (#8388): valor simbólico CONSTANTE agora — consistência
 * entre pixel e CAPI importa mais que o número, e valor modelado por coorte
 * só existe depois do #7918. **O mesmo par valor/moeda precisa sair dos
 * DOIS caminhos**: valor divergente entre pixel e CAPI estraga justamente
 * a comparação que o `event_id` determinístico acima existe pra permitir.
 * Por isso estas duas constantes são a fonte única, e
 * `test/meta-capi-8388.test.ts` lê o snippet `fbq(...)` do export do
 * container GTM (`docs/gtm-signup-container-export.json`) pra travar a
 * igualdade — o pixel não é código executado por este repo, mas o valor
 * dele é versionado aqui e portanto auditável.
 */
export const META_CAPI_COMPLETE_REGISTRATION_VALUE = 1;
export const META_CAPI_COMPLETE_REGISTRATION_CURRENCY = "BRL";

/**
 * #8388 item 3 — parâmetros de match quality que o Worker JÁ TEM e não
 * mandava. A recomendação "Improve your match quality by sending more
 * parameters" do Events Manager cita telefone; telefone está FORA (o form
 * de `/assinar` pede nome + e-mail, e pedir telefone pra assinar newsletter
 * derruba conversão — decisão registrada na issue). O ganho real é este.
 *
 * **Estes 4 campos NÃO são hasheados** — ao contrário de `em`, a Meta exige
 * `client_ip_address`, `client_user_agent`, `fbp` e `fbc` em CLARO (hashear
 * invalida o match). Isso não afrouxa a regra de privacidade do módulo:
 * continuam valendo (a) nada disto entra em log — os `MetaCapiLogEvent`
 * seguem carregando só nome do worker + desfecho, travado por teste, e (b)
 * os 4 são exatamente os sinais que o pixel client-side no navegador do
 * visitante já entregaria à Meta por conta própria.
 *
 * **Cobertura deliberadamente parcial dos call sites:** só `workers/poll` e
 * `workers/cursos` mandam estes 4 — são os dois handlers que recebem o
 * `Request` do cadastro. `workers/reativar` NÃO manda: `handleConfirm`
 * recebe uma `URL`, não o `Request`, então não há headers/cookies de onde
 * tirá-los sem mudar a assinatura e os call sites; o batch
 * (`meta-capi-batch-send.ts`, `system_generated`) reprocessa um snapshot e
 * não tem request nenhum. Não é esquecimento — quem for fechar a ponta do
 * `reativar` depois precisa passar o `Request` (ou só os headers) pra
 * dentro do `handleConfirm`.
 */
export interface MetaCapiClientSignals {
  /** IP do visitante — `CF-Connecting-IP` (ou 1ª entrada de
   * `X-Forwarded-For`) no Worker. */
  clientIpAddress?: string;
  /** `user-agent` cru do request do cadastro. */
  clientUserAgent?: string;
  /** Cookie first-party `_fbp` do pixel em `diar.ia.br`. */
  fbp?: string;
  /** Cookie `_fbc`, ou derivado do `fbclid` capturado no cadastro (#8003,
   * `click_id` prefixado) — ver `buildFbcFromClickId`. */
  fbc?: string;
}

/** Forma canônica dos cookies `_fbp`/`_fbc` da Meta:
 * `fb.{subdomainIndex}.{creationTimeMs}.{payload}`. Valor que não casa é
 * DESCARTADO em vez de repassado — são cookies lidos do request do cliente
 * (controláveis por quem manda o request), e mandar lixo pra Meta degrada o
 * match em vez de melhorar. */
const FB_COOKIE_RE = /^fb\.\d+\.\d+\..+$/;

/** Caracteres aceitos num `fbclid` — mesma defesa em profundidade que o
 * `SUBSCRIBE_CLIENT_ORIGIN_MAX` dos workers aplica ao mesmo campo: o valor
 * vem do cliente. */
const FBCLID_RE = /^[A-Za-z0-9_.-]+$/;

/** Prefixo que o #8003 usa pro click id da Meta em `click_id`
 * (`gclid:`/`fbclid:`/`msclkid:` — ver `scripts/lib/site-assinar-page.ts`). */
export const META_CLICK_ID_PREFIX = "fbclid:";

/** Lê UM cookie do header `Cookie` cru. Pure, nunca lança; devolve
 * `undefined` (nunca `""`) pra cookie ausente ou vazio.
 * @pure */
export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/**
 * Deriva o `fbc` a partir do `click_id` capturado no cadastro (#8003), no
 * formato exigido pela Meta: `fb.1.{creationTimeMs}.{fbclid}`.
 * `subdomainIndex` 1 = cookie de domínio (`diar.ia.br`), que é onde o pixel
 * grava o `_fbc` real.
 *
 * Devolve `undefined` (nunca `""`) quando o click id não é da Meta
 * (`gclid:`/`msclkid:`/vazio) ou quando o payload não parece um `fbclid`.
 * Pure — o timestamp é PARÂMETRO, não `Date.now()` interno.
 * @pure
 */
export function buildFbcFromClickId(
  clickId: string | undefined,
  creationTimeMs: number,
): string | undefined {
  const raw = (clickId ?? "").trim();
  if (!raw.startsWith(META_CLICK_ID_PREFIX)) return undefined;
  const fbclid = raw.slice(META_CLICK_ID_PREFIX.length).trim();
  if (!fbclid || !FBCLID_RE.test(fbclid)) return undefined;
  return `fb.1.${Math.floor(creationTimeMs)}.${fbclid}`;
}

/** Subconjunto de `Headers` que `extractMetaCapiClientSignals` consome —
 * evita exigir um `Request` inteiro em teste. */
export interface MetaCapiHeaderSource {
  get(name: string): string | null;
}

export interface ExtractMetaCapiClientSignalsOptions {
  /** `click_id` do cadastro (#8003) — só usado quando não há cookie `_fbc`. */
  clickId?: string;
  /** Epoch em MILISSEGUNDOS pro `fbc` derivado. Default: agora. */
  fbcCreationTimeMs?: number;
}

/**
 * Extrai os 4 sinais de match quality dos headers do request de cadastro.
 * Pure exceto pelo `Date.now()` de fallback (injetável via
 * `fbcCreationTimeMs`). Campo ausente/vazio é OMITIDO da saída — nunca vira
 * string vazia, que a Meta contaria como parâmetro presente e de match ruim.
 */
export function extractMetaCapiClientSignals(
  headers: MetaCapiHeaderSource,
  options: ExtractMetaCapiClientSignalsOptions = {},
): MetaCapiClientSignals {
  const signals: MetaCapiClientSignals = {};

  // Mesma ordem/fallback do rate-limit dos workers: `CF-Connecting-IP` é o
  // header autoritativo da Cloudflare; `X-Forwarded-For` pode ser lista.
  const ip =
    (headers.get("CF-Connecting-IP") ?? "").trim() ||
    (headers.get("X-Forwarded-For") ?? "").split(",")[0].trim();
  if (ip) signals.clientIpAddress = ip;

  const ua = (headers.get("user-agent") ?? "").trim();
  if (ua) signals.clientUserAgent = ua;

  const cookieHeader = headers.get("Cookie");
  const fbp = readCookieValue(cookieHeader, "_fbp");
  if (fbp && FB_COOKIE_RE.test(fbp)) signals.fbp = fbp;

  // Cookie real do pixel tem precedência sobre o derivado: ele carrega o
  // timestamp do CLIQUE, o derivado carrega o do cadastro.
  const fbcCookie = readCookieValue(cookieHeader, "_fbc");
  const fbc =
    fbcCookie && FB_COOKIE_RE.test(fbcCookie)
      ? fbcCookie
      : buildFbcFromClickId(options.clickId, options.fbcCreationTimeMs ?? Date.now());
  if (fbc) signals.fbc = fbc;

  return signals;
}

export type MetaCapiActionSource = "website" | "system_generated" | "email";

/** `user_data` do evento — `em` (hash) é o único campo sempre presente; os
 * 4 sinais do #8388 são opcionais e OMITIDOS quando ausentes. */
export interface MetaCapiUserData {
  em: [string];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
}

export interface MetaCapiCompleteRegistrationEvent {
  event_name: "CompleteRegistration";
  event_time: number;
  event_source_url: string;
  action_source: MetaCapiActionSource;
  event_id: string;
  user_data: MetaCapiUserData;
  /** #8388 item 1 — sempre presente, sempre o mesmo par constante do pixel. */
  custom_data: { value: number; currency: string };
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
  /** #8388 item 3 — sinais de match quality lidos do request do cadastro
   * (`extractMetaCapiClientSignals`). Ausente no batch server-side
   * (`system_generated`), que reprocessa um snapshot e não tem request
   * nenhum de onde tirá-los. Campo vazio/`undefined` é OMITIDO do
   * `user_data`, nunca vira string vazia. */
  clientSignals?: MetaCapiClientSignals;
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
  const userData: MetaCapiUserData = { em: [em] };
  // #8388: só entra a chave que TEM valor — `client_ip_address: ""` seria
  // contado pela Meta como parâmetro presente e de match ruim, pior que
  // ausente.
  const signals = input.clientSignals;
  if (signals?.clientIpAddress) userData.client_ip_address = signals.clientIpAddress;
  if (signals?.clientUserAgent) userData.client_user_agent = signals.clientUserAgent;
  if (signals?.fbp) userData.fbp = signals.fbp;
  if (signals?.fbc) userData.fbc = signals.fbc;
  return {
    event_name: "CompleteRegistration",
    event_time: eventTime,
    event_source_url: input.eventSourceUrl,
    action_source: input.actionSource ?? "website",
    event_id: eventId,
    user_data: userData,
    // #8388 item 1: constante, idêntica ao pixel — ver as constantes acima.
    custom_data: {
      value: META_CAPI_COMPLETE_REGISTRATION_VALUE,
      currency: META_CAPI_COMPLETE_REGISTRATION_CURRENCY,
    },
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

/**
 * Log estruturado do caminho de no-op (#7776, follow-up do #5504).
 *
 * `sendCompleteRegistrationEvent` já distinguia `"not_configured"` de
 * `"meta_error"`/`"network_error"` no `MetaCapiSendResult` desde o #5504 —
 * o gap real era que os 3 call sites (`workers/poll`, `workers/cursos`,
 * `workers/reativar`) descartavam esse resultado em silêncio
 * (`ctx.waitUntil(sendEvent)`/`await sendEvent` sem `.then`/leitura),
 * então "token ausente" (esperado até o editor setar o secret) e "token
 * presente mas a Meta rejeitou/a rede caiu" (defeito real) eram
 * indistinguíveis de fora — nenhum dos dois deixava rastro nenhum. Achado
 * ao vivo em 09/09/2026: `META_CAPI_ACCESS_TOKEN` nunca foi setado em
 * nenhum dos 3 workers, e nada no projeto observava isso.
 *
 * Pure — decide SÓ o formato do evento; quem loga (`console.log`/
 * `console.error`) é o call site, mesmo padrão dos `console.error(JSON
 * .stringify({event: ...}))` já usados em `workers/reativar/src/index.ts`
 * (ex: `reativar_kit_not_configured`). Nunca inclui e-mail nem qualquer
 * outro PII — só o nome do worker (`"poll"`/`"cursos"`/`"reativar"`,
 * baixo volume/baixo risco) e o desfecho.
 *
 * `not_configured` é log-level "informativo" (mesmo padrão que
 * `reativar_kit_not_configured` já usa incondicionalmente) — é o estado
 * ESPERADO até o secret ser setado nos 3 workers, não um erro; o alarme
 * periódico (`scripts/meta-capi-staleness-alarm.ts`) é quem decide se essa
 * ausência já passou de aceitável, não este log.
 */
export type MetaCapiLogEvent =
  | { event: "meta_capi_not_configured"; worker: string }
  | { event: "meta_capi_sent"; worker: string; status: number }
  | {
      event: "meta_capi_send_failed";
      worker: string;
      status: number;
      reason: "meta_error" | "network_error";
    };

/** @pure */
export function buildMetaCapiLogEvent(result: MetaCapiSendResult, worker: string): MetaCapiLogEvent {
  if (result.ok) return { event: "meta_capi_sent", worker, status: result.status };
  if (result.reason === "not_configured") return { event: "meta_capi_not_configured", worker };
  return { event: "meta_capi_send_failed", worker, status: result.status, reason: result.reason };
}

/**
 * Encaixa o log estruturado NO CAMINHO fire-and-forget existente — `.then`
 * sobre a promise de `sendCompleteRegistrationEvent` preserva o tipo
 * (`Promise<MetaCapiSendResult>`) e o valor resolvido, então
 * `ctx.waitUntil(logMetaCapiSendResult(sendEvent, worker))` e o fallback
 * síncrono `await logMetaCapiSendResult(sendEvent, worker)` continuam
 * funcionando exatamente como antes desta função existir — só ganham o log
 * como efeito colateral no meio do caminho. `console.error` pra
 * `send_failed` (mesmo nível dos outros `_failed`/`_fetch_failed` deste
 * repo), `console.log` pros demais.
 */
export function logMetaCapiSendResult(
  sendEvent: Promise<MetaCapiSendResult>,
  worker: string,
): Promise<MetaCapiSendResult> {
  return sendEvent.then((result) => {
    const logEvent = buildMetaCapiLogEvent(result, worker);
    if (logEvent.event === "meta_capi_send_failed") {
      console.error(JSON.stringify(logEvent));
    } else {
      console.log(JSON.stringify(logEvent));
    }
    return result;
  });
}
