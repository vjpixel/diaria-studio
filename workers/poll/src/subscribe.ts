/**
 * workers/poll/src/subscribe.ts (#3580)
 *
 * Cadastro INLINE no fim do fluxo do jogo "É IA?" standalone (brand `web`) —
 * conversão direta do EPIC #3514, evolução do funil #3518 (que só linkava pro
 * Beehiiv). Aqui o visitante põe nome + e-mail + marca a caixinha de opt-in e
 * assina a newsletter SEM sair da página (`POST /jogar/subscribe`).
 *
 * Mecanismo de assinatura (decisão de design): API pública da Beehiiv
 * (`POST /publications/{id}/subscriptions`, `Authorization: Bearer {apiKey}`)
 * — mesma API já usada pelos scripts do repo (`scripts/lib/beehiiv-config.ts`,
 * `backup-beehiiv.ts`). É a opção mais robusta porque (a) roda 100% server-side
 * (a key NUNCA vai pro cliente, ao contrário de um form embutido/iframe que
 * exporia a publicação), (b) deixa o worker aplicar anti-abuso próprio
 * (honeypot + rate-limit + validação de e-mail) ANTES de tocar a Beehiiv, e
 * (c) respeita o double opt-in configurado na publicação (não passamos
 * `double_opt_override` — se a publicação exige confirmação, a Beehiiv manda o
 * e-mail de confirmação; a caixinha marcada é o consentimento LGPD explícito, a
 * confirmação da Beehiiv é a 2ª camada).
 *
 * SEGREDO AUSENTE (documentado no PR): o worker `poll` NÃO tem hoje os secrets
 * `BEEHIIV_API_KEY` / `BEEHIIV_PUBLICATION_ID` (só `POLL_SECRET`/`ADMIN_SECRET`,
 * ver SECRETS.md). Sem eles, `subscribeToBeehiiv` retorna `not_configured` e o
 * endpoint responde 503 amigável ("assine pela página") — o form + validação +
 * anti-abuso já ficam prontos; basta o editor rodar:
 *   cd workers/poll
 *   echo "$BEEHIIV_API_KEY"        | npx wrangler secret put BEEHIIV_API_KEY
 *   echo "$BEEHIIV_PUBLICATION_ID" | npx wrangler secret put BEEHIIV_PUBLICATION_ID
 * (padrão apoia.se: nunca hardcode; só env/secret do worker.)
 */
import type { Env } from "./index";
import { json } from "./index";
import { isValidVoteEmailFormat } from "./lib";
// Fonte única do utm_source do funil (`eia-standalone`, #3518) — mesma
// convenção de `count-subscriptions-by-utm.ts`. medium/campaign PRÓPRIOS
// abaixo distinguem o cadastro inline do CTA-link e do quiz.
import { SUBSCRIBE_UTM_SOURCE } from "./jogar";

/** UTM próprio do cadastro inline (#3580) — `utm_source` continua
 * `eia-standalone` (convenção de medição), medium/campaign distintos pra medir
 * a conversão INLINE separada do CTA-link (#3518) e do quiz (#3579). */
export const INLINE_SUBSCRIBE_UTM_MEDIUM = "jogar-inline";
export const INLINE_SUBSCRIBE_UTM_CAMPAIGN = "eia-jogar-inline-signup";

/** Teto de tamanho do nome capturado — evita payload abusivo (o campo é
 * opcional; a Beehiiv nem tem um campo nativo de nome, ver `subscribeToBeehiiv`). */
export const SUBSCRIBE_NAME_MAX = 100;

/** Rate-limit padrão do cadastro público: N cadastros bem-formados por IP por
 * janela. Baixo de propósito — um humano assina 1x; qualquer coisa acima é
 * abuso. */
export const SUBSCRIBE_RATE_LIMIT = 5;
export const SUBSCRIBE_RATE_WINDOW_SEC = 3600; // 1h

export interface ParsedSubscribe {
  name: string;
  email: string;
  optin: boolean;
  /** honeypot — campo invisível que só bot preenche. */
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

/**
 * Pure (#3580): parse do corpo do POST — aceita `application/json` (caminho do
 * fetch do cliente) e `application/x-www-form-urlencoded` (fallback de form
 * nativo sem JS, defensivo). Nunca lança — JSON malformado vira input vazio
 * (que o validador rejeita depois), nunca 500.
 */
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
      };
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

/**
 * Pure (#3580): valida o input do cadastro server-side (NUNCA confiar só no JS
 * do cliente). Ordem importa:
 *   1. honeypot preenchido → `honeypot` (o handler responde 200 fake-success
 *      pra NÃO sinalizar ao bot que foi detectado; nenhuma assinatura acontece).
 *   2. opt-in não marcado → 400 `optin_required` (consentimento LGPD é
 *      obrigatório; a caixinha é o consentimento explícito).
 *   3. e-mail inválido → 400 `invalid_email` (mesma autoridade de formato do
 *      voto, `isValidVoteEmailFormat`).
 * Nome é opcional, trimado e cortado em SUBSCRIBE_NAME_MAX.
 */
