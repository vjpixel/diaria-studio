/**
 * workers/cursos — Cloudflare Worker (#4052, converte de static-assets-only
 * pra scripted worker + assets).
 *
 * Gate PARCIAL (decisão do editor, ver PR #4052): 4 cursos abertos
 * (`teaser: true` no seed) ficam completos e indexáveis no HTML público
 * (`workers/cursos/public/index.html`, servido via `env.ASSETS`); os demais
 * aparecem como card bloqueado (título+plataforma só) até o leitor verificar
 * assinatura ativa OU se cadastrar. A CTA é um convite, não uma parede —
 * nunca 403.
 *
 * Dois caminhos de entrada:
 *   A. `?email=` na URL (merge-tag da newsletter, `{{email}}`/`{{ contact.EMAIL }}`
 *      já resolvidos pelo Beehiiv/Brevo antes de chegar aqui como query
 *      param) — verifica, seta cookie, serve o conteúdo COMPLETO direto,
 *      sem nunca mostrar a tela de gate.
 *   B. Sem `?email=` e sem cookie válido — serve o teaser normal (estático);
 *      o leitor clica no banner/CTA → `GET /gate` → `POST /gate/verify` (já
 *      assinante) ou `POST /gate/subscribe` (cadastro inline, #3580 reuse).
 *
 * Rotas:
 *   GET  /                → teaser (asset estático) OU full (dinâmico, se
 *                           `?email=` válido ou cookie válido)
 *   GET  /gate             → tela de gate (gate-page.ts)
 *   POST /gate/verify      → { email } → verifica assinante ativo, seta cookie
 *   POST /gate/subscribe   → cadastro inline (honeypot+opt-in, #3580 reuse)
 *   *                       → fallback pro asset estático (env.ASSETS)
 *
 * Secrets (via `wrangler secret put`, ver PR body pro passo-a-passo):
 *   BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID — verificação secundária
 *     (by_email, NÃO confirmada ao vivo — ver subscriber-verify.ts) e
 *     cadastro inline (subscribe.ts).
 *   COOKIE_HMAC_SECRET — assina o cookie de sessão (cookie.ts).
 *
 * KV: `CURSOS_SUBSCRIBERS` — populado por `scripts/sync-cursos-subscribers-kv.ts`
 * (chave `subscriber:{sha256(email)}`, ver `lib/shared/subscriber-verify.ts`).
 */
import { CURSOS_FULL_HTML } from "./courses-full.generated.ts";
import { renderGatePage } from "./gate-page.ts";
import { checkGateRateLimit, checkGateSubscriber } from "./gate.ts";
import { clearSessionCookieHeader, issueSessionCookie, readSessionEmail } from "./cookie.ts";
import { handleGateSubscribe, isValidEmailFormat } from "./subscribe.ts";

export interface Env {
  ASSETS: Fetcher;
  /** #4052: KV do sync de assinantes ativos — chave `subscriber:{sha256(email)}`.
   * Criar via `wrangler kv namespace create CURSOS_SUBSCRIBERS` (ver PR body). */
  CURSOS_SUBSCRIBERS: KVNamespace;
  /** Secret — assina/verifica o cookie de sessão (`cookie.ts`). SEM ela o
   * worker não consegue emitir sessão nenhuma; configurar antes do deploy. */
  COOKIE_HMAC_SECRET: string;
  /** Secrets opcionais — verificação secundária + cadastro inline via Beehiiv
   * (mesmo padrão de `workers/poll/src/index.ts` #3580: ausentes → endpoint
   * responde `subscribe_unavailable`/só usa o path KV, nunca quebra). */
  BEEHIIV_API_KEY?: string;
  BEEHIIV_PUBLICATION_ID?: string;
  BEEHIIV_API_URL?: string;
  BEEHIIV_NAME_FIELD?: string;
  ALLOWED_ORIGINS?: string;
  _requestOrigin?: string | null;
}

export function corsHeaders(env: Env): Record<string, string> {
  const base = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  const configured = (env.ALLOWED_ORIGINS ?? "").trim();
  if (configured === "" || configured === "*") return { "Access-Control-Allow-Origin": "*", ...base };
  const allowed = configured.split(",").map((o) => o.trim()).filter(Boolean);
  const origin = env._requestOrigin;
  if (origin && allowed.includes(origin)) return { "Access-Control-Allow-Origin": origin, Vary: "Origin", ...base };
  return base;
}

export function json(data: unknown, status = 200, env?: Env, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(env ? corsHeaders(env) : {}), ...extraHeaders },
  });
}

function html(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "Content-Type": "text/html;charset=utf-8", ...extraHeaders } });
}

/** Handler `GET /` — resolve qual variante servir. Path A (`?email=`) tem
 * prioridade sobre o cookie (a newsletter é a fonte de verdade mais fresca);
 * cookie é o fallback pra navegação subsequente na mesma sessão. */
async function handleIndex(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const emailParam = (url.searchParams.get("email") || "").trim();

  if (emailParam && isValidEmailFormat(emailParam)) {
    const result = await checkGateSubscriber(env, emailParam);
    if (result === "active") {
      const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, emailParam);
      return html(CURSOS_FULL_HTML, { "Set-Cookie": setCookie });
    }
    // #4052: e-mail na URL mas não confirmado ativo — NUNCA vaza esse sinal
    // pro leitor (poderia ser link velho/editado à mão); cai pro teaser
    // normal, silenciosamente, igual a não ter mandado `?email=` nenhum.
  }

  const cookieEmail = await readSessionEmail(env.COOKIE_HMAC_SECRET, request.headers.get("Cookie"));
  if (cookieEmail) return html(CURSOS_FULL_HTML);

  return env.ASSETS.fetch(request);
}

/** Handler `POST /gate/verify` — só verificação (sem criar assinante). */
async function handleGateVerify(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  const rl = await checkGateRateLimit(env.CURSOS_SUBSCRIBERS, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  let body: { email?: unknown; website?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; website?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400, env);
  }
  // Honeypot silencioso (mesmo padrão de subscribe.ts #3580) — bot que
  // preenche o campo invisível recebe 200 fake-fail, não sinaliza detecção.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: false, error: "not_active" }, 200, env);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !isValidEmailFormat(email)) return json({ ok: false, error: "invalid_email" }, 400, env);

  const result = await checkGateSubscriber(env, email);
  if (result !== "active") return json({ ok: false, error: "not_active" }, 200, env);

  const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, email);
  return json({ ok: true }, 200, env, { "Set-Cookie": setCookie });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runtimeEnv: Env = { ...env, _requestOrigin: request.headers.get("Origin") };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(runtimeEnv) });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return handleIndex(request, runtimeEnv);
    }
    if (url.pathname === "/gate" && request.method === "GET") {
      return html(renderGatePage());
    }
    if (url.pathname === "/gate/verify" && request.method === "POST") {
      return handleGateVerify(request, runtimeEnv);
    }
    if (url.pathname === "/gate/subscribe" && request.method === "POST") {
      return handleGateSubscribe(request, runtimeEnv);
    }
    if (url.pathname === "/gate/logout" && request.method === "POST") {
      return json({ ok: true }, 200, runtimeEnv, { "Set-Cookie": clearSessionCookieHeader() });
    }

    return env.ASSETS.fetch(request);
  },
};
