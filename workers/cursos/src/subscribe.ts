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
}

const CURSOS_UTM_SOURCE = "cursos";
const CURSOS_UTM_MEDIUM = "gate-inline";
const CURSOS_UTM_CAMPAIGN = "cursos-gate-signup";

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
  } catch {
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, reason: "beehiiv_error" };
}

export interface SubscribeDeps {
  fetchImpl?: typeof fetch;
}

/** Handler `POST /gate/subscribe`. Ao assinar com sucesso, também emite o
 * cookie de sessão (o novo assinante não precisa esperar o próximo sync KV
 * pra ver o conteúdo completo — a Beehiiv já confirmou a criação). */
export async function handleGateSubscribe(request: Request, env: Env, deps: SubscribeDeps = {}): Promise<Response> {
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

  const result = await subscribeToBeehiiv(env, { name: v.name, email: v.email }, fetchImpl);
  if (!result.ok) {
    if (result.reason === "not_configured") return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
    return json({ ok: false, error: "subscribe_failed" }, 502, env);
  }

  const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, v.email);
  return json({ ok: true }, 200, env, { "Set-Cookie": setCookie });
}
