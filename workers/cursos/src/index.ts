/**
 * workers/cursos — Cloudflare Worker (#4052, converte de static-assets-only
 * pra scripted worker + assets).
 *
 * Gate PARCIAL (decisão do editor, ver #4052 e o follow-up #4305): os cursos
 * ABERTOS são `openCourseCount()` do catálogo — 20% arredondado pra baixo,
 * hoje 6 de 31 —, com os marcados `teaser: true` no seed ocupando as vagas
 * primeiro (`selectOpenCourses`, em `scripts/build-cursos-page.ts`). Ficam
 * completos e indexáveis no HTML público (`workers/cursos/public/index.html`,
 * servido via `env.ASSETS`). Os demais NÃO são renderizados de forma alguma —
 * nem título, nem plataforma, nem tema/contagem nos filtros — até o leitor
 * verificar assinatura ativa OU se cadastrar; só a contagem agregada aparece
 * no banner de gate. A CTA é um convite, não uma parede — nunca 403.
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

/** #4305: paths que servem o MESMO asset (`public/index.html`) e portanto
 * precisam passar pelo gate. Tem que casar com o `run_worker_first` do
 * `wrangler.toml` — declarar lá um path que `fetch` não roteia pra
 * `handleIndex` faz o script rodar só pra devolver o teaser cru, um gate que
 * promete cobertura e não entrega (travado por `test/cursos-worker-first.test.ts`). */
export const GATED_INDEX_PATHS = ["/", "/index.html"];

/** Handler do index — resolve qual variante servir. Path A (`?email=`) tem
 * prioridade sobre o cookie (a newsletter é a fonte de verdade mais fresca);
 * cookie é o fallback pra navegação subsequente na mesma sessão.
 *
 * #4305: fail-soft. Antes do `run_worker_first`, o asset era servido sem o
 * script rodar, então nada aqui podia derrubar a home. Agora TODA visita a
 * `/` depende deste handler terminar — um throw do KV (`kv.get` não é
 * envolvido em try/catch em lugar nenhum da cadeia) passaria direto pro
 * `fetch` e derrubaria a página inteira. O catch devolve o teaser: degradar
 * pra "todo mundo vê o teaser" é aceitável, derrubar a home não.
 *
 * O custo disso é observabilidade — 200 silencioso não aparece no gráfico de
 * erro nativo do Cloudflare como um 500 apareceria. Mitigado, NÃO resolvido:
 * todo caminho de degradação deste handler loga e `[observability]` está
 * ligado no `wrangler.toml`, então o rastro passa a ser coletado e
 * consultável. Mas ninguém consome esses logs — não há Logpush, alerta, nem
 * check agendado (o repo tem o padrão pronto em
 * `scripts/clarice-guardrail-alarm.ts`, não aplicado aqui). Na prática: a
 * falha deixa de ser invisível e passa a ser visível-se-alguém-for-olhar, e
 * ninguém tem motivo pra olhar. Some-se que Workers Logs amostra sob volume
 * alto, ou seja, o sinal degrada justo durante uma pane total. Fechar isso de
 * verdade é a #4305. */
async function handleIndex(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const emailParam = (url.searchParams.get("email") || "").trim();

    // #4305: sem o secret do HMAC não dá pra emitir nem ler sessão — a
    // assinatura em si NÃO fica fraca (`TextEncoder().encode(undefined)`
    // devolve buffer vazio sem lançar, mas o `crypto.subtle.importKey`
    // seguinte rejeita chave de tamanho zero com `DataError`, por spec da
    // WebCrypto — verificado). Ou seja: sem o guard isto QUEBRA, não vaza. O
    // guard troca esse throw por degradação explícita e logada. Mesmo guard de
    // `workers/poll/src/web-gate.ts`.
    const canIssueSession = Boolean(env.COOKIE_HMAC_SECRET);
    if (!canIssueSession) {
      // Este ramo é a única degradação que NÃO passa pelo catch abaixo (é
      // desvio de fluxo, não exceção) — sem log próprio, um deploy sem o
      // secret serviria teaser pra assinante ativo vindo da newsletter com
      // zero sinal em qualquer camada: nem status HTTP, nem log.
      console.error("[cursos] COOKIE_HMAC_SECRET ausente — servindo teaser; NINGUÉM consegue desbloquear");
    }

    // #4305: os dois ramos abaixo logam SEM o endereço. O anti-probing do
    // #4052 exige que a RESPOSTA não distinga os casos — o log do servidor é
    // invisível pro visitante e não enfraquece nada disso. Sem ele, uma
    // merge tag quebrada (Beehiiv mandando `{{email}}` cru, lista errada
    // sincronizada pro KV) produz exatamente este caminho em 100% dos cliques
    // da newsletter e fica indistinguível do tráfego normal de quem não
    // assina. O e-mail em si fica DE FORA: `?email=` vem de assinante real, e
    // despejar endereço em log de plataforma é vazamento de PII a troco de
    // nada — a contagem é o que importa, não quem.
    if (canIssueSession && emailParam && !isValidEmailFormat(emailParam)) {
      console.warn("[cursos] ?email= presente mas malformado — provável merge tag não resolvida");
    }

    if (canIssueSession && emailParam && isValidEmailFormat(emailParam)) {
      const result = await checkGateSubscriber(env, emailParam);
      if (result === "active") {
        const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, emailParam);
        return html(CURSOS_FULL_HTML, { "Set-Cookie": setCookie });
      }
      // #4052: e-mail na URL mas não confirmado ativo — NUNCA vaza esse sinal
      // pro leitor (poderia ser link velho/editado à mão); cai pro teaser
      // normal, igual a não ter mandado `?email=` nenhum. Do lado do servidor,
      // porém, isto é o sinal de saúde do caminho A: taxa baixa é normal, taxa
      // de 100% é o gate quebrado de novo.
      console.warn("[cursos] ?email= não confirmado como assinante ativo — servindo teaser");
    }

    if (canIssueSession) {
      const cookieEmail = await readSessionEmail(env.COOKIE_HMAC_SECRET, request.headers.get("Cookie"));
      if (cookieEmail) return html(CURSOS_FULL_HTML);
    }
  } catch (err) {
    // Contexto no log: sem ele não dá pra distinguir "um request com azar" de
    // "100% dos requests falhando" num `wrangler tail`. `request.url` cru
    // porque re-parsear aqui poderia lançar de novo.
    console.error(
      `[cursos] handleIndex falhou (url=${request.url}, cookie=${request.headers.has("Cookie")}) — degradando pro teaser:`,
      err,
    );
  }

  return env.ASSETS.fetch(request);
}

/** Handler `POST /gate/verify` — só verificação (sem criar assinante). */
async function handleGateVerify(request: Request, env: Env): Promise<Response> {
  // #4305: fail-closed — sem o secret do HMAC a emissão de sessão quebra (ver
  // `handleIndex`). 503 explícito em vez de exceção não-tratada: o front
  // distingue os dois (`gate_unavailable` vira aviso de indisponibilidade, não
  // "e-mail não encontrado" — culpar o e-mail da pessoa por erro nosso é pior
  // que não responder).
  if (!env.COOKIE_HMAC_SECRET) {
    console.error("[cursos] COOKIE_HMAC_SECRET ausente — /gate/verify indisponível");
    return json({ ok: false, error: "gate_unavailable" }, 503, env);
  }

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

    if (GATED_INDEX_PATHS.includes(url.pathname) && request.method === "GET") {
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
