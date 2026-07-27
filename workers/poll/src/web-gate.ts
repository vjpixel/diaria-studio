/**
 * workers/poll/src/web-gate.ts (#4054)
 *
 * Tela de entrada do caminho B do "É IA?" (`/jogar`, brand `web`, visitante
 * de fora — social, busca, link compartilhado, leaderboard, bookmark).
 * Mesmo padrão de `workers/cursos/src/gate.ts`/`cookie.ts` (#4052, PR #4088):
 * cookie de sessão HMAC-assinado + verificação de assinante (KV primário +
 * Beehiiv `by_email` secundário) + cadastro inline (honeypot + rate-limit +
 * double opt-in via Beehiiv). Os PRIMITIVOS (assinatura de cookie, hash de
 * e-mail, rate-limit por KV) são os mesmos de `scripts/lib/shared/`, mas
 * ESPELHADOS localmente (`session-cookie.ts`, `subscriber-verify.ts`,
 * `rate-limit.ts` neste diretório) — o bundle do worker `poll` não alcança
 * `scripts/**`, ver o header de qualquer um desses 3 arquivos pro rationale
 * completo (mesmo mecanismo já em produção pra `utm-registry.ts`/
 * `ds-tokens.generated.ts`).
 *
 * Diferença de #4052 (cursos, gate PARCIAL: teaser sempre visível, cadastro é
 * convite): aqui o gate é POR RODADA — "1 rodada livre, e-mail exigido pra
 * continuar / entrar no leaderboard" (decisão do editor, #4054). O client
 * (`jogar.ts`, `renderJogarPageHtml`) seta um cookie NÃO-httponly
 * `eia_web_free_round_used=1` (1 ano) assim que a 1ª rodada anônima é votada;
 * `handleJogarPage` (jogar.ts) checa esse cookie + a AUSÊNCIA de sessão válida
 * pra decidir se serve o jogo normal ou esta tela.
 *
 * Identidade pós-gate: o cookie de sessão emitido aqui é uma origem de
 * identidade PARALELA ao token anônimo (`isValidWebToken`) em `/vote` —
 * NUNCA substitui o guard que rejeita `?email=` cru no brand `web` (#3976/
 * #4011, `vote.ts`). Ver o bloco "identidade pós-gate" em `handleVote`
 * (vote.ts) pro mecanismo de override.
 */
import type { Env } from "./index";
import { corsHeaders, json } from "./index";
import {
  verifySubscriberViaBeehiivByEmail,
  verifySubscriberViaKv,
} from "./subscriber-verify";
import { checkKvRateLimit, clientIpFromRequest, type RateLimitResult } from "./rate-limit";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieHeader,
  signSessionCookie,
  verifySessionCookie,
} from "./session-cookie";
import { isValidVoteEmailFormat } from "./lib";
import { subscribeToBeehiiv, resolveSubscribeUtm, type SubscribeDeps } from "./subscribe";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";

/** Nome do cookie de sessão do caminho `/jogar` — namespace próprio, distinto
 * de `diaria_cursos_session` (#4052): domínios/workers diferentes, mas o
 * nome não precisaria colidir mesmo se fossem o mesmo domínio (path `/` de
 * cada worker é o seu próprio host). */
export const WEB_SESSION_COOKIE = "diaria_jogar_session";
/** ~30 dias — mesma decisão de #4052 (sessão longa, verificação já é
 * soft-gate; re-gatear a cada visita destruiria a UX de "1 rodada livre" pra
 * quem já se identificou). */
export const WEB_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export async function issueWebSessionCookie(secret: string, email: string): Promise<string> {
  const value = await signSessionCookie(secret, email, WEB_SESSION_TTL_SEC);
  return buildSetCookieHeader(WEB_SESSION_COOKIE, value, WEB_SESSION_TTL_SEC);
}

/** `cookieHeader` pode ser `null`/ausente (request sem `Cookie`, ou secret
 * ausente — sem `COOKIE_HMAC_SECRET` NUNCA há sessão válida, fail-closed). */