export function validateSubscribeInput(p: ParsedSubscribe): SubscribeValidation {
  if (p.honeypot && p.honeypot.trim() !== "") {
    return { ok: false, status: 200, error: "honeypot" };
  }
  if (!p.optin) {
    return { ok: false, status: 400, error: "optin_required" };
  }
  const email = (p.email || "").trim();
  if (!isValidVoteEmailFormat(email)) {
    return { ok: false, status: 400, error: "invalid_email" };
  }
  const name = (p.name || "").trim().slice(0, SUBSCRIBE_NAME_MAX);
  return { ok: true, name, email };
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

/**
 * #3580: rate-limit por IP via KV (`rl:subscribe:{ip}`). Sem DO novo — o
 * volume é baixo (form público de cadastro), a consistência eventual do KV é
 * aceitável pra anti-abuso (o pior caso é 1-2 cadastros a mais numa corrida,
 * não um vetor de spam em massa). Só é alcançado por requests JÁ bem-formados
 * (honeypot/opt-in/e-mail validados antes) — ou seja, protege a API da Beehiiv
 * de flood. `expirationTtl` reseta a janela a cada tentativa (janela deslizante
 * — mais estrita pra abusador, irrelevante pro humano que assina 1x). Sem IP
 * (fixtures/ambiente sem CF-Connecting-IP) → permite (as outras barreiras
 * continuam valendo).
 */
export async function checkSubscribeRateLimit(
  kv: KVNamespace,
  ip: string,
  limit: number = SUBSCRIBE_RATE_LIMIT,
  windowSec: number = SUBSCRIBE_RATE_WINDOW_SEC,
): Promise<RateLimitResult> {
  if (!ip) return { allowed: true, count: 0 };
  const key = `rl:subscribe:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count };
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, count: count + 1 };
}

export interface SubscribeResult {
  ok: boolean;
  status: number;
  reason?: "not_configured" | "beehiiv_error";
}

/**
 * #3580: ponto de integração com a Beehiiv. Lê `BEEHIIV_API_KEY` +
 * `BEEHIIV_PUBLICATION_ID` do env do worker (secrets — NUNCA hardcode). Se
 * qualquer um faltar, retorna `not_configured` (o handler traduz pra 503
 * amigável) — o resto do fluxo (form + validação + anti-abuso) já funciona,
 * só a chamada externa fica pendente da configuração do secret.
 *
 * `fetchImpl` injetável pra teste (nunca faz rede real nos testes, #633).
 *
 * Nome: a Beehiiv não tem campo nativo de "nome" na criação de assinatura.
 * Quando `BEEHIIV_NAME_FIELD` (nome do custom field criado no dashboard da
 * Beehiiv) está configurado E há nome, mandamos via `custom_fields`. Sem esse
 * env, a assinatura vai só com e-mail + UTM (degrada com graça — nunca falha a
 * assinatura por causa do nome). Double opt-in: respeitado (não mandamos
 * `double_opt_override`); `send_welcome_email: true` dispara o fluxo de
 * boas-vindas/confirmação configurado na publicação.
 */
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
    utm_source: SUBSCRIBE_UTM_SOURCE,
    utm_medium: INLINE_SUBSCRIBE_UTM_MEDIUM,
    utm_campaign: INLINE_SUBSCRIBE_UTM_CAMPAIGN,
    referring_site: "jogar-eia-inline",
  };
  if (input.name && env.BEEHIIV_NAME_FIELD) {
    body.custom_fields = [{ name: env.BEEHIIV_NAME_FIELD, value: input.name }];
  }

  let res: Response;
  try {
    res = await fetchImpl(`${base}/publications/${pubId}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
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

/**
 * Handler `POST /jogar/subscribe` (#3580). Fluxo: parse → valida (honeypot /
 * opt-in / e-mail) → rate-limit por IP → `subscribeToBeehiiv`. Sempre responde
 * JSON (com CORS via `json(env)`).
 *
 * Respostas:
 *   - 200 `{ ok: true }`  — assinou (ou honeypot silenciosamente descartado)
 *   - 400 `{ ok: false, error }` — opt-in ausente / e-mail inválido
 *   - 429 `{ ok: false, error: "rate_limited" }` — abuso por IP
 *   - 503 `{ ok: false, error: "subscribe_unavailable" }` — secret Beehiiv não
 *          configurado (o form cai no fallback "assine pela página")
 *   - 502 `{ ok: false, error: "subscribe_failed" }` — Beehiiv rejeitou/erro
 */
export async function handleJogarSubscribe(
  request: Request,
  env: Env,
  deps: SubscribeDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const raw = await request.text();
  const parsed = parseSubscribeBody(raw, request.headers.get("Content-Type") ?? "");
  const v = validateSubscribeInput(parsed);
  if (!v.ok) {
    // Honeypot: 200 fake-success — não revela ao bot que foi pego.
    if (v.error === "honeypot") return json({ ok: true }, 200, env);
    return json({ ok: false, error: v.error }, v.status, env);
  }

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "";
  const rl = await checkSubscribeRateLimit(env.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  const result = await subscribeToBeehiiv(env, { name: v.name, email: v.email }, fetchImpl);
  if (result.ok) return json({ ok: true }, 200, env);
  if (result.reason === "not_configured") {
    return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
  }
  return json({ ok: false, error: "subscribe_failed" }, 502, env);
}
