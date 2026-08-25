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
import { sendCompleteRegistrationEvent } from "../../../scripts/lib/shared/meta-capi.ts"; // #5504
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
}

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
      return { name: asStr(o.name), email: asStr(o.email), optin: truthyFlag(o.optin), honeypot: asStr(o.website) };
    } catch {
      return { name: "", email: "", optin: false, honeypot: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return {
    name: params.get("name") ?? "",
    email: params.get("email") ?? "",
    optin: truthyFlag(params.get("optin")),
    honeypot: params.get("website") ?? "",
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
const CURSOS_UTM_SOURCE = CURSOS_GATE_INLINE_UTM.source;
const CURSOS_UTM_MEDIUM = CURSOS_GATE_INLINE_UTM.medium;
const CURSOS_UTM_CAMPAIGN = CURSOS_GATE_INLINE_UTM.campaign;

/** Mesmo endpoint/contrato de `subscribeToBeehiiv` do #3580 — `fetchImpl`
 * injetável pra teste, nunca faz rede real em testes. */
export async function subscribeToBeehiiv(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
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
export async function subscribeToKit(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
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

  const body: Record<string, unknown> = {
    email_address: input.email,
    state: "active",
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
  if (res.ok) return { ok: true, status: res.status, beehiivStatus: "active" };
  return { ok: false, status: res.status, reason: "beehiiv_error" };
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

  // #6048: mesma seleção de backend local ao handler do worker poll — env.
  // SUBSCRIBE_BACKEND não é lido por nenhum outro dispatch fora deste worker.
  const result =
    env.SUBSCRIBE_BACKEND === "kit"
      ? await subscribeToKit(env, { name: v.name, email: v.email }, fetchImpl)
      : await subscribeToBeehiiv(env, { name: v.name, email: v.email }, fetchImpl);
  if (!result.ok) {
    // #4305: os dois ramos abaixo eram a MESMA classe de falha muda que este
    // PR corrigiu no `COOKIE_HMAC_SECRET` — 503/502 e ninguém avisado. O
    // `beehiiv_error` é o mais grave dos dois: não é config estática que
    // alguém eventualmente relê, é chamada externa viva que pode começar a
    // falhar a qualquer momento (Beehiiv fora, key revogada, 429) e derrubar
    // TODO cadastro vindo do gate sem deixar rastro.
    if (result.reason === "not_configured") {
      console.error("[cursos] BEEHIIV_API_KEY/PUBLICATION_ID ausentes — cadastro inline indisponível");
      return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
    }
    console.error(`[cursos] cadastro na Beehiiv falhou (HTTP ${result.status}) — nenhum assinante criado`);
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
  const sendEvent = sendCompleteRegistrationEvent(
    { email: v.email, eventSourceUrl: request.url },
    { accessToken: env.META_CAPI_ACCESS_TOKEN, fetchImpl },
  );
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendEvent);
  } else {
    await sendEvent;
  }

  return json({ ok: true }, 200, env, { "Set-Cookie": setCookie });
}
