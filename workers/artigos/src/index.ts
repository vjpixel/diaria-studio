/**
 * workers/artigos/src/index.ts (#7030)
 *
 * Converte `workers/artigos` de static-assets-only pra scripted worker
 * (`main = src/index.ts`) + assets — MESMA conversão que `workers/cursos`
 * fez no #4052. `env.ASSETS` continua servindo o TEASER estático (gerado por
 * `scripts/build-artigo-especial-teaser.ts`, ver `articles-src/`); o script
 * intercepta os paths dos 2 Artigos Especiais gateados
 * (`gated-articles.ts`) + `/gate*` pra decidir teaser × conteúdo completo.
 *
 * **Páginas de entidade e a home continuam 100% estáticas — sem gate, sem
 * mudança de comportamento.** Só os paths em `gatedArticlePaths()` passam
 * por este handler antes do fallback pro asset (decisão do editor #7030:
 * fechar entidades seria ruim pra SEO/GEO).
 *
 * Rotas:
 *   GET  /{ano}/{slug}/[index.html] → teaser (asset) OU full (dinâmico, se
 *                                      cookie de sessão confirma apoio ≥ limiar)
 *   GET  /gate?article={slug}       → tela de gate (gate-page.ts)
 *   POST /gate/verify               → { email } → verifica apoio, seta cookie
 *   POST /gate/logout               → limpa cookie
 *   *                               → fallback pro asset estático (env.ASSETS)
 *
 * Secrets (via `wrangler secret put`, ver PR body pro passo-a-passo):
 *   COOKIE_HMAC_SECRET — assina o cookie de sessão (cookie.ts).
 *
 * KV: `ARTIGOS_APOIO_NIVEL` — populado por `scripts/sync-artigos-apoio-kv.ts`
 * (chave `apoio:{sha256(email)}` → nível, ver `apoio-level-verify.ts`).
 */
import { renderGatePage } from "./gate-page.ts";
import { checkApoioGate, checkGateRateLimit } from "./apoio-gate.ts";
import { clearSessionCookieHeader, issueSessionCookie, readSessionEmail } from "./cookie.ts";
import { articleForPath, articlePathForSlug, gatedArticlePaths, type GatedArticle } from "./gated-articles.ts";

export interface Env {
  ASSETS: Fetcher;
  /** #7030: KV do sync de nível de apoio — chave `apoio:{sha256(email)}`.
   * Criar via `wrangler kv namespace create ARTIGOS_APOIO_NIVEL` (ver PR body). */
  ARTIGOS_APOIO_NIVEL: KVNamespace;
  /** Secret — assina/verifica o cookie de sessão (`cookie.ts`). SEM ela o
   * worker não consegue emitir nem ler sessão nenhuma (mesmo guard fail-soft
   * de `workers/cursos`, #4305). */
  COOKIE_HMAC_SECRET: string;
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...extraHeaders } });
}

function html(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "Content-Type": "text/html;charset=utf-8", ...extraHeaders } });
}

/**
 * Decide teaser × full pra um artigo gateado. Fail-soft: qualquer exceção
 * (KV indisponível, secret ausente) degrada pro teaser via `env.ASSETS` —
 * nunca derruba a página nem vaza o conteúdo completo por engano. Mesmo
 * espírito de `handleIndex` em `workers/cursos/src/index.ts` (#4305).
 */
async function handleArticleRequest(request: Request, env: Env, article: GatedArticle): Promise<Response> {
  try {
    if (!env.COOKIE_HMAC_SECRET) {
      // Sem o secret não dá pra ler sessão nenhuma — degrada pro teaser,
      // igual ao guard de `workers/cursos` (#4305): sem log de e-mail (não
      // há e-mail nesse ramo, nem precisa).
      console.error("[artigos] COOKIE_HMAC_SECRET ausente — servindo teaser; ninguém desbloqueia");
      return env.ASSETS.fetch(request);
    }
    const cookieHeader = request.headers.get("Cookie");
    const email = await readSessionEmail(env.COOKIE_HMAC_SECRET, cookieHeader);
    if (!email) return env.ASSETS.fetch(request);

    const outcome = await checkApoioGate(env, email);
    if (outcome.status === "meets_threshold") return html(article.fullHtml);
    // #4321 (mesma distinção herdada de cursos): resposta ao visitante é
    // SEMPRE o teaser aqui — `reason` só existiria pra log/alarme futuro,
    // que este worker (ainda) não tem (ver PR body — fora de escopo #7030).
    return env.ASSETS.fetch(request);
  } catch (err) {
    console.error(`[artigos] handleArticleRequest falhou (slug=${article.slug}) — degradando pro teaser:`, err);
    return env.ASSETS.fetch(request);
  }
}

async function handleGateVerify(request: Request, env: Env): Promise<Response> {
  if (!env.COOKIE_HMAC_SECRET) {
    console.error("[artigos] COOKIE_HMAC_SECRET ausente — /gate/verify indisponível");
    return json({ ok: false, error: "gate_unavailable" }, 503);
  }

  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) return json({ ok: false, error: "invalid_email" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  const rl = await checkGateRateLimit(env.ARTIGOS_APOIO_NIVEL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429);

  const outcome = await checkApoioGate(env, email);
  if (outcome.status !== "meets_threshold") return json({ ok: false, error: "not_eligible" }, 200);

  const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, email);
  return json({ ok: true }, 200, { "Set-Cookie": setCookie });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    const article = articleForPath(url.pathname);
    if (article && request.method === "GET") {
      return handleArticleRequest(request, env, article);
    }
    if (url.pathname === "/gate" && request.method === "GET") {
      const slug = url.searchParams.get("article") ?? "";
      return html(renderGatePage(articlePathForSlug(slug)));
    }
    if (url.pathname === "/gate/verify" && request.method === "POST") {
      return handleGateVerify(request, env);
    }
    if (url.pathname === "/gate/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
    }

    return env.ASSETS.fetch(request);
  },
};

// Reexportado só pra o `wrangler.toml` comentar contra a MESMA fonte —
// `run_worker_first` precisa ser uma lista LITERAL no TOML (não lê TS em
// runtime de config), mas manter as duas listas sincronizadas é
// responsabilidade de quem editar `gated-articles.ts` (mesma dívida que
// `workers/cursos/wrangler.toml` já assume conscientemente pro seu
// `GATED_INDEX_PATHS`, ver comentário lá).
export { gatedArticlePaths };