export async function readWebSessionEmail(
  secret: string | undefined,
  cookieHeader: string | null,
): Promise<string | null> {
  if (!secret) return null;
  const raw = parseCookieHeader(cookieHeader, WEB_SESSION_COOKIE);
  if (!raw) return null;
  const result = await verifySessionCookie(secret, raw);
  return result.ok ? result.email : null;
}

export function clearWebSessionCookieHeader(): string {
  return buildClearCookieHeader(WEB_SESSION_COOKIE);
}

/** Cookie NÃO-httponly, lido/escrito pelo próprio JS de `jogar.ts` — marca
 * "esta rodada livre já foi usada neste navegador". Não é sessão nem prova de
 * identidade nenhuma, só um contador binário client-controlled (o pior caso
 * de abuso — limpar cookies pra "resetar" a rodada livre — é exatamente o
 * mesmo custo/benefício de qualquer paywall soft baseado em localStorage; não
 * é o mecanismo que protege o ranking, `isValidWebToken`/o dedup por edição
 * continuam sendo a defesa real). */
export const FREE_ROUND_COOKIE = "eia_web_free_round_used";

/** Cadastro/verificação: N tentativas por IP por janela — mesmo teto de
 * `GATE_RATE_LIMIT` (#4052, `workers/cursos/src/gate.ts`). */
export const GATE_RATE_LIMIT = 8;
export const GATE_RATE_WINDOW_SEC = 3600; // 1h

export function checkGateRateLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  return checkKvRateLimit(kv, `rl:jogar-gate:${ip}`, GATE_RATE_LIMIT, GATE_RATE_WINDOW_SEC);
}

/** `json()` de `index.ts` não aceita headers extras (diferente do homônimo em
 * `workers/cursos/src/index.ts`, #4052) — este worker nunca precisou setar
 * cookie antes do gate. Wrapper local só pra esses 2 call sites que precisam
 * de `Set-Cookie` junto com o corpo JSON. */
function jsonWithCookie(data: unknown, status: number, env: Env, setCookie: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env), "Set-Cookie": setCookie },
  });
}

export type GateCheckResult = "active" | "not_active";

/**
 * Verifica se `email` é assinante ATIVO da Diar.ia. PRIMÁRIO: `env.SUBSCRIBERS_KV`
 * (mesma população/formato de chave de `CURSOS_SUBSCRIBERS`, #4052). SECUNDÁRIO
 * (só se o binding faltar/"unknown" E os secrets Beehiiv estiverem
 * configurados): `by_email` direto na API — não confirmado ao vivo (mesma nota
 * de `subscriber-verify.ts`). Nunca lança; ausência de qualquer verificação
 * disponível cai em `"not_active"` — o form de cadastro inline cobre esse caso.
 */
export async function checkWebSubscriber(env: Env, email: string): Promise<GateCheckResult> {
  if (env.SUBSCRIBERS_KV) {
    const viaKv = await verifySubscriberViaKv(env.SUBSCRIBERS_KV, email);
    if (viaKv === "active") return "active";
  }

  if (env.BEEHIIV_API_KEY && env.BEEHIIV_PUBLICATION_ID) {
    const viaApi = await verifySubscriberViaBeehiivByEmail(env.BEEHIIV_API_KEY, env.BEEHIIV_PUBLICATION_ID, email, {
      baseUrl: env.BEEHIIV_API_URL,
    });
    if (viaApi === "active") return "active";
  }

  return "not_active";
}

/** Mesmo regex de forbidden-chars/formato de `isValidVoteEmailFormat` (lib.ts)
 * — reusado direto (já é local a este worker, sem necessidade de espelho). */
export const isValidEmailFormat = isValidVoteEmailFormat;

/**
 * Handler `POST /jogar/gate/verify` — só verificação (sem criar assinante).
 * Honeypot silencioso (mesmo padrão de `subscribe.ts` #3580): campo `website`
 * preenchido devolve `not_active` fake, sem sinalizar detecção ao bot.
 */
