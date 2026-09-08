/**
 * workers/anual/src/index.ts (#7581)
 *
 * Serve a página pública da retrospectiva ANUAL com gate de CADASTRO —
 * decisão do editor (07/09/2026, comentário-marcador da #7581): diferente do
 * artigo mensal (`workers/artigo-mensal`, gate de APOIO R$10+/mês), aqui
 * basta ser assinante ativo da base própria (Kit) pra ler a edição completa.
 *
 * O HTML da edição é PRÉ-RENDERIZADO no Node-side
 * (`scripts/build-annual-page.ts`, reusa `buildAnnualHtml`/`buildAnnualTeaserHtml`,
 * `scripts/lib/anual/build-annual-page.ts`) e vive no KV `ARTICLES` sob
 * `article:{slug}` (completo) / `article:{slug}:teaser` (trecho). Este Worker
 * NUNCA faz parsing de markdown — só:
 *
 *   1. resolve o slug do path
 *   2. sem `?email=`: serve o TRECHO + bloco de conversão (cadastro inline)
 *   3. com `?email=`: verifica contra o Kit (`verifySubscriberViaKitByEmail`,
 *      `scripts/lib/shared/subscriber-verify.ts`) — `active` → completo do
 *      KV; qualquer outro estado (inclui falha de verificação) → MESMA
 *      resposta do passo 2 (anti-probing, `src/gate.ts`)
 *   4. rate-limit por IP no caminho que consulta o Kit (`?email=` presente)
 *
 * Rotas:
 *   GET /{slug}            → sem `?email=`: trecho + cadastro inline
 *   GET /{slug}?email=...  → ativo no Kit: completo · qualquer outro estado:
 *                             MESMA resposta de sem `?email=`
 *   GET /{slug}?entrar=1   → form "já é cadastrado? entre com seu e-mail"
 *   GET /                  → 400 (slug obrigatório)
 *   GET /sitemap.xml       → lista os slugs com trecho publicado
 *   GET /robots.txt        → robots.txt próprio (#4777, mesma disciplina de
 *                             `artigo-mensal`/`cursos`/`livros`/`arquivo`)
 *   * outros métodos       → 405
 *
 * Fail-closed (mesmo invariante do #3940/#7580): qualquer falha ao verificar
 * o e-mail (Kit fora do ar, key ausente) NUNCA serve a edição completa — cai
 * no mesmo trecho+cadastro que "e-mail ausente"/"não encontrado" (anti-probing).
 * Falha ao ler `ARTICLES` (namespace fora do ar) também nunca vaza o
 * trecho/form — vira 404 dedicado, distinto do gate (o leitor já provou ser
 * assinante; o problema é o conteúdo, não o acesso).
 */
import { normalizeEmail, decideGate } from "./gate.ts";
import {
  renderEmailForm,
  renderNoTeaser,
  renderTeaserWithSignup,
  renderSlugNotFound,
  renderMissingSlug,
  renderRateLimited,
} from "./render.ts";
import { renderCuradoriaRobotsTxt } from "../../../scripts/lib/shared/robots-txt.ts"; // #4777
import { resolveWorkersDevRedirect } from "../../../scripts/lib/shared/workers-dev-redirect.ts"; // #5104
import { verifySubscriberViaKitByEmail } from "../../../scripts/lib/shared/subscriber-verify.ts"; // #6048
import { checkKvRateLimit, clientIpFromRequest } from "../../../scripts/lib/shared/rate-limit.ts"; // #4052

/** Host público deste Worker — usado pra montar a `Sitemap:` do robots.txt,
 * `canonical`/`og:url` das páginas, e como destino canônico do redirect
 * `.workers.dev` abaixo (#5104). */
const ANUAL_HOST = "https://anual.diar.ia.br";

