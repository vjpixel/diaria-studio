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
 * (`/confirmada`, renomeado de `/confirmado` em #8554) fica fora de escopo,
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
 * (ver `MetaCapiLogEvent`), nada disso é persistido por este módulo (o
 * cadastro grava IP/UA/fbp no Kit desde o #8543, mas quem grava é o worker,
 * sob a minimização de `selectPersistableMatchSignals`), e os
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

// #8978: `external_id` first-party (`_dia_vid`) — módulo dedicado porque o
// valor também é consumido no BROWSER (dataLayer/fbq advanced matching, ver
// `visitor-id.ts`), não só aqui. Import direto (mesmo padrão de
// `kit-signup-origin.ts`/`client-utm-allowlist.ts` — zero `node:*` nos dois
// lados, seguro pro bundle do Worker).
import { resolveVisitorId } from "./visitor-id.ts";

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

/** #8543 — nome do evento custom da CONFIRMAÇÃO do e-mail. Distinto de
 * `CompleteRegistration` de propósito: o cadastro é o evento que hoje otimiza o
 * conjunto "BR · conversao · sem teto"; a confirmação entra como sinal
 * SECUNDÁRIO, sem participar da otimização até a decisão da fase 3 da #8543. */
export const META_CAPI_CONFIRMATION_EVENT_NAME = "SubscriptionConfirmed";

/**
 * #8543 — `event_id` determinístico da CONFIRMAÇÃO de um assinante do Kit.
 * Derivado do id do Kit (não do e-mail nem do dia): uma confirmação por
 * assinante, mesmo id em qualquer reenvio, e nunca colide com o id do cadastro
 * (prefixo próprio). Sem PII na entrada.
 */
export async function computeConfirmationEventId(kitSubscriberId: number): Promise<string> {
  return sha256Hex(`capi:subscriptionconfirmed:kit:${kitSubscriberId}`);
}

/**
 * #8572 — o par (`event_id`, `event_time`) que os DOIS lados da dedup
 * precisam compartilhar.
 *
 * O `event_id` determinístico existe desde o #5504 justamente pra permitir
 * que um pixel client-side dedupasse contra a CAPI (ver docstring do
 * módulo), mas o lado do browser nunca recebeu o id: `pushSignupConversionEventJs`
 * empurrava só o e-mail pro `dataLayer`, e a tag do Meta no GTM não tinha
 * de onde ler um. Medido em 20/09/2026: a Meta contava 2,4x os cadastros
 * reais, com as duas séries (`WEB_ONLY` e `SERVER_ONLY`) somando no
 * dataset — sem chave compartilhada, não existe dedup.
 *
 * Calcular o hash NO BROWSER (SHA-256 via `crypto.subtle`, mesma fórmula)
 * foi descartado: duplicaria a fórmula em dois lugares e uma divergência
 * silenciosa entre elas quebraria a dedup de novo, sem sinal nenhum. Em vez
 * disso o handler do cadastro — que já vai disparar a CAPI — resolve o par
 * AQUI, devolve `eventId` no corpo da resposta e o browser só repassa.
 *
 * **Invariante que este tipo existe pra proteger:** quem consome `eventId`
 * PRECISA repassar `eventTimeSeconds` a `sendCompleteRegistrationEvent`. O
 * id é derivado do DIA UTC do `event_time`; deixar o builder calcular o
 * seu próprio `Date.now()` faz os dois lados divergirem na virada do dia
 * UTC (21:00 BRT) — a janela em que a dedup silenciosamente pararia de
 * funcionar todo dia.
 */
export interface CompleteRegistrationDedup {
  /** Vai pro `eventID` do `fbq` no browser, via `dataLayer`. */
  eventId: string;
  /** PRECISA ser repassado a `sendCompleteRegistrationEvent` — ver acima. */
  eventTimeSeconds: number;
}

/**
 * Resolve o par dedup de um cadastro. Default de `eventTimeSeconds`: agora,
 * idêntico ao default de `buildCompleteRegistrationEvent` — mas o ponto é
 * justamente FIXAR o valor uma vez e passá-lo adiante, nunca deixar os dois
 * lados chamarem `Date.now()` por conta própria.
 *
 * @pure exceto pelo hash assíncrono (Web Crypto).
 */
export async function resolveCompleteRegistrationDedup(
  email: string,
  eventTimeSeconds: number = Math.floor(Date.now() / 1000),
): Promise<CompleteRegistrationDedup> {
  return { eventId: await computeCompleteRegistrationEventId(email, eventTimeSeconds), eventTimeSeconds };
}

/** TTL do claim de envio — cobre um dia UTC inteiro (o `event_id` já muda na virada). */
export const META_CAPI_SEND_CLAIM_TTL_SEC = 24 * 60 * 60;

/**
 * #8577 — reivindica o ENVIO server-side de um cadastro, uma vez por
 * `event_id` (e-mail normalizado + dia UTC). A CAPI mandava ~2,3 eventos por
 * cadastro real (resubmissão do form e reentrada por outro host devolvem `ok`
 * pra quem já existe); só o `event_id` determinístico fazia a Meta absorver
 * os extras, e ele falha na virada do dia UTC. Com o claim, o reenvio nem sai.
 *
 * Retorna `true` quando ESTE chamador deve enviar. A chave usa o `event_id`
 * (hash), nunca o e-mail. **Fail-open**: KV ausente ou com erro devolve `true`
 * — perder a otimização é aceitável, perder um evento de conversão não é.
 * Get-then-put não é atômico; uma corrida simultânea ainda deixa passar 2
 * envios, que a dedup por `event_id` da Meta absorve como antes.
 */
export interface MetaCapiClaimKv {
  get(key: string): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export async function claimCompleteRegistrationSend(
  kv: MetaCapiClaimKv | undefined,
  eventId: string | undefined,
): Promise<boolean> {
  if (!kv || !eventId) return true;
  const key = `capi:cr:${eventId}`;
  try {
    if (await kv.get(key)) return false;
    await kv.put(key, "1", { expirationTtl: META_CAPI_SEND_CLAIM_TTL_SEC });
    return true;
  } catch {
    return true;
  }
}

/**
 * #8577: se o envio NÃO chegou à Meta, devolve o claim — senão o reenvio do
 * cadastro (que antes recuperava a conversão) ficaria bloqueado por 24h.
 * Nunca lança.
 */
export function releaseClaimOnSendFailure(
  send: Promise<MetaCapiSendResult>,
  kv: MetaCapiClaimKv | undefined,
  eventId: string | undefined,
): Promise<MetaCapiSendResult> {
  return send.then(async (result) => {
    if (!result.ok && kv && eventId) await kv.delete(`capi:cr:${eventId}`).catch(() => {});
    return result;
  });
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
 * `test/meta-capi-8388.test.ts` lê o snippet `fbq(...)` da PROPOSTA de
 * import do container GTM (`docs/gtm-signup-container-import-proposal.json`)
 * pra travar a igualdade — o pixel não é código executado por este repo, mas
 * o valor dele é versionado aqui e portanto auditável. **Isto audita a
 * proposta versionada, não o container ao vivo no GTM** — o container
 * publicado (`GTM-TC8C65ZN`) usa o template oficial do Meta Pixel
 * (`__cvt_5RM3Q`), não a tag Custom HTML deste arquivo; os campos podem
 * divergir (#8578).
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
 * **Cobertura dos call sites:** `workers/poll` e `workers/cursos` mandam
 * estes sinais no cadastro e, desde o #8543, gravam IP/UA/fbp no Kit
 * (`selectPersistableMatchSignals`) pro lote `SubscriptionConfirmed`
 * (`meta-capi-confirmation-batch.ts`) reusar. `workers/reativar` manda desde
 * o #8543 (`handleConfirm` recebe os headers do clique). O batch de cadastro
 * da Beehiiv (`meta-capi-batch-send.ts`, `system_generated`) reprocessa um
 * snapshot e segue sem request nenhum.
 */
export interface MetaCapiClientSignals {
  /** IP do visitante — `CF-Connecting-IP` (ou 1ª entrada de
   * `X-Forwarded-For`) no Worker. */
  clientIpAddress?: string;
  /** `user-agent` cru do request do cadastro. */
  clientUserAgent?: string;
  /** Cookie first-party `_fbp` do pixel em `diar.ia.br`. */
  fbp?: string;
  /** Cookie `_fbc` (gravado em `.diar.ia.br` por `metaFbcBootstrapJs`, ou
   * pelo pixel da Meta), derivado do `fbclid` capturado no cadastro (#8003,
   * `click_id` prefixado — `buildFbcFromClickId`), ou derivado do `fbclid`
   * no header `Referer` do request (#8978, `buildFbcFromReferer`) — nessa
   * ordem de precedência. */
  fbc?: string;
  /** #8978: ID first-party anônimo e estável (`_dia_vid`, ver
   * `visitor-id.ts`) — mandado em CLARO (raw, sem hash; ver rationale no
   * módulo). Único dos 5 sinais que também é mandado pelo PIXEL (advanced
   * matching / dataLayer), pra Meta deduplicar/casar os dois lados pela
   * MESMA pessoa mesmo sem e-mail em comum ainda confirmado. Sempre chega
   * aqui JÁ VALIDADO — só `resolveVisitorId`/`parseVisitorId` (branded
   * `VisitorId`, #8978 fleet review item 5) produzem o valor; o tipo do
   * campo em si segue `string` pra não propagar o brand por todo caller
   * que hoje monta `clientSignals` a partir de uma string já confiável
   * (ex.: `runMetaConfirmationBatch`, que relê do custom field do Kit). */
  externalId?: string;
}

/** Forma canônica dos cookies `_fbp`/`_fbc` da Meta:
 * `fb.{subdomainIndex}.{creationTimeMs}.{payload}`. Valor que não casa é
 * DESCARTADO em vez de repassado — são cookies lidos do request do cliente
 * (controláveis por quem manda o request), e mandar lixo pra Meta degrada o
 * match em vez de melhorar. #8978 (fleet review item 5): o payload usava
 * `.+` (aceita QUALQUER char, inclusive os que `FBCLID_RE` abaixo rejeita
 * pro campo cru) — tighten pro MESMO charset de `FBCLID_RE`, já que o
 * payload de um `_fbc` real É sempre um `fbclid`. */
export const FB_COOKIE_RE = /^fb\.\d+\.\d+\.[A-Za-z0-9_.-]+$/;

/** Caracteres aceitos num `fbclid` — mesma defesa em profundidade que o
 * `SUBSCRIBE_CLIENT_ORIGIN_MAX` dos workers aplica ao mesmo campo: o valor
 * vem do cliente. Exportada (#8978) pra `meta-fbc-bootstrap.ts` validar o
 * MESMO charset do lado do browser antes de gravar `_fbc` — sem import
 * circular (este módulo não importa `meta-fbc-bootstrap.ts`). */
export const FBCLID_RE = /^[A-Za-z0-9_.-]+$/;

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

/**
 * #10230: inverso de `buildFbcFromClickId`. Deriva o `click_id` do cadastro
 * (`fbclid:XXXX`) a partir de um `_fbc` canônico (`fb.1.{ts}.{fbclid}`),
 * pra quem chegou por anúncio da Meta e assina numa página SEM `fbclid` na
 * URL — o `_fbc` do cookie sobrevive à navegação, o `click_id` do form não.
 * Sem isso o `SubscriptionConfirmed` (que só lê `origem_click_id`) sai sem
 * fbc. Devolve `undefined` pra valor ausente/fora da forma canônica.
 * @pure
 */
export function deriveClickIdFromFbc(fbc: string | undefined | null): string | undefined {
  const raw = (fbc ?? "").trim();
  if (!FB_COOKIE_RE.test(raw)) return undefined;
  const fbclid = raw.split(".").slice(3).join(".");
  if (!fbclid || !FBCLID_RE.test(fbclid)) return undefined;
  return `${META_CLICK_ID_PREFIX}${fbclid}`;
}

/**
 * #8978: fallback de fbc a partir de um `fbclid` presente na QUERYSTRING do
 * header `Referer` do request.
 *
 * **Correção (fleet review pós-merge, #8983): NÃO cobre o caso cross-origin
 * que motivou a função.** O cadastro em `livros`/`arquivo`/`hub`/`diar.ia.br`
 * POSTa pra `eia.diar.ia.br` (outro host) — nesse POST cross-origin o
 * browser aplica `Referrer-Policy: strict-origin-when-cross-origin` por
 * padrão, que CORTA path e querystring do `Referer` enviado (o header chega
 * só com a origem, `https://diar.ia.br/`, nunca `?fbclid=...`). Esta função
 * portanto NUNCA encontra um `fbclid` nesse caminho — ela só ajuda em POST
 * SAME-origin (raro neste projeto) ou quando algo no meio (proxy, versão
 * antiga de browser) preserva o Referer completo. A cobertura real do caso
 * cross-origin é o `fbcBody` de `ExtractMetaCapiClientSignalsOptions`: o
 * cliente lê `_fbc` do PRÓPRIO `document.cookie` (a página que roda o form
 * está em `.diar.ia.br`, onde `metaFbcBootstrapJs` grava o cookie) e manda
 * no CORPO do POST — inofensivo manter esta função como fallback adicional
 * (nunca atrapalha, é só mais uma tentativa antes de desistir), mas ela não
 * é mais a peça que fecha o gap cross-origin.
 *
 * `Referer` malformado ou sem `fbclid` → `undefined`, nunca lança. @pure
 */
export function buildFbcFromReferer(
  referer: string | null | undefined,
  creationTimeMs: number,
): string | undefined {
  if (!referer) return undefined;
  let fbclid: string | null;
  try {
    fbclid = new URL(referer).searchParams.get("fbclid");
  } catch {
    return undefined;
  }
  if (!fbclid || !FBCLID_RE.test(fbclid)) return undefined;
  return `fb.1.${Math.floor(creationTimeMs)}.${fbclid}`;
}

/** Subconjunto de `Headers` que `extractMetaCapiClientSignals` consome —
 * evita exigir um `Request` inteiro em teste. */
export interface MetaCapiHeaderSource {
  get(name: string): string | null;
}

export interface ExtractMetaCapiClientSignalsOptions {
  /** `click_id` do cadastro (#8003) — só usado quando não há cookie `_fbc`
   * nem `fbcBody`. */
  clickId?: string;
  /** Epoch em MILISSEGUNDOS pro `fbc` derivado. Default: agora. */
  fbcCreationTimeMs?: number;
  /** #8978 (fleet review pós-merge, #8983): `_fbc` lido pelo CLIENTE do
   * próprio `document.cookie` e mandado no corpo do POST de cadastro — a
   * cobertura real do caso cross-origin (`buildFbcFromReferer` não serve
   * pra isso, ver docstring dela: `Referrer-Policy` corta a querystring do
   * `Referer` em POST cross-origin). Validado contra `FB_COOKIE_RE` igual
   * ao cookie — nunca repassado cru. Precedência: cookie `_fbc` do request
   * (quando existir) > este campo > `click_id` > `Referer`. */
  fbcBody?: string;
  /** #8978: mesmo caso do `fbcBody` acima, pro `_fbp` — o cookie do pixel é
   * lido pelo cliente e mandado no corpo, mesma razão (POST cross-origin
   * nunca carrega o header `Cookie` do host de destino). Validado contra
   * `FB_COOKIE_RE`. Precedência: cookie `_fbp` do request > este campo. */
  fbpBody?: string;
  /** #8978: `_dia_vid` lido pelo cliente (`window.__DIA_VID__`) e mandado no
   * corpo — mesmo motivo dos 2 acima. Validado por `resolveVisitorId`
   * (nunca repassado cru). Precedência: cookie `_dia_vid` do request > este
   * campo. */
  externalIdBody?: string;
}

/**
 * Extrai os 5 sinais de match quality dos headers/corpo do request de
 * cadastro. Pure exceto pelo `Date.now()` de fallback (injetável via
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
  const fbpCookie = readCookieValue(cookieHeader, "_fbp");
  // #8978 (fleet review): POST cross-origin (o caso real de produção — ver
  // docstring de `fbpBody`) nunca carrega o header `Cookie` do host de
  // destino, então o cookie acima é `undefined` nesse caminho; `fbpBody` é
  // quem cobre.
  const fbp =
    fbpCookie && FB_COOKIE_RE.test(fbpCookie)
      ? fbpCookie
      : options.fbpBody && FB_COOKIE_RE.test(options.fbpBody)
        ? options.fbpBody
        : undefined;
  if (fbp) signals.fbp = fbp;

  // #8978 (fleet review pós-merge, #8983): ordem de precedência —
  // (1) cookie `_fbc` do PRÓPRIO request (só existe em POST same-origin);
  // (2) `fbcBody` — o cliente leu `_fbc` do seu `document.cookie` e mandou
  //     no corpo; é quem cobre o POST cross-origin de produção;
  // (3) derivado do `click_id` do form (#8003);
  // (4) derivado do `fbclid` cru no header `Referer` — na prática só ajuda
  //     em same-origin, ver docstring de `buildFbcFromReferer`.
  const fbcCookie = readCookieValue(cookieHeader, "_fbc");
  const fbcCreationTimeMs = options.fbcCreationTimeMs ?? Date.now();
  const fbcFromBody = options.fbcBody && FB_COOKIE_RE.test(options.fbcBody) ? options.fbcBody : undefined;
  const fbc =
    (fbcCookie && FB_COOKIE_RE.test(fbcCookie) ? fbcCookie : undefined) ??
    fbcFromBody ??
    buildFbcFromClickId(options.clickId, fbcCreationTimeMs) ??
    buildFbcFromReferer(headers.get("Referer") ?? headers.get("referer"), fbcCreationTimeMs);
  if (fbc) signals.fbc = fbc;

  // #8978: `_dia_vid` — ver docstring de `MetaCapiClientSignals.externalId`.
  // #8978 (fleet review): mesma precedência cookie > corpo dos 2 sinais
  // acima — `resolveVisitorId` já valida os dois caminhos, nunca repassa
  // valor cru (ver docstring em visitor-id.ts).
  const externalId = resolveVisitorId(cookieHeader, options.externalIdBody);
  if (externalId) signals.externalId = externalId;

  return signals;
}

// ---------------------------------------------------------------------------
// #8543 (28/09/2026, EMQ): sinais de match PERSISTIDOS no cadastro
// ---------------------------------------------------------------------------

/**
 * Sinais de match que o cadastro grava no ESP pra eventos SÓ-SERVIDOR
 * posteriores (`SubscriptionConfirmed`, lote horário sem request próprio).
 * Medição no Events Manager (28/09/2026): `SubscriptionConfirmed` em EMQ
 * 5.0/10 com só e-mail + fbc; a Meta estima +32% de EMQ cada pra IP e user
 * agent e +24% pra fbp. `external_id` já era persistido desde o #8978
 * (`origem_external_id`) — não entra aqui.
 *
 * Os 3 vão em CLARO pra Meta (mesmo contrato do `MetaCapiClientSignals`) e
 * são os mesmos que o pixel client-side já entregaria. A diferença em
 * relação ao envio síncrono do cadastro é que AQUI eles são guardados num
 * custom field do Kit — por isso a minimização de `selectPersistableMatchSignals`.
 */
export interface PersistedMatchSignals {
  clientIpAddress?: string;
  clientUserAgent?: string;
  fbp?: string;
}

/** Teto do user agent persistido — UA real fica bem abaixo disso; o corte é
 * defesa contra header abusivo virando custom field gigante. */
export const PERSISTED_USER_AGENT_MAX = 300;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/** `true` pra IPv4 canônico ou algo com a forma de IPv6 (hex + `:`, com
 * IPv4 embutido opcional). Não pretende validar IPv6 por completo — só barrar
 * lixo (header forjado, lista, porta) antes de persistir/enviar. @pure */
export function isPlausibleClientIp(ip: string | undefined | null): boolean {
  const v = (ip ?? "").trim();
  if (!v) return false;
  if (IPV4_RE.test(v)) return true;
  // IPv6 tem sempre >= 2 `:` (`::1`); isso já recusa `ip:porta` de IPv4.
  if (!IPV6_RE.test(v) || (v.match(/:/g) ?? []).length < 2) return false;
  const lastColon = v.lastIndexOf(":");
  const head = v.slice(0, lastColon);
  const tail = v.slice(lastColon + 1);
  if (head.includes(".")) return false;
  // IPv4 embutido (`::ffff:1.2.3.4`) só no último segmento.
  return tail.includes(".") ? IPV4_RE.test(tail) : /^[0-9A-Fa-f]{0,4}$/.test(tail);
}

/** Normaliza UA: trim, sem caracteres de controle, cortado no teto. Vazio = `undefined`. @pure */
export function normalizePersistedUserAgent(ua: string | undefined | null): string | undefined {
  // eslint-disable-next-line no-control-regex
  const v = (ua ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PERSISTED_USER_AGENT_MAX).trim();
  return v || undefined;
}

/**
 * Valida/normaliza os 3 sinais (IP, UA, fbp). Usado nos DOIS lados: antes de
 * gravar no Kit (cadastro) e de novo ao reler do Kit (lote) — custom field é
 * editável à mão no painel, mesma defesa em profundidade do `external_id`
 * (`isValidVisitorId`). Campo inválido é OMITIDO, nunca repassado cru. @pure
 */
export function sanitizePersistedMatchSignals(raw: {
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
}): PersistedMatchSignals {
  const out: PersistedMatchSignals = {};
  const ip = (raw.clientIpAddress ?? "").trim();
  if (isPlausibleClientIp(ip)) out.clientIpAddress = ip;
  const ua = normalizePersistedUserAgent(raw.clientUserAgent);
  if (ua) out.clientUserAgent = ua;
  const fbp = (raw.fbp ?? "").trim();
  if (fbp && fbp.length <= 300 && FB_COOKIE_RE.test(fbp)) out.fbp = fbp;
  return out;
}

/** #10393 item 2: quais dos 3 sinais VIERAM (valor não-vazio) e foram
 * DESCARTADOS pela sanitização. `false` tanto pra "nunca veio" quanto pra
 * "veio e passou" — é o que separa as três situações no resumo do lote. */
export interface MatchSignalRejections {
  clientIpAddress: boolean;
  clientUserAgent: boolean;
  fbp: boolean;
}

/**
 * #10393 item 2: mesma régua de `sanitizePersistedMatchSignals`, mas devolve
 * quais campos tinham valor e foram rejeitados (IPv6 com zone id, UA só de
 * caractere de controle, fbp fora do regex...). Sem isso o lote não
 * distinguia "o cadastro não gravou" de "gravou lixo / foi editado à mão". @pure
 */
export function matchSignalRejections(raw: {
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
}): MatchSignalRejections {
  const kept = sanitizePersistedMatchSignals(raw);
  const came = (v: string | null | undefined): boolean => (v ?? "").trim() !== "";
  return {
    clientIpAddress: came(raw.clientIpAddress) && !kept.clientIpAddress,
    clientUserAgent: came(raw.clientUserAgent) && !kept.clientUserAgent,
    fbp: came(raw.fbp) && !kept.fbp,
  };
}

/**
 * Minimização (#8543): decide QUAIS sinais do request de cadastro podem ir
 * pro ESP. Regras, nesta ordem:
 *
 * 1. Click id de OUTRO canal (`gclid:`/`msclkid:`) → nada. O único consumidor
 *    destes campos é o lote da Meta, que já pula esse cadastro
 *    (`skipped-other-channel`) — guardar IP/UA dele seria dado sem uso.
 * 2. Sem NENHUM sinal da Meta no request (`_fbp`, `_fbc` válidos, ou click id
 *    `fbclid:`) → nada. Ausência de cookie da Meta é o sinal de que o pixel
 *    não rodou nesse navegador (bloqueador, sem consentimento); o lote
 *    continua mandando só o hash do e-mail, como antes.
 * 3. Caso contrário → IP, UA e fbp já sanitizados (`sanitizePersistedMatchSignals`).
 *
 * @pure
 */
export function selectPersistableMatchSignals(
  signals: MetaCapiClientSignals,
  clickId: string | undefined,
): PersistedMatchSignals {
  const cid = (clickId ?? "").trim().toLowerCase();
  if (cid && !cid.startsWith(META_CLICK_ID_PREFIX)) return {};
  const hasMetaSignal = Boolean(signals.fbp || signals.fbc || cid.startsWith(META_CLICK_ID_PREFIX));
  if (!hasMetaSignal) return {};
  return sanitizePersistedMatchSignals({
    clientIpAddress: signals.clientIpAddress,
    clientUserAgent: signals.clientUserAgent,
    fbp: signals.fbp,
  });
}

/** Nomes dos custom fields do ESP onde gravar os sinais — vêm das env vars
 * `KIT_ORIGEM_CLIENTIP_FIELD`/`KIT_ORIGEM_USERAGENT_FIELD`/`KIT_ORIGEM_FBP_FIELD`
 * dos workers. Nome ausente = aquele sinal não é gravado. */
export interface MatchSignalFieldNames {
  KIT_ORIGEM_CLIENTIP_FIELD?: string;
  KIT_ORIGEM_USERAGENT_FIELD?: string;
  KIT_ORIGEM_FBP_FIELD?: string;
}

/** #10393 item 2: estado module-level (vive enquanto o ISOLATE do Worker
 * viver) — um aviso por var ausente, não um por cadastro. Mesmo racional de
 * `warnExternalIdFieldMissingOnce` (`visitor-id.ts`). */
const matchSignalFieldMissingWarned = new Set<string>();

/** Só pra testes: zera o "já avisei" do isolate. */
export function resetMatchSignalFieldWarningsForTest(): void {
  matchSignalFieldMissingWarned.clear();
}

function warnMatchSignalFieldMissingOnce(worker: string, hint: keyof MatchSignalFieldNames): void {
  if (matchSignalFieldMissingWarned.has(hint)) return;
  matchSignalFieldMissingWarned.add(hint);
  // `console.warn`: config pendente, não falha do worker. Nunca o VALOR do sinal.
  console.warn(JSON.stringify({ event: "match_signal_field_missing", worker, hint }));
}

/**
 * #8543: escreve os sinais (já minimizados por `selectPersistableMatchSignals`)
 * no mapa `fields` do POST de criação do Kit. Guard duplo, mesmo padrão dos
 * `KIT_ORIGEM_*`: env configurada E valor presente. Compartilhada pelos
 * workers `poll` e `cursos` (sem import cross-worker). Muta `fields`.
 *
 * #10393 item 2: sinal presente com a var ausente avisa UMA vez por isolate
 * (`match_signal_field_missing`) — antes, desligar a coleta num worker só
 * derrubava o EMQ, sem sinal nenhum. Devolve os nomes de campo gravados (o
 * retry sem os opcionais, item 3, precisa saber quais tirar).
 */
export function applyMatchSignalFields(
  fields: Record<string, string>,
  names: MatchSignalFieldNames,
  signals: PersistedMatchSignals | undefined,
  worker = "unknown",
): string[] {
  if (!signals) return [];
  const written: string[] = [];
  const pairs: Array<[keyof MatchSignalFieldNames, string | undefined]> = [
    ["KIT_ORIGEM_CLIENTIP_FIELD", signals.clientIpAddress],
    ["KIT_ORIGEM_USERAGENT_FIELD", signals.clientUserAgent],
    ["KIT_ORIGEM_FBP_FIELD", signals.fbp],
  ];
  for (const [envName, value] of pairs) {
    if (!value) continue;
    const fieldName = names[envName];
    if (fieldName) {
      fields[fieldName] = value;
      written.push(fieldName);
    } else {
      warnMatchSignalFieldMissingOnce(worker, envName);
    }
  }
  return written;
}

/**
 * #10393 item 3: troca cada ocorrência dos valores dados (IP, UA, fbp,
 * e-mail) por `[redacted]` — o corpo de erro do Kit pode ecoar o payload e
 * vai pro log do Worker. Valores vazios/curtos (< 3) são ignorados pra não
 * picotar o texto. Comparação case-insensitive (#10416). @pure
 */
export function redactLogValues(text: string, values: ReadonlyArray<string | undefined>): string {
  let out = text;
  const uniq = [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length >= 3))];
  // Mais longo primeiro: um valor contido em outro (IP dentro do UA) não deixa sobra.
  uniq.sort((a, b) => b.length - a.length);
  for (const v of uniq) {
    // #10416: case-insensitive — o caller nem sempre normaliza (cursos só faz
    // `trim()` no e-mail) e o Kit ecoa em minúsculas: e-mail cadastrado com
    // maiúsculas e ecoado em minúsculas no corpo passava em claro.
    out = out.replace(new RegExp(escapeRegExp(v), "gi"), "[redacted]");
    // JSON escapa `/` e `"` — o eco do Kit pode vir na forma escapada.
    const jsonForm = JSON.stringify(v).slice(1, -1);
    if (jsonForm !== v) out = out.replace(new RegExp(escapeRegExp(jsonForm), "gi"), "[redacted]");
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #10393 item 3: os sinais de match vão no MESMO `POST /v4/subscribers` que
 * cria o assinante. Se o Kit recusar com 422 e houver campo de sinal no
 * corpo, tenta UMA vez de novo sem eles — o cadastro nunca pode falhar por
 * causa de um campo opcional. Não dá pra saber se o 422 foi MESMO por eles;
 * o retry é seguro de qualquer jeito (se falhar de novo, a causa é outra e o
 * caller loga a 2ª resposta). Exceção do `post` propaga pro caller (que já
 * trata rede/timeout). Nunca loga valor de sinal nem e-mail.
 */
export async function postKitCreateWithSignalFallback(opts: {
  post: (body: Record<string, unknown>) => Promise<Response>;
  body: Record<string, unknown>;
  signalFieldNames: readonly string[];
  redactValues: ReadonlyArray<string | undefined>;
  log: (msg: string) => void;
}): Promise<Response> {
  const first = await opts.post(opts.body);
  if (first.status !== 422 || opts.signalFieldNames.length === 0) return first;
  const fields = opts.body.fields as Record<string, string> | undefined;
  if (!fields || !opts.signalFieldNames.some((k) => k in fields)) return first;

  const firstText = await first.text().catch(() => "<unreadable>");
  opts.log(
    JSON.stringify({
      event: "kit_create_422_retry_without_match_signals",
      dropped: opts.signalFieldNames,
      body: redactLogValues(firstText, opts.redactValues).slice(0, 300),
    }),
  );
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (!opts.signalFieldNames.includes(k)) rest[k] = v;
  const retryBody: Record<string, unknown> = { ...opts.body };
  if (Object.keys(rest).length > 0) retryBody.fields = rest;
  else delete retryBody.fields;
  return opts.post(retryBody);
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
  /** #8978: RAW (sem hash) — ver rationale em `visitor-id.ts`. Array de 1
   * elemento pela mesma convenção de `em` (a Meta aceita `external_id` como
   * string OU lista; usamos lista por simetria/auditabilidade com `em`). */
  external_id?: [string];
}

/**
 * #8551: `event_name` deixou de ser fixo em `"CompleteRegistration"`.
 *
 * `"Reactivation"` é o evento (customizado, não-padrão da Meta) que
 * `workers/reativar/src/index.ts` passa a disparar no clique de
 * confirmação — distinto de propósito de `"CompleteRegistration"`, que
 * continua sendo o evento de OTIMIZAÇÃO do conjunto de anúncios "BR ·
 * conversao · sem teto" e é disparado só no SUBMIT do form de cadastro
 * (`workers/poll`, `workers/cursos`). Misturar os dois sob o mesmo nome
 * fazia o conjunto aprender de reativações — que chegam meses depois do
 * cadastro original, muitas vezes sem `fbc`/click id válido — como se
 * fossem cadastros novos vindos de anúncio.
 */
export type MetaCapiEventName = "CompleteRegistration" | "Reactivation" | "SubscriptionConfirmed";

/**
 * #8543/#8616 item 4: o lote de confirmações aceita o nome por PARÂMETRO
 * (`--event-name`, validado em runtime por `assertConfirmationEventName` em
 * `scripts/lib/meta-capi-confirmation-batch.ts`, nunca "CompleteRegistration").
 * Widen isolado só pro campo que precisa disso (`BuildCompleteRegistrationEventInput.eventName`)
 * — `MetaCapiEventName` em si permanece união FECHADA, então os 3 workers que
 * passam o nome como literal (`workers/reativar`, `scripts/gtm-drift-check.ts`)
 * continuam com o checador de tipo pegando um typo de nome.
 */
export type MetaCapiConfirmationEventName = MetaCapiEventName | (string & {});

export interface MetaCapiCompleteRegistrationEvent {
  event_name: MetaCapiConfirmationEventName;
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
  /** #8551: `"CompleteRegistration"` (default — cadastro/submit do form) ou
   * `"Reactivation"` (`workers/reativar`, confirmação de reativação — nunca
   * deve entrar no evento de otimização do conjunto de anúncios). #8543/#8616
   * item 4: também aceita o nome parametrizável, validado em runtime, do
   * lote de confirmações (`MetaCapiConfirmationEventName`). */
  eventName?: MetaCapiConfirmationEventName;
  /** #8543: `event_id` explícito — usado por eventos que NÃO são o cadastro
   * (ex.: `SubscriptionConfirmed`, id derivado do id do Kit, não do e-mail+dia).
   * Ausente = o id determinístico do `CompleteRegistration`, como sempre. */
  eventId?: string;
}

/**
 * #10413: reduz `event_source_url` a `origin + pathname` — sem query string
 * nem fragmento. A URL de confirmação do `reativar` carrega
 * `?email=<e-mail em claro>&t=<token>`, e repassá-la crua mandava à Meta o
 * e-mail (contrariando o invariante do módulo: só o hash sai daqui) e o
 * token de confirmação. Sanitizar AQUI, nos dois builders, cobre todo
 * chamador presente e futuro (poll/cursos usam `request.url`, o site usa o
 * `Referer`) em vez de depender de cada um lembrar.
 *
 * Perde UTM/fbclid da query — aceito: o click id já viaja em `fbc`
 * (`clientSignals`), e a Meta só precisa da página pra `action_source:
 * "website"`. URL que não parseia é cortada no primeiro `?`/`#` — nunca
 * devolvida crua. @pure, nunca lança.
 */
export function sanitizeEventSourceUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
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
    input.eventId ? Promise.resolve(input.eventId) : computeCompleteRegistrationEventId(input.email, eventTime),
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
  if (signals?.externalId) userData.external_id = [signals.externalId];
  return {
    event_name: input.eventName ?? "CompleteRegistration",
    event_time: eventTime,
    event_source_url: sanitizeEventSourceUrl(input.eventSourceUrl),
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

/**
 * #8982: forma MÍNIMA de um evento CAPI — `MetaCapiCompleteRegistrationEvent`
 * é estruturalmente compatível (todo campo dela satisfaz este shape), então
 * `sendMetaCapiEvent` aceita os dois sem overload. Existe pra eventos que
 * NÃO têm e-mail (ex.: `CliqueIngresso_{A|B}` do beacon de
 * `evento/agente-ia`, ver `buildMetaCapiCustomEvent`) — `em` deixa de ser
 * obrigatório porque não há cadastro nenhum associado ao clique.
 */
export interface MetaCapiGenericEvent {
  event_name: string;
  event_time: number;
  event_source_url: string;
  action_source: MetaCapiActionSource;
  event_id: string;
  user_data: Partial<MetaCapiUserData>;
  custom_data?: Record<string, unknown>;
}

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
  event: MetaCapiGenericEvent,
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
 * #8982: input de um evento CUSTOM genérico — sem e-mail, sem
 * `custom_data.value/currency` fixo (ao contrário de `CompleteRegistration`).
 * Nasceu do beacon de `CliqueIngresso_{A|B}` (`evento/agente-ia`), mas
 * qualquer evento custom futuro sem cadastro associado pode reusar.
 */
export interface BuildMetaCapiCustomEventInput {
  /** Precisa casar BYTE A BYTE com o `event_name` que o pixel client-side já
   * mandou (`fbq('trackCustom', eventName, ...)`) — é essa igualdade que
   * habilita a dedup por (`event_name`, `event_id`). */
  eventName: string;
  /** Mesmo `eventID` passado ao `fbq(...)` client-side — ver acima. */
  eventId: string;
  eventSourceUrl: string;
  eventTimeSeconds?: number;
  actionSource?: MetaCapiActionSource;
  clientSignals?: MetaCapiClientSignals;
  customData?: Record<string, unknown>;
}

/** Pure — monta o evento genérico, nunca lança. */
export function buildMetaCapiCustomEvent(input: BuildMetaCapiCustomEventInput): MetaCapiGenericEvent {
  const userData: Partial<MetaCapiUserData> = {};
  const signals = input.clientSignals;
  if (signals?.clientIpAddress) userData.client_ip_address = signals.clientIpAddress;
  if (signals?.clientUserAgent) userData.client_user_agent = signals.clientUserAgent;
  if (signals?.fbp) userData.fbp = signals.fbp;
  if (signals?.fbc) userData.fbc = signals.fbc;
  if (signals?.externalId) userData.external_id = [signals.externalId];
  const event: MetaCapiGenericEvent = {
    event_name: input.eventName,
    event_time: input.eventTimeSeconds ?? Math.floor(Date.now() / 1000),
    event_source_url: sanitizeEventSourceUrl(input.eventSourceUrl),
    action_source: input.actionSource ?? "website",
    event_id: input.eventId,
    user_data: userData,
  };
  if (input.customData) event.custom_data = input.customData;
  return event;
}

/** Wrapper de conveniência — mesmo contrato fail-soft de
 * `sendCompleteRegistrationEvent`: sem `accessToken`, `not_configured` SEM
 * montar o evento; qualquer exceção inesperada vira `network_error`, nunca
 * propaga pro caller (o beacon nunca pode falhar visivelmente). */
export async function sendMetaCapiCustomEvent(
  input: BuildMetaCapiCustomEventInput,
  options: SendMetaCapiEventOptions,
): Promise<MetaCapiSendResult> {
  if (!options.accessToken) return { ok: false, status: 503, reason: "not_configured" };
  try {
    const event = buildMetaCapiCustomEvent(input);
    return await sendMetaCapiEvent(event, options);
  } catch {
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
  | { event: "meta_capi_not_configured"; worker: string; eventSourceUrl?: string }
  | { event: "meta_capi_sent"; worker: string; status: number; eventSourceUrl?: string }
  | {
      event: "meta_capi_send_failed";
      worker: string;
      status: number;
      reason: "meta_error" | "network_error";
      eventSourceUrl?: string;
    };

/** @pure */
export function buildMetaCapiLogEvent(
  result: MetaCapiSendResult,
  worker: string,
  rawEventSourceUrl?: string,
): MetaCapiLogEvent {
  // #10413: o log promete "nunca PII" — mesma sanitização do evento enviado.
  const eventSourceUrl = rawEventSourceUrl === undefined ? undefined : sanitizeEventSourceUrl(rawEventSourceUrl);
  if (result.ok) {
    const event = { event: "meta_capi_sent" as const, worker, status: result.status };
    return eventSourceUrl === undefined ? event : { ...event, eventSourceUrl };
  }
  if (result.reason === "not_configured") {
    const event = { event: "meta_capi_not_configured" as const, worker };
    return eventSourceUrl === undefined ? event : { ...event, eventSourceUrl };
  }
  const event = { event: "meta_capi_send_failed" as const, worker, status: result.status, reason: result.reason };
  return eventSourceUrl === undefined ? event : { ...event, eventSourceUrl };
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
  eventSourceUrl?: string,
): Promise<MetaCapiSendResult> {
  return sendEvent.then((result) => {
    const logEvent = buildMetaCapiLogEvent(result, worker, eventSourceUrl);
    if (logEvent.event === "meta_capi_send_failed") {
      console.error(JSON.stringify(logEvent));
    } else {
      console.log(JSON.stringify(logEvent));
    }
    return result;
  });
}
