/**
 * workers/cursos/src/subscribe.ts (#4052)
 *
 * `POST /gate/subscribe` — cadastro inline reusando o PADRÃO já validado de
 * `workers/poll/src/subscribe.ts` (#3580: honeypot + rate-limit + double
 * opt-in via API pública da Beehiiv). PORTADO (não importado direto) porque
 * `workers/poll/src/subscribe.ts` importa `Env`/`json` do `index.ts` do
 * worker `poll` (1000+ linhas, DOs, handlers não-relacionados) — importar
 * cross-worker acoplaria o bundle do `cursos` a todo esse grafo por causa de
 * 1 função. A lógica de negócio (validação, honeypot, payload Beehiiv) é
 * idêntica byte-a-byte ao padrão do #3580; só o transporte (`Env`, helpers de
 * CORS/JSON) é local a este worker. Rate-limit em si já foi extraído pra
 * `lib/shared/rate-limit.ts` (#4052) — reusado aqui de verdade, não portado.
 */
import type { Env } from "./index";
import { json } from "./index";
import { checkKvRateLimit } from "../../../scripts/lib/shared/rate-limit.ts";
import { CURSOS_GATE_INLINE_UTM } from "../../../scripts/lib/shared/utm-registry.ts"; // #4295 fold-in do drift (literais locais antes)
import { CURSOS_ALARM_COUNTER_KEYS, incrementKvCounter } from "../../../scripts/lib/shared/cursos-alarm-counters.ts";
import { sendCompleteRegistrationEvent, logMetaCapiSendResult } from "../../../scripts/lib/shared/meta-capi.ts"; // #5504, #7776
import { applyKitSignupOriginField } from "../../../scripts/lib/shared/kit-signup-origin.ts"; // #6048
import { isAllowedClientUtmSource } from "../../../scripts/lib/shared/client-utm-allowlist.ts"; // #7535 (Camada 1)
import { resolveKitCreateState, vincularKitDoiForm, extrairSubscriberId, mensagemSubscriberIdAusente } from "../../../scripts/lib/shared/kit-doi.ts"; // #7723
import { issueSessionCookie } from "./cookie.ts";

export const SUBSCRIBE_RATE_LIMIT = 5;
export const SUBSCRIBE_RATE_WINDOW_SEC = 3600; // 1h
export const SUBSCRIBE_NAME_MAX = 100;

// #3580: mesmo regex de forbidden chars / formato de e-mail que
// workers/poll/src/lib.ts `isValidVoteEmailFormat` — duplicado aqui (não
// importado) pelo mesmo motivo do header acima (evitar acoplamento
// cross-worker por 1 função pura pequena).
const FORBIDDEN_EMAIL_CHARS_RE = /[\p{Cf}\p{Cc}：]/u;
export function isValidEmailFormat(email: string): boolean {
  if (email.length === 0) return false;
  if (new TextEncoder().encode(email).length > 254) return false;
  if (FORBIDDEN_EMAIL_CHARS_RE.test(email)) return false;
  return /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email);
}

export interface ParsedSubscribe {
  name: string;
  email: string;
  optin: boolean;
  honeypot: string;
  /** #7535 (Camada 1): utm_source CRU do cliente — lido do querystring da
   * página do gate (`workers/cursos/src/gate-page.ts`), só tem efeito
   * quando casa `isAllowedClientUtmSource` (ver `resolveOrigemPaga`
   * abaixo). Vazio (não `undefined`) quando ausente do body. */
  utmSource: string;
  /** #8003: `document.referrer` cru do cliente — sinal SEPARADO do
   * `utmSource`/`origem_paga` acima, nunca varia por lógica de negócio.
   * Vazio quando ausente do body. */
  referrer: string;
  /** #8003: click ID de ads prefixado pelo provedor (`gclid:...`/`fbclid:...`/
   * `msclkid:...`) — vazio quando ausente do body. */
  clickId: string;
}