export async function handleJogarGateVerify(request: Request, env: Env): Promise<Response> {
  const ip = clientIpFromRequest(request);
  const rl = await checkGateRateLimit(env.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  let body: { email?: unknown; website?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; website?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400, env);
  }
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: false, error: "not_active" }, 200, env);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !isValidEmailFormat(email)) return json({ ok: false, error: "invalid_email" }, 400, env);

  const result = await checkWebSubscriber(env, email);
  if (result !== "active") return json({ ok: false, error: "not_active" }, 200, env);

  if (!env.COOKIE_HMAC_SECRET) return json({ ok: false, error: "gate_unavailable" }, 503, env);
  const setCookie = await issueWebSessionCookie(env.COOKIE_HMAC_SECRET, email);
  return jsonWithCookie({ ok: true }, 200, env, setCookie);
}

export interface GateSubscribeDeps extends SubscribeDeps {}

/**
 * Handler `POST /jogar/gate/subscribe` — cadastro inline no MESMO mecanismo
 * de `POST /jogar/subscribe` (#3580: honeypot + rate-limit + double opt-in
 * via Beehiiv), aqui com `source` FIXO `"jogar-gate"` (UTM próprio,
 * `resolveSubscribeUtm`) e emissão de cookie de sessão IMEDIATA no sucesso —
 * a confirmação da Beehiiv segue em paralelo (double opt-in), o cookie NÃO
 * espera por ela (decisão do editor, #4054: a fricção de esperar clique em
 * e-mail mataria a conversão do gate).
 */
export async function handleJogarGateSubscribe(
  request: Request,
  env: Env,
  deps: GateSubscribeDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const raw = await request.text();
  let parsed: { name?: unknown; email?: unknown; optin?: unknown; website?: unknown };
  const ct = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
  } else {
    const params = new URLSearchParams(raw);
    parsed = {
      name: params.get("name") ?? "",
      email: params.get("email") ?? "",
      optin: params.get("optin") ?? "",
      website: params.get("website") ?? "",
    };
  }

  const honeypot = typeof parsed.website === "string" ? parsed.website.trim() : "";
  if (honeypot) return json({ ok: true }, 200, env);

  const optinRaw = parsed.optin;
  const optin = optinRaw === true || optinRaw === "on" || optinRaw === "true" || optinRaw === "1" || optinRaw === "yes";
  if (!optin) return json({ ok: false, error: "optin_required" }, 400, env);

  const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
  if (!isValidEmailFormat(email)) return json({ ok: false, error: "invalid_email" }, 400, env);
  const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 100) : "";

  const ip = clientIpFromRequest(request);
  const rl = await checkGateRateLimit(env.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  const utm = resolveSubscribeUtm("jogar-gate");
  const result = await subscribeToBeehiiv(env, { name, email }, fetchImpl, utm);
  if (!result.ok) {
    if (result.reason === "not_configured") return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
    return json({ ok: false, error: "subscribe_failed" }, 502, env);
  }

  if (!env.COOKIE_HMAC_SECRET) {
    // Assinou de verdade na Beehiiv, mas o worker não consegue emitir sessão
    // (secret ausente) — ainda assim 200 (o cadastro FOI feito), sem cookie.
    // O leitor precisa confirmar o opt-in E revisitar depois que o editor
    // configurar o secret pra ver a sessão persistir.
    return json({ ok: true, sessionUnavailable: true }, 200, env);
  }
  const setCookie = await issueWebSessionCookie(env.COOKIE_HMAC_SECRET, email);
  return jsonWithCookie({ ok: true }, 200, env, setCookie);
}

/**
 * Pure: HTML da tela de entrada do caminho B — mesmo form serve os dois
 * fluxos (login OU cadastro): o JS tenta `/jogar/gate/verify` primeiro; se
 * `not_active`, re-submete o MESMO e-mail (+ nome opcional + opt-in) pra
 * `/jogar/gate/subscribe`. Mesmo DS canônico (`ds-tokens.generated.ts`) do
 * resto do worker.
 */