export interface Env {
  ARTICLES: KVNamespace;
  /** Rate-limit do gate por IP. Opcional — ausência nunca bloqueia a request,
   * só desliga o rate-limit (fail-open no MECANISMO de defesa, nunca no
   * conteúdo servido — o gate de cadastro em si continua fail-closed). */
  RATE_LIMIT?: KVNamespace;
  KIT_API_KEY?: string;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

/**
 * Slugs com trecho público, do mais recente para o mais antigo (#7581) —
 * lista explícita, mesmo racional de `CICLOS_COM_TRECHO`
 * (`workers/artigo-mensal/src/index.ts`, #7580): `list()` no KV custaria uma
 * chamada por request de sitemap e traria também slugs sem trecho publicado.
 * Acrescentar um slug aqui é o passo que o torna descobrível; publicar o
 * `:teaser` no KV (`scripts/build-annual-page.ts --push`) é o que o torna
 * legível — os dois são deliberados.
 */
const SLUGS_COM_TRECHO: readonly string[] = [];

function buildSitemapXml(): string {
  const urls = SLUGS_COM_TRECHO.map(
    (s) => `  <url>
    <loc>${ANUAL_HOST}/${s}</loc>
  </url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function sitemapResponse(): Response {
  return new Response(buildSitemapXml(), {
    status: 200,
    headers: { "Content-Type": "application/xml;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

const ANUAL_ROBOTS_TXT = renderCuradoriaRobotsTxt(`${ANUAL_HOST}/sitemap.xml`);

function robotsResponse(): Response {
  return new Response(ANUAL_ROBOTS_TXT, {
    status: 200,
    headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

/** Rate-limit do gate: N verificações Kit por IP por janela — mesmo teto de
 * `GATE_RATE_LIMIT` (#4052/#4054). Só se aplica ao caminho que CONSULTA o
 * Kit (`?email=` presente) — servir o trecho sem e-mail não consome cota. */
export const GATE_RATE_LIMIT = 8;
export const GATE_RATE_WINDOW_SEC = 3600; // 1h

/** Lê + verifica o HTML pré-renderizado do artigo pro slug. `null` se ausente ou erro de leitura. */
export async function loadArticle(env: Env, slug: string): Promise<string | null> {
  try {
    return await env.ARTICLES.get(`article:${slug}`);
  } catch {
    return null;
  }
}

/** Lê o TRECHO público do slug. `null` se ausente ou erro de leitura — cai
 * no paywall seco (`renderNoTeaser`), nunca no completo. */
export async function loadArticleTeaser(env: Env, slug: string): Promise<string | null> {
  try {
    return await env.ARTICLES.get(`article:${slug}:teaser`);
  } catch (e) {
    console.error(`[anual] falha lendo article:${slug}:teaser: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Página servida a quem NÃO passou no gate (sem e-mail, não-cadastrado,
 * OU falha de verificação — anti-probing, ver `src/gate.ts`). */
async function teaserResponse(env: Env, slug: string, canonical: string): Promise<Response> {
  const teaser = await loadArticleTeaser(env, slug);
  if (!teaser) return htmlResponse(renderNoTeaser(canonical));
  try {
    return htmlResponse(renderTeaserWithSignup(teaser, canonical));
  } catch (e) {
    console.error(`[anual] trecho presente mas não injetável, caindo no paywall seco: ${e instanceof Error ? e.message : e}`);
    return htmlResponse(renderNoTeaser(canonical));
  }
}

/** Extrai o slug do path (`/2026-aniversario` → `"2026-aniversario"`). `""` se path vazio (`/`). */
export function extractSlug(pathname: string): string {
  return decodeURIComponent(pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
}

export async function handleGet(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const slug = extractSlug(url.pathname);
  const canonical = slug ? `${ANUAL_HOST}/${slug}` : ANUAL_HOST;
  if (!slug) {
    return htmlResponse(renderMissingSlug(canonical), 400);
  }

  const emailParam = url.searchParams.get("email");
  const normalized = normalizeEmail(emailParam);

  // Sem e-mail: `?entrar=1` é a porta explícita do form de login (link "Já é
  // cadastrado?" do bloco de conversão) — sem ela cairia no trecho de novo,
  // um laço que deixaria o form inalcançável. Mesmo padrão de `?entrar=1` do
  // artigo mensal (#7580).
  if (!normalized) {
    if (url.searchParams.has("entrar")) return htmlResponse(renderEmailForm(slug, canonical));
    return teaserResponse(env, slug, canonical);
  }

  // Rate-limit só no caminho que CONSULTA o Kit — anti-abuso contra quem
  // testar e-mails em massa pra tentar diferenciar "não cadastrado" de
  // "verificação falhou" pela LATÊNCIA (o anti-probing de resposta não cobre
  // timing side-channel; o rate-limit reduz a superfície de tentativas).
  if (env.RATE_LIMIT) {
    const ip = clientIpFromRequest(request);
    const rl = await checkKvRateLimit(env.RATE_LIMIT, `rl:anual-gate:${ip}`, GATE_RATE_LIMIT, GATE_RATE_WINDOW_SEC);
    if (!rl.allowed) return htmlResponse(renderRateLimited(canonical), 429);
  }

  // Sem KIT_API_KEY configurada: fail-closed — trata como falha de
  // verificação (`kitState: null`), NUNCA como "cadastrado" por omissão.
  const kitState = env.KIT_API_KEY
    ? await verifySubscriberViaKitByEmail(env.KIT_API_KEY, normalized, { fetchImpl })
    : null;
  const decision = decideGate(normalized, kitState);

  if (decision.state !== "allowed") {
    // `not_registered` cobre não-cadastrado, desconhecido E falha de
    // verificação — MESMA resposta nos três casos (anti-probing).
    return teaserResponse(env, slug, canonical);
  }

  const article = await loadArticle(env, slug);
  if (!article) {
    return htmlResponse(renderSlugNotFound(slug, canonical), 404);
  }
  return htmlResponse(article);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const redirect = resolveWorkersDevRedirect(request.url, new URL(ANUAL_HOST).host, request.method);
    if (redirect.shouldRedirect) {
      return Response.redirect(redirect.location, redirect.status);
    }

    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "method not allowed", allowed: ["GET"] }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }
    const url = new URL(request.url);
    if (url.pathname === "/sitemap.xml") {
      return sitemapResponse();
    }
    if (url.pathname === "/robots.txt") {
      return robotsResponse();
    }
    return handleGet(request, env);
  },
};

export { normalizeEmail };