/** #8003: teto de tamanho de `referrer`/`click_id` crus do cliente — mesmo
 * racional/valor de `SUBSCRIBE_CLIENT_ORIGIN_MAX` do worker `poll` (defesa
 * em profundidade: o cliente já corta em 300 chars, ver
 * `clientOriginSignalPayloadFieldsJs`/inline JS de `gate-page.ts`, mas nunca
 * confiar só nisso). */
export const SUBSCRIBE_CLIENT_ORIGIN_MAX = 300;

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function truthyFlag(v: unknown): boolean {
  if (v === true) return true;
  const s = asStr(v).trim().toLowerCase();
  return s === "on" || s === "true" || s === "1" || s === "yes";
}

/** Pure — parse do corpo do POST (JSON ou form-urlencoded). Nunca lança. */
export function parseSubscribeBody(raw: string, contentType: string): ParsedSubscribe {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return {
        name: asStr(o.name),
        email: asStr(o.email),
        optin: truthyFlag(o.optin),
        honeypot: asStr(o.website),
        utmSource: asStr(o.utm_source),
        referrer: asStr(o.referrer),
        clickId: asStr(o.click_id),
      };
    } catch {
      return { name: "", email: "", optin: false, honeypot: "", utmSource: "", referrer: "", clickId: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return {
    name: params.get("name") ?? "",
    email: params.get("email") ?? "",
    optin: truthyFlag(params.get("optin")),
    honeypot: params.get("website") ?? "",
    utmSource: params.get("utm_source") ?? "",
    referrer: params.get("referrer") ?? "",
    clickId: params.get("click_id") ?? "",
  };
}

export type SubscribeValidation =
  | { ok: true; name: string; email: string }
  | { ok: false; status: number; error: string };

/** Pure — mesma ordem/semântica de `workers/poll/src/subscribe.ts` #3580:
 * honeypot → 200 fake-success silencioso; opt-in ausente → 400; e-mail
 * inválido → 400. */
export function validateSubscribeInput(p: ParsedSubscribe): SubscribeValidation {
  if (p.honeypot && p.honeypot.trim() !== "") return { ok: false, status: 200, error: "honeypot" };
  if (!p.optin) return { ok: false, status: 400, error: "optin_required" };
  const email = (p.email || "").trim();
  if (!isValidEmailFormat(email)) return { ok: false, status: 400, error: "invalid_email" };
  const name = (p.name || "").trim().slice(0, SUBSCRIBE_NAME_MAX);
  return { ok: true, name, email };
}

export function checkSubscribeRateLimit(kv: KVNamespace, ip: string) {
  return checkKvRateLimit(kv, `rl:cursos-subscribe:${ip}`, SUBSCRIBE_RATE_LIMIT, SUBSCRIBE_RATE_WINDOW_SEC);
}

export interface SubscribeResult {
  ok: boolean;
  status: number;
  reason?: "not_configured" | "beehiiv_error";
  /** #4323: `status` do corpo da resposta da Beehiiv (`data.status`), quando
   * presente/parseável. `"active"` = a Beehiiv já confirmou a assinatura
   * nesta mesma resposta (caso comum confirmado ao vivo no #4305) — o caller
   * pode emitir sessão CONFIRMADA sem fricção extra. Qualquer outro valor
   * (ou ausência do campo) significa que o double opt-in pode continuar
   * pendente — o caller deve emitir sessão `pending` (ver `cookie.ts`),
   * nunca confirmada, só por causa de um 2xx na criação. */
  beehiivStatus?: string;
}

// #4295: valores derivados do registry único (scripts/lib/shared/utm-registry.ts)
// — antes eram literais locais, ausentes de UTM_EMITTERS/`/utms` (drift).
/** #7723 (achado do review): o fetch de vinculo ao form DOI ficava SEM
 * timeout algum — a lib compartilhada so aplica `AbortSignal` quando recebe
 * `timeoutMs`. Mesmo valor/rationale de `SUBSCRIBE_FETCH_TIMEOUT_MS` do
 * worker `poll`: um POST de assinatura nao pode pendurar a resposta ao
 * usuario ate o teto de CPU do Worker. */
export const CURSOS_KIT_FETCH_TIMEOUT_MS = 8000;

const CURSOS_UTM_SOURCE = CURSOS_GATE_INLINE_UTM.source;
const CURSOS_UTM_MEDIUM = CURSOS_GATE_INLINE_UTM.medium;
const CURSOS_UTM_CAMPAIGN = CURSOS_GATE_INLINE_UTM.campaign;

/** Mesmo endpoint/contrato de `subscribeToBeehiiv` do #3580 — `fetchImpl`
 * injetável pra teste, nunca faz rede real em testes. */
async function subscribeToBeehiiv(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  origemPaga: string = "",
  origin: { referrer: string; clickId: string } = { referrer: "", clickId: "" },
): Promise<SubscribeResult> {
  const apiKey = env.BEEHIIV_API_KEY;
  const pubId = env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !pubId) return { ok: false, status: 503, reason: "not_configured" };

  const base = env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";
  const body: Record<string, unknown> = {
    email: input.email,
    reactivate_existing: false,
    send_welcome_email: true,
    // #5095: mesma isenção do gate do "É IA?" (`workers/poll/src/subscribe.ts`,
    // onde está o rationale completo). O double opt-in da publicação existe pra
    // barrar cadastro externo de origem duvidosa; aqui o visitante digitou o
    // e-mail e marcou a caixinha no NOSSO gate, então a 1ª camada de
    // consentimento já é auditável e a 2ª só adicionaria fricção.
    double_opt_override: "off",
    utm_source: CURSOS_UTM_SOURCE,
    utm_medium: CURSOS_UTM_MEDIUM,
    utm_campaign: CURSOS_UTM_CAMPAIGN,
    referring_site: "cursos-gate-inline",
  };
  if (input.name && env.BEEHIIV_NAME_FIELD) {
    body.custom_fields = [{ name: env.BEEHIIV_NAME_FIELD, value: input.name }];
  }
  // #7535 (Camada 1): canal pago do cliente, campo PRÓPRIO — nunca
  // sobrescreve o triplo fixo (CURSOS_UTM_SOURCE/MEDIUM/CAMPAIGN) acima.
  if (env.BEEHIIV_ORIGEM_PAGA_FIELD && origemPaga) {
    const field = { name: env.BEEHIIV_ORIGEM_PAGA_FIELD, value: origemPaga };
    body.custom_fields = Array.isArray(body.custom_fields) ? [...body.custom_fields, field] : [field];
  }
  // #8003: mesmo guard duplo (env configurado E valor presente) — referrer/
  // click_id são campos PRÓPRIOS, puramente informativos, nunca sobrescrevem
  // o triplo fixo/origem_paga acima.
  if (env.BEEHIIV_ORIGEM_REFERRER_FIELD && origin.referrer) {
    const field = { name: env.BEEHIIV_ORIGEM_REFERRER_FIELD, value: origin.referrer };
    body.custom_fields = Array.isArray(body.custom_fields) ? [...body.custom_fields, field] : [field];
  }
  if (env.BEEHIIV_ORIGEM_CLICKID_FIELD && origin.clickId) {
    const field = { name: env.BEEHIIV_ORIGEM_CLICKID_FIELD, value: origin.clickId };
    body.custom_fields = Array.isArray(body.custom_fields) ? [...body.custom_fields, field] : [field];
  }

  let res: Response;
  try {
    res = await fetchImpl(`${base}/publications/${pubId}/subscriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // #4305: o catch nu engolia a causa — o handler acima só via
    // `beehiiv_error` e não dava pra distinguir rede caída de payload
    // rejeitado. A exceção morre aqui de propósito (o cadastro não pode
    // derrubar o request), mas não sem deixar o motivo.
    console.error("[cursos] fetch pra Beehiiv lançou:", err);
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (res.ok) {
    // #4323: lê o `status` do corpo pra decidir sessão pending × confirmada —
    // `subscribeToBeehiiv` antes só confirmava o 2xx da CRIAÇÃO, nunca este
    // campo. Corpo malformado/sem o campo vira `beehiivStatus: undefined`
    // (nunca lança) — o caller trata isso como "não confirmado", não como
    // erro de rede.
    let beehiivStatus: string | undefined;
    try {
      const body = (await res.json()) as { data?: { status?: string } };
      beehiivStatus = body?.data?.status;
    } catch {
      beehiivStatus = undefined;
    }
    return { ok: true, status: res.status, beehiivStatus };
  }
  return { ok: false, status: res.status, reason: "beehiiv_error" };
}

/**
 * #6048 (Fase 2/2, migração Beehiiv → Kit, #461/#463): equivalente Kit de
 * `subscribeToBeehiiv` acima — mesmo contrato/mecânica do worker `poll`
 * (`workers/poll/src/subscribe.ts::subscribeToKit`, Fase 1 #6082). Achados
 * ao vivo reusados sem redescobrir (ver docstring lá pro detalhe completo):
 *
 * - `POST /v4/subscribers` com `state: "active"` bypassa qualquer
 *   confirmação — equivalente ao `double_opt_override: "off"` da Beehiiv.
 *   Por isso `beehiivStatus` sai sempre `"active"` no sucesso (nome do campo
 *   preservado do contrato Beehiiv pra não obrigar o caller —
 *   `handleGateSubscribe` — a saber qual backend respondeu).
 * - Idempotente por e-mail: 201 na 1ª chamada, 200 nas subsequentes.
 * - Sem UTM/referring-site nativo — só via `fields` customizado
 *   (`KIT_*_FIELD`, `Env`), nenhum criado em produção ainda — degrade com
 *   graça (cadastro funciona sem eles).
 */
async function subscribeToKit(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  origemPaga: string = "",
  origin: { referrer: string; clickId: string } = { referrer: "", clickId: "" },
): Promise<SubscribeResult> {
  const apiKey = env.KIT_API_KEY;
  if (!apiKey) return { ok: false, status: 503, reason: "not_configured" };

  const base = env.KIT_API_URL ?? "https://api.kit.com/v4";
  const fields: Record<string, string> = {};
  if (input.name && env.KIT_NAME_FIELD) fields[env.KIT_NAME_FIELD] = input.name;
  if (env.KIT_UTM_SOURCE_FIELD) fields[env.KIT_UTM_SOURCE_FIELD] = CURSOS_UTM_SOURCE;
  if (env.KIT_UTM_MEDIUM_FIELD) fields[env.KIT_UTM_MEDIUM_FIELD] = CURSOS_UTM_MEDIUM;
  if (env.KIT_UTM_CAMPAIGN_FIELD) fields[env.KIT_UTM_CAMPAIGN_FIELD] = CURSOS_UTM_CAMPAIGN;
  if (env.KIT_REFERRING_SITE_FIELD) fields[env.KIT_REFERRING_SITE_FIELD] = "cursos-gate-inline";
  // #7535 (Camada 1): canal pago do cliente, campo PRÓPRIO — nunca
  // sobrescreve o triplo fixo acima.
  if (env.KIT_ORIGEM_PAGA_FIELD && origemPaga) fields[env.KIT_ORIGEM_PAGA_FIELD] = origemPaga;
  // #8003: mesmo guard duplo — campos PRÓPRIOS, nunca sobrescrevem o triplo
  // fixo/origem_paga acima.
  if (env.KIT_ORIGEM_REFERRER_FIELD && origin.referrer) fields[env.KIT_ORIGEM_REFERRER_FIELD] = origin.referrer;
  if (env.KIT_ORIGEM_CLICKID_FIELD && origin.clickId) fields[env.KIT_ORIGEM_CLICKID_FIELD] = origin.clickId;
  // #6048: marcador "entrou pelo funil" — distingue de quem só foi copiado
  // da Beehiiv pelo sync unidirecional (necessário pra segmentar o envio
  // sem entrega duplicada, ver scripts/lib/shared/kit-signup-origin.ts).
  applyKitSignupOriginField(fields, env);

  // #7723: double opt-in. O assinante nasce `inactive` e o VÍNCULO ao designer
  // form (abaixo, pós-criação) é o que dispara o e-mail de confirmação.
  // `resolveKitCreateState` devolve "active" — sem DOI — quando o worker está
  // fora do rollout OU quando o form configurado é inutilizável: criar
  // `inactive` sem caminho de confirmação prende o assinante para sempre
  // (#6565), que é pior que não ter DOI.
  const createState = resolveKitCreateState(env.KIT_DOI_FORM_ID, "cursos");

  const body: Record<string, unknown> = {
    email_address: input.email,
    state: createState,
  };
  if (Object.keys(fields).length > 0) body.fields = fields;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/subscribers`, {
      method: "POST",
      headers: { "X-Kit-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[cursos] fetch pra Kit lançou:", err);
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  // 200 (upsert de e-mail já existente) e 201 (criação) são ambos sucesso —
  // mesma idempotência documentada em subscribeToKit do worker poll.
  if (res.ok) {
    // #7723: só vincula quando o assinante de fato nasceu `inactive` por este
    // caminho — nunca quando `createState === "active"` (worker fora do
    // rollout, ou form inutilizável), mesmo com KIT_DOI_FORM_ID configurado
    // por engano. Best-effort: nunca falha a assinatura.
    if (createState === "inactive") {
      const extraido = await extrairSubscriberId(res);
      if (extraido.ok) {
        await vincularKitDoiForm({
          apiKey,
          base,
          formId: env.KIT_DOI_FORM_ID,
          subscriberId: extraido.id,
          referrer: `https://cursos.diar.ia.br/?utm_source=${encodeURIComponent(CURSOS_UTM_SOURCE)}&utm_medium=${encodeURIComponent(CURSOS_UTM_MEDIUM)}&utm_campaign=${encodeURIComponent(CURSOS_UTM_CAMPAIGN)}`,
          fetchImpl,
          // Sem isto o fetch de vinculo ficava SEM timeout algum (achado do
          // review): a lib so aplica AbortSignal quando recebe timeoutMs.
          timeoutMs: CURSOS_KIT_FETCH_TIMEOUT_MS,
          log: (m) => console.error(`[cursos] ${m}`),
        });
      } else {
        console.error(`[cursos] ${mensagemSubscriberIdAusente(extraido, input.email, res.status)}`);
      }
    }
    return { ok: true, status: res.status, beehiivStatus: createState };
  }
  // #6048 (achado ao vivo no worker poll, 25/08/2026): branch de erro não-2xx
  // era o único ponto silencioso aqui (o catch de exceção já logava) — foi
  // exatamente esse tipo de silêncio que escondeu um KIT_API_KEY inválido.
  const bodyText = await res.text().catch(() => "<unreadable>");
  console.error(`[cursos] Kit respondeu ${res.status}: ${bodyText.slice(0, 500)}`);
  return { ok: false, status: res.status, reason: "beehiiv_error" };
}

/**
 * #6291: parser tolerante de `env.SUBSCRIBE_BACKEND` — mesma classe de bug
 * do #6048 (fallback silencioso pro backend legado), por outra porta.
 * `"Kit"`, `"kit "`, `"beehiv"` caíam em Beehiiv sem nenhum aviso antes
 * desta função. Trim + lowercase tolera espaço/capitalização; qualquer
 * valor que não seja `"kit"`/`"beehiiv"`/vazio loga o valor bruto (nunca
 * lança) antes de degradar pro default. Mesmo mecanismo de
 * `workers/poll/src/subscribe.ts::resolveBackend`, portado (não importado —
 * ver header do arquivo sobre acoplamento cross-worker).
 */
function resolveBackend(env: Pick<Env, "SUBSCRIBE_BACKEND">): "beehiiv" | "kit" {
  const raw = (env.SUBSCRIBE_BACKEND ?? "").trim().toLowerCase();
  if (raw === "kit") return "kit";
  if (raw && raw !== "beehiiv") {
    console.error(`[cursos] SUBSCRIBE_BACKEND desconhecido: ${JSON.stringify(env.SUBSCRIBE_BACKEND)} — caindo em beehiiv`);
  }
  return "beehiiv";
}

/**
 * #6291: ÚNICO ponto de entrada pro cadastro — ramifica por
 * `SUBSCRIBE_BACKEND` (via `resolveBackend`) e chama o backend certo.
 * `subscribeToBeehiiv`/`subscribeToKit` acima NÃO são mais exportadas: um
 * novo call site que esquecesse de ramificar (o bug original do #6048) não
 * alcança mais as funções cruas — o compilador recusa a importação direta.
 */
export async function subscribeViaConfiguredBackend(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  origemPaga: string = "",
  origin: { referrer: string; clickId: string } = { referrer: "", clickId: "" },
): Promise<SubscribeResult> {
  return resolveBackend(env) === "kit"
    ? subscribeToKit(env, input, fetchImpl, origemPaga, origin)
    : subscribeToBeehiiv(env, input, fetchImpl, origemPaga, origin);
}

export interface SubscribeDeps {
  fetchImpl?: typeof fetch;
}

/** Handler `POST /gate/subscribe`. Ao assinar com sucesso, também emite o
 * cookie de sessão (o novo assinante não precisa esperar o próximo sync KV
 * pra ver o conteúdo completo — a Beehiiv já confirmou a criação). */
export async function handleGateSubscribe(
  request: Request,
  env: Env,
  deps: SubscribeDeps = {},
  // #5504 hotfix: ExecutionContext OPCIONAL — habilita `ctx.waitUntil()` pro
  // disparo CAPI abaixo sem atrasar a resposta ao usuário (mesmo padrão de
  // handleJogarSubscribe, workers/poll/src/subscribe.ts). Sem `ctx` real
  // (ex: teste que não injeta um), cai no fallback síncrono.
  ctx?: ExecutionContext,
): Promise<Response> {
  // #4305: fail-closed — sem `COOKIE_HMAC_SECRET` a emissão da sessão quebra
  // (`crypto.subtle.importKey` rejeita chave de tamanho zero). Recusa ANTES de
  // criar assinante na Beehiiv: sem isso o cadastro acontece, a assinatura
  // fica de pé e a pessoa continua trancada fora da página, sem nada a fazer.
  if (!env.COOKIE_HMAC_SECRET) {
    console.error("[cursos] COOKIE_HMAC_SECRET ausente — /gate/subscribe indisponível");
    await incrementKvCounter(env.CURSOS_SUBSCRIBERS, CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente);
    return json({ ok: false, error: "gate_unavailable" }, 503, env);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const raw = await request.text();
  const parsed = parseSubscribeBody(raw, request.headers.get("Content-Type") ?? "");
  const v = validateSubscribeInput(parsed);
  if (!v.ok) {
    if (v.error === "honeypot") return json({ ok: true }, 200, env);
    return json({ ok: false, error: v.error }, v.status, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  const rl = await checkSubscribeRateLimit(env.CURSOS_SUBSCRIBERS, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  // #7535 (Camada 1): resolve o canal pago do cliente contra a mesma
  // allowlist do worker `poll` — nunca sobrescreve o triplo UTM fixo
  // (CURSOS_UTM_SOURCE/MEDIUM/CAMPAIGN acima), só alimenta origem_paga.
  const origemPaga = isAllowedClientUtmSource(parsed.utmSource) ? parsed.utmSource.trim() : "";
  // #8003: sinal de origem cru do cliente — nunca varia por lógica de
  // negócio, mesmo corte de defesa em profundidade que `validateSubscribeInput`
  // já aplica pra outros campos (o cliente já corta em SUBSCRIBE_CLIENT_ORIGIN_MAX,
  // mas nunca confiar só nisso).
  const origin = {
    referrer: (parsed.referrer || "").trim().slice(0, SUBSCRIBE_CLIENT_ORIGIN_MAX),
    clickId: (parsed.clickId || "").trim().slice(0, SUBSCRIBE_CLIENT_ORIGIN_MAX),
  };

  // #6291: seleção de backend via a ÚNICA função exportada — ver docstring
  // de `subscribeViaConfiguredBackend` acima.
  const backend = resolveBackend(env);
  const result = await subscribeViaConfiguredBackend(env, { name: v.name, email: v.email }, fetchImpl, origemPaga, origin);
  if (!result.ok) {
    // #4305: os dois ramos abaixo eram a MESMA classe de falha muda que este
    // PR corrigiu no `COOKIE_HMAC_SECRET` — 503/502 e ninguém avisado. O
    // `beehiiv_error` é o mais grave dos dois: não é config estática que
    // alguém eventualmente relê, é chamada externa viva que pode começar a
    // falhar a qualquer momento (Beehiiv fora, key revogada, 429) e derrubar
    // TODO cadastro vindo do gate sem deixar rastro.
    // #6048 (achado do fleet review, PR #6161): as duas mensagens abaixo
    // citavam "Beehiiv" hardcoded — desde SUBSCRIBE_BACKEND=kit neste
    // worker, uma falha real do Kit (ex: KIT_API_KEY inválida, o cenário
    // exato que o log novo de subscribeToKit existe pra capturar) logava
    // "BEEHIIV_API_KEY ausentes", apontando pro backend errado. O nome da
    // chave do contador (`fatalCadastroBeehiivFalhou`) NÃO foi renomeado
    // aqui — trabalho à parte, fora de escopo desta correção pontual.
    // (Histórico: quando este comentário foi escrito, a justificativa era
    // ter consumidor externo — `scripts/cursos-error-alarm.ts`; esse
    // consumidor foi removido em #6798, 01/09/2026, e um regrep não achou
    // nenhum outro. Renomear agora é seguro, só não foi feito porque
    // ninguém precisou até este ponto.)
    // Preposição concorda com o gênero de cada backend ("a Beehiiv" / "o
    // Kit") — mantém a mensagem da Beehiiv EXATAMENTE como era (regex de
    // `test/cursos-gate.test.ts` depende do texto literal).
    const backendPhrase = backend === "kit" ? "no Kit" : "na Beehiiv";
    const credsPhrase = backend === "kit" ? "do Kit" : "BEEHIIV_API_KEY/PUBLICATION_ID";
    if (result.reason === "not_configured") {
      console.error(`[cursos] credenciais ${credsPhrase} ausentes — cadastro inline indisponível`);
      return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
    }
    console.error(`[cursos] cadastro ${backendPhrase} falhou (HTTP ${result.status}) — nenhum assinante criado`);
    await incrementKvCounter(env.CURSOS_SUBSCRIBERS, CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou);
    return json({ ok: false, error: "subscribe_failed" }, 502, env);
  }

  // #4323: só emite sessão CONFIRMADA quando a própria resposta da Beehiiv já
  // trouxe `status: "active"` (caminho comum, confirmado ao vivo no #4305 —
  // continua sem fricção extra). Qualquer outro caso (double opt-in
  // pendente, campo ausente, corpo não-parseável) emite `pending` — porta o
  // mesmo padrão de `workers/poll/src/web-gate.ts` (#4121), que já resolveu
  // este gap pro worker irmão.
  const state = result.beehiivStatus === "active" ? "confirmed" : "pending";
  const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, v.email, state);

  // #5504/hotfix pós-merge: CompleteRegistration pra Meta Conversions API —
  // fire-and-forget best-effort, DEPOIS da confirmação na Beehiiv. Fail-soft:
  // sem META_CAPI_ACCESS_TOKEN é no-op; qualquer erro nunca chega aqui (ver
  // scripts/lib/shared/meta-capi.ts). `ctx.waitUntil()` adia o envio pra
  // depois da resposta ao usuário — o `await` direto (achado do review
  // pós-merge #5504) atrasava a resposta em até `META_CAPI_FETCH_TIMEOUT_MS`
  // (8s) sempre que a Meta respondia lento.
  // #7776: log estruturado no meio do mesmo caminho fire-and-forget — ver
  // docstring de `logMetaCapiSendResult` (meta-capi.ts).
  const sendEvent = logMetaCapiSendResult(
    sendCompleteRegistrationEvent(
      { email: v.email, eventSourceUrl: request.url },
      { accessToken: env.META_CAPI_ACCESS_TOKEN, fetchImpl },
    ),
    "cursos",
  );
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendEvent);
  } else {
    await sendEvent;
  }

  return json({ ok: true }, 200, env, { "Set-Cookie": setCookie });
}