export function renderJogarGatePage(edition: string | null): string {
  const editionParam = edition ? `&edition=${encodeURIComponent(edition)}` : "";
  // #4109 (achado ao vivo 260727, editor): o gate original (#4054) bloqueava
  // sem saída — quem não queria assinar ficava travado na tela. Link de skip
  // manda `skip_gate=1`, único-uso por navegação (handleJogarPage abaixo só
  // lê esse param nesta request específica, não grava cookie/sessão nenhuma)
  // — a próxima transição de rodada volta a checar o servidor e pode gatear
  // de novo (nudge recorrente, não permanente; decisão do editor).
  const skipHref = `/jogar?v=${Date.now()}${editionParam}&skip_gate=1`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? | Continue jogando</title>
<style>
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 480px; margin: 60px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.5rem; line-height: 1.4; margin: 0 0 12px 0; }
  p.explain { font-size: 0.95rem; line-height: 1.5; margin: 0 0 24px 0; }
  form { display: flex; flex-direction: column; gap: 10px; text-align: left; }
  input[type=email], input[type=text] { padding: 10px 12px; border: 1px solid ${DS_COLORS.rule}; border-radius: 4px; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  label.optin { font-size: 0.85rem; display: flex; gap: 6px; align-items: flex-start; }
  button { padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-family: ${DS_FONTS.sans}; }
  .website { position: absolute; left: -9999px; }
  #gate-msg { margin-top: 10px; min-height: 1.2em; }
  #gate-msg.err { padding: 12px 14px; font-size: 0.95rem; font-weight: 700; color: ${DS_COLORS.ink}; background: #FBECEC; border: 1px solid #E3B4B4; border-radius: 4px; }
  #gate-msg.info { font-size: 0.9rem; color: ${DS_COLORS.ink}; opacity: 0.75; }
  .skip-link { display: block; margin-top: 18px; font-size: 0.9rem; opacity: 0.75; }
</style>
</head>
<body>
<h1>Você já jogou sua rodada livre</h1>
<p class="explain">Pra continuar jogando (e entrar no ranking), é só confirmar seu e-mail. Já assina a Diar.ia? Entra direto. Ainda não? Cadastra na hora.</p>
<form id="gate-form">
  <input type="text" name="website" class="website" tabindex="-1" autocomplete="off">
  <input type="email" name="email" placeholder="seu@email.com" required>
  <input type="text" name="name" placeholder="Nome (opcional)">
  <label class="optin"><input type="checkbox" name="optin" value="1"> Quero receber a Diar.ia — newsletter diária e gratuita que resume as principais notícias e tutoriais de IA em 5 minutos de leitura, direto no seu e-mail.</label>
  <button type="submit">Continuar jogando</button>
</form>
<p id="gate-msg"></p>
<a class="skip-link" href="${skipHref}">Agora não, continuar jogando</a>
<script>
(function () {
  var form = document.getElementById("gate-form");
  var msg = document.getElementById("gate-msg");
  function setMsg(text, cls) {
    msg.textContent = text;
    msg.className = cls || "";
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    setMsg("Verificando…", "info");
    var email = form.email.value.trim();
    var name = form.name.value.trim();
    var optin = form.optin.checked;
    var website = form.website.value;
    fetch("/jogar/gate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, website: website }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.ok) { window.location.href = "/jogar?v=" + Date.now() + "${editionParam}"; return; }
      if (!optin) { setMsg("Marque a caixinha pra assinar e continuar.", "err"); return; }
      return fetch("/jogar/gate/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, name: name, optin: optin, website: website }),
      }).then(function (r2) { return r2.json(); }).then(function (data2) {
        if (data2 && data2.ok && !data2.sessionUnavailable) { window.location.href = "/jogar?v=" + Date.now() + "${editionParam}"; return; }
        if (data2 && data2.ok && data2.sessionUnavailable) { setMsg("Assinatura feita! Confirme o e-mail que te enviamos — depois é só voltar aqui pra continuar jogando.", "err"); return; }
        setMsg("Não deu — tenta de novo em instantes.", "err");
      });
    }).catch(function () { setMsg("Erro de conexão — tenta de novo.", "err"); });
  });
})();
</script>
</body>
</html>`;
}
