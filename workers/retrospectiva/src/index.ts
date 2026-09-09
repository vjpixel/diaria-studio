/**
 * workers/retrospectiva/src/index.ts (#7581, unificado em #7658)
 *
 * Serve as TRÊS retrospectivas num domínio só — `retrospectiva.diar.ia.br` —
 * com o gate decidido pelo FORMATO do path:
 *
 *   | path               | conteúdo                  | gate            |
 *   |--------------------|---------------------------|-----------------|
 *   | `/AAMM`            | Retrospectiva do Mês      | apoio R$25+     |
 *   | `/AAAA`            | retrospectiva anual       | cadastro grátis |
 *   | `/aniversarioAAAA` | retrospectiva de aniversário | cadastro grátis |
 *
 * Antes do #7658 eram dois Workers com dois esquemas de URL
 * (`anual.diar.ia.br/{slug}` e `artigo.diar.ia.br/{ciclo}`) e dois nomes de
 * diretório que colidiam com o Artigo Especial (`workers/artigos` ×
 * `workers/artigo-mensal`, produtos e gates distintos). Este worker é o
 * `workers/anual` renomeado — a base mais completa das duas (rate-limit,
 * sitemap, robots, anti-probing) — absorvendo o mensal.
 *
 * `especial.diar.ia.br` (`workers/artigos`, Artigo Especial, apoio R$10+)
 * NÃO entra aqui: é outro produto, outro tier e outro mecanismo de gate
 * (KV por hash de e-mail + cookie de sessão).
 *
 * ## Dois gates, um roteador
 *
 * A classificação do path é `classifyRetrospectivaPath`
 * (`scripts/lib/shared/retrospectiva-path.ts`, #7658) — módulo PURO
 * compartilhado com os publishers, justamente pra que a chave gravada no KV e
 * a chave lida aqui não possam divergir. Ele também resolve a colisão real
 * entre `/AAMM` e `/AAAA` (os dois são 4 dígitos).
 *
 *   - `gate: "cadastro"` → verificação contra o Kit (assinante `active`),
 *     `gate-cadastro.ts` + `render-anual.ts`. Rate-limit por IP no caminho
 *     que consulta o Kit.
 *   - `gate: "apoio-mantenedor"` → allowlist de e-mails de Mantenedor/Patrono
 *     no KV (`ALLOWLIST["emails"]`, populada por
 *     `scripts/build-apoiador-allowlist.ts`), `gate-apoio.ts` +
 *     `render-mensal.ts`.
 *
 * Os dois são **fail-closed**: qualquer ambiguidade (KV fora do ar, Kit
 * indisponível, allowlist corrompida, e-mail ausente) nunca serve a edição
 * completa. O gate de cadastro é, além disso, **anti-probing**: não-cadastrado,
 * estado desconhecido e falha de verificação devolvem a MESMA resposta.
 *
 * ## Hosts antigos → 301
 *
 * `anual.diar.ia.br/{slug}` e `artigo.diar.ia.br/{ciclo}` continuam
 * respondendo, por este mesmo Worker, com redirect permanente pro path novo.
 * Os links antigos já saíram em e-mail com UTM — quebrar perde clique e mede
 * errado. A tradução usa `anualPathFromSlug`/`mensalPathFromCycle`, as mesmas
 * funções puras que os publishers usam, e não um mapa à mão por edição.
 *
 * Rotas (no host canônico):
 *   GET /{path}            → sem `?email=`: trecho + convite (cadastro ou apoio)
 *   GET /{path}?email=...  → passou no gate: edição completa do KV
 *   GET /{path}?entrar=1   → form "já é cadastrado/apoiador? entre com seu e-mail"
 *   GET /                  → 400 (path obrigatório)
 *   GET /sitemap.xml       → paths com trecho publicado
 *   GET /robots.txt        → robots.txt próprio (#4777)
 *   * outros métodos       → 405
 */
import { normalizeEmail, decideCadastroGate } from "./gate-cadastro.ts";
import { parseAllowlist, decideApoioGate } from "./gate-apoio.ts";
import * as anual from "./render-anual.ts";
import * as mensal from "./render-mensal.ts";
import {
  classifyRetrospectivaPath,
  anualPathFromSlug,
  mensalPathFromCycle,
  type RetrospectivaPath,
} from "../../../scripts/lib/shared/retrospectiva-path.ts"; // #7658
import { renderCuradoriaRobotsTxt } from "../../../scripts/lib/shared/robots-txt.ts"; // #4777
import { resolveWorkersDevRedirect } from "../../../scripts/lib/shared/workers-dev-redirect.ts"; // #5104
import { verifySubscriberViaKitByEmail } from "../../../scripts/lib/shared/subscriber-verify.ts"; // #6048
import { checkKvRateLimit, clientIpFromRequest } from "../../../scripts/lib/shared/rate-limit.ts"; // #4052
import {
  deriveDescription,
  extractTitleText,
  buildRetrospectivaJsonLd,
  injectRetrospectivaHeadMeta,
} from "../../../scripts/lib/shared/retrospectiva-seo.ts"; // #7720

/** Host canônico — usado na `Sitemap:` do robots.txt, no `canonical`/`og:url`
 *  das páginas, e como destino dos redirects (legado e `.workers.dev`). */
export const RETROSPECTIVA_HOST = "https://retrospectiva.diar.ia.br";

/** Hosts que este Worker atende SÓ para redirecionar (#7658). */
export const LEGACY_ANUAL_HOST = "anual.diar.ia.br";
export const LEGACY_MENSAL_HOST = "artigo.diar.ia.br";

export interface Env {
  /** HTML pré-renderizado das 3 retrospectivas, sob `article:{path}` e
   *  `article:{path}:teaser` — namespace ÚNICO desde o #7658: a chave já
   *  distingue mensal de anual pelo próprio formato do path. */
  ARTICLES: KVNamespace;
  /** Allowlist de e-mails com apoio Mantenedor/Patrono (`emails`, JSON array).
   *  Só o gate de `/AAMM` consulta. */
  ALLOWLIST?: KVNamespace;
  /** Rate-limit do gate por IP. Opcional — ausência nunca bloqueia a request,
   *  só desliga o rate-limit (fail-open no MECANISMO de defesa, nunca no
   *  conteúdo servido — os gates continuam fail-closed). */
  RATE_LIMIT?: KVNamespace;
  KIT_API_KEY?: string;
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

/**
 * Paths com trecho público, do mais recente para o mais antigo — lista
 * explícita, mesmo racional de antes do #7658: `list()` no KV custaria uma
 * chamada por request de sitemap e traria também paths sem trecho publicado.
 * Acrescentar um path aqui é o que o torna descobrível; publicar o `:teaser`
 * no KV é o que o torna legível — os dois são deliberados.
 *
 * Os 4 ciclos mensais aqui são os MESMOS que o `artigo-mensal` já listava
 * (`CICLOS_COM_TRECHO`, #7580), traduzidos pro path novo. A #7658 levanta como
 * pergunta em aberto se o trecho PAGO deve mesmo ser indexado — mas essa
 * decisão já tinha sido tomada no #7580 (e o host já está submetido ao GSC), e
 * uma migração de domínio não é o lugar de revertê-la em silêncio: o que muda
 * aqui é ONDE o conteúdo mora, não o que é indexável. Se o editor decidir tirar
 * o mensal do índice, é uma linha nesta lista.
 *
 * A anual entra quando tiver trecho publicado — hoje nenhuma tem.
 */
export const PATHS_COM_TRECHO: readonly string[] = ["2608", "2607", "2606", "2605"];

function buildSitemapXml(): string {
  const urls = PATHS_COM_TRECHO.map(
    (p) => `  <url>
    <loc>${RETROSPECTIVA_HOST}/${p}</loc>
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

const ROBOTS_TXT = renderCuradoriaRobotsTxt(`${RETROSPECTIVA_HOST}/sitemap.xml`);

function robotsResponse(): Response {
  return new Response(ROBOTS_TXT, {
    status: 200,
    headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

/** Rate-limit do gate: N verificações por IP por janela — mesmo teto de
 *  `GATE_RATE_LIMIT` (#4052/#4054). Só se aplica ao caminho que consulta o
 *  Kit (`?email=` presente num path de gate de cadastro). */
export const GATE_RATE_LIMIT = 8;
export const GATE_RATE_WINDOW_SEC = 3600; // 1h

/** Lê o HTML completo da edição. `null` se ausente ou erro de leitura. */
export async function loadArticle(env: Env, path: string): Promise<string | null> {
  try {
    return await env.ARTICLES.get(`article:${path}`);
  } catch (e) {
    console.error(`[retrospectiva] falha lendo article:${path}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Lê o TRECHO público. `null` se ausente ou erro de leitura — cai no paywall
 *  seco, nunca no completo. */
export async function loadArticleTeaser(env: Env, path: string): Promise<string | null> {
  try {
    return await env.ARTICLES.get(`article:${path}:teaser`);
  } catch (e) {
    console.error(`[retrospectiva] falha lendo article:${path}:teaser: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Pura: traduz uma URL de host LEGADO para o path novo, ou `null` quando não
 * há tradução possível (path que não casa o formato antigo).
 *
 * Devolve só o path (com `/` inicial), preservando a query — os links antigos
 * carregam UTM, e perder isso na migração mediria errado exatamente o tráfego
 * que a migração quer preservar.
 *
 * @pure
 */
export function legacyRedirectPath(host: string, pathname: string, search: string): string | null {
  const slug = decodeURIComponent(pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!slug) return `/${search}`;
  let novo: string | null = null;
  if (host === LEGACY_ANUAL_HOST) novo = anualPathFromSlug(slug);
  else if (host === LEGACY_MENSAL_HOST) novo = mensalPathFromCycle(slug);
  // Intraduzível: manda pra raiz, mas COM a query. A 1ª versão devolvia `null`
  // e o caller montava `/` seco — perdendo o UTM justamente no caminho em que
  // o link antigo já estava errado, que é onde saber a origem mais ajuda
  // (achado do silent-failure-hunter no review da #7709).
  if (!novo) return search ? `/${search}` : null;
  return `/${novo}${search}`;
}

/**
 * Injeta `description`/`canonical`/JSON-LD no HTML já renderizado do trecho
 * (#7720) — a mesma página que os 3 sinais faltavam nas 5 edições medidas.
 * `descriptionSource` é o teaser CRU (antes do bloco de conversão), não o
 * `rendered` final: descrever a página pela copy do CTA ("apoie a diária")
 * em vez do conteúdo real seria pior que a description ausente que já havia.
 *
 * Fail-soft por herança de `injectRetrospectivaHeadMeta` — HTML sem `</head>`
 * nunca derruba a resposta, só sai sem os 3 sinais (mesmo que já era o
 * estado antes desta unidade).
 */
function injectSeo(
  rendered: string,
  descriptionSource: string,
  canonical: string,
  isAccessibleForFree: boolean,
  paywallCssSelector?: string,
): string {
  const headline = extractTitleText(descriptionSource) ?? "Retrospectiva diar.ia.br";
  const description = deriveDescription(descriptionSource);
  const jsonLd = buildRetrospectivaJsonLd({ headline, description, url: canonical, isAccessibleForFree, paywallCssSelector });
  return injectRetrospectivaHeadMeta(rendered, { description, canonical, jsonLd });
}

/** Página servida a quem NÃO passou no gate de CADASTRO (sem e-mail,
 *  não-cadastrado, OU falha de verificação — anti-probing).
 *
 *  `/AAAA` e `/aniversarioAAAA` são gate de CADASTRO grátis, não paywall
 *  (#7658/#7715) — `isAccessibleForFree: true`, sem `hasPart` (#7720). */
async function cadastroTeaserResponse(env: Env, path: string, canonical: string): Promise<Response> {
  const teaser = await loadArticleTeaser(env, path);
  if (!teaser) return htmlResponse(anual.renderNoTeaser(canonical));
  try {
    const rendered = anual.renderTeaserWithSignup(teaser, canonical);
    return htmlResponse(injectSeo(rendered, teaser, canonical, true));
  } catch (e) {
    console.error(`[retrospectiva] trecho presente mas não injetável: ${e instanceof Error ? e.message : e}`);
    return htmlResponse(anual.renderNoTeaser(canonical));
  }
}

async function handleCadastro(
  request: Request,
  env: Env,
  classified: RetrospectivaPath,
  canonical: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const path = classified.slug;
  const normalized = normalizeEmail(url.searchParams.get("email"));

  if (!normalized) {
    if (url.searchParams.has("entrar")) return htmlResponse(anual.renderEmailForm(path, canonical));
    return cadastroTeaserResponse(env, path, canonical);
  }

  // Rate-limit só no caminho que CONSULTA o Kit — anti-abuso contra quem
  // testar e-mails em massa pra tentar diferenciar "não cadastrado" de
  // "verificação falhou" pela LATÊNCIA.
  if (env.RATE_LIMIT) {
    const ip = clientIpFromRequest(request);
    const rl = await checkKvRateLimit(env.RATE_LIMIT, `rl:retrospectiva-gate:${ip}`, GATE_RATE_LIMIT, GATE_RATE_WINDOW_SEC);
    if (!rl.allowed) return htmlResponse(anual.renderRateLimited(canonical), 429);
  }

  // Sem KIT_API_KEY: fail-closed — trata como falha de verificação, NUNCA
  // como "cadastrado" por omissão.
  const kitState = env.KIT_API_KEY
    ? await verifySubscriberViaKitByEmail(env.KIT_API_KEY, normalized, { fetchImpl })
    : null;

  if (decideCadastroGate(normalized, kitState).state !== "allowed") {
    return cadastroTeaserResponse(env, path, canonical);
  }

  const article = await loadArticle(env, path);
  if (!article) return htmlResponse(anual.renderSlugNotFound(path, canonical), 404);
  return htmlResponse(article);
}

/**
 * Página servida a quem NÃO passou no gate de APOIO — sem e-mail ou com e-mail
 * fora da allowlist, indistintamente, como no `artigo-mensal` antes da
 * unificação: trecho + bloco de conversão quando há trecho no KV, paywall seco
 * quando não há (ou quando o trecho não é injetável).
 *
 * O paywall seco é o fallback, NUNCA o form de e-mail: o form é a porta de
 * quem já apoia (`?entrar=1`), e mostrá-lo como primeira tela troca a página
 * que VENDE por um campo de login — inversão que o #7580 tratou de desfazer.
 *
 * `/AAMM` é o produto PAGO do domínio (apoio Mantenedor R$25+) — JSON-LD leva
 * `isAccessibleForFree: false` + `hasPart` marcando `#retrospectiva-paywall`
 * (#7720, ver `retrospectiva-seo.ts` sobre por que esse selector, não o texto
 * pago em si — que nunca chega neste HTML).
 */
async function apoioTeaserResponse(env: Env, path: string, canonical: string): Promise<Response> {
  const teaser = await loadArticleTeaser(env, path);
  if (!teaser) return htmlResponse(mensal.renderPaywall());
  try {
    const rendered = mensal.renderTeaserWithPaywall(teaser);
    return htmlResponse(injectSeo(rendered, teaser, canonical, false, "#retrospectiva-paywall"));
  } catch (e) {
    console.error(`[retrospectiva] trecho mensal não injetável: ${e instanceof Error ? e.message : e}`);
    return htmlResponse(mensal.renderPaywall());
  }
}

async function handleApoio(request: Request, env: Env, classified: RetrospectivaPath, canonical: string): Promise<Response> {
  const url = new URL(request.url);
  const path = classified.slug;
  const normalized = normalizeEmail(url.searchParams.get("email"));

  const querEntrar = url.searchParams.has("entrar");

  // Sem e-mail: trecho + bloco de conversão. `?entrar=1` é a porta explícita
  // do form (senão o link "já apoia?" cairia no trecho de novo).
  if (!normalized) {
    if (querEntrar) return htmlResponse(mensal.renderEmailForm(path));
    return apoioTeaserResponse(env, path, canonical);
  }
  if (querEntrar) return htmlResponse(mensal.renderEmailForm(path));

  // Allowlist fail-closed: ausente/corrompida/binding não configurado → `null`
  // → NINGUÉM passa. Nunca serve a edição paga por erro de leitura.
  let raw: string | null = null;
  try {
    raw = env.ALLOWLIST ? await env.ALLOWLIST.get("emails") : null;
  } catch (e) {
    console.error(`[retrospectiva] falha lendo ALLOWLIST: ${e instanceof Error ? e.message : e}`);
  }

  // Reprovado no gate recebe o MESMO tratamento de quem não informou e-mail:
  // trecho + bloco de conversão quando há trecho, paywall seco quando não há.
  // A 1ª versão desta unificação devolvia o paywall seco direto neste ramo,
  // engolindo o trecho pra quem informou um e-mail fora da allowlist — quem
  // mais precisa da amostra pra decidir apoiar (achado do code-reviewer e do
  // silent-failure-hunter no review da #7709).
  if (decideApoioGate(normalized, parseAllowlist(raw)).state !== "allowed") {
    return apoioTeaserResponse(env, path, canonical);
  }

  const article = await loadArticle(env, path);
  if (!article) return htmlResponse(mensal.renderCycleNotFound(path), 404);
  return htmlResponse(article);
}

export async function handleGet(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const classified = classifyRetrospectivaPath(url.pathname);

  if (!classified) {
    // Nunca "chuta" um formato: servir a retrospectiva errada (ou o gate
    // errado) é pior que não servir.
    const canonical = RETROSPECTIVA_HOST;
    return htmlResponse(anual.renderMissingSlug(canonical), 400);
  }

  const canonical = `${RETROSPECTIVA_HOST}/${classified.slug}`;
  return classified.gate === "apoio-mantenedor"
    ? handleApoio(request, env, classified, canonical)
    : handleCadastro(request, env, classified, canonical, fetchImpl);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Hosts legados: 301 pro path novo, preservando a query (UTM). Antes de
    // qualquer outra coisa — inclusive de `/robots.txt`, que no host antigo
    // deve apontar pro canônico.
    if (url.host === LEGACY_ANUAL_HOST || url.host === LEGACY_MENSAL_HOST) {
      const novo = legacyRedirectPath(url.host, url.pathname, url.search);
      return Response.redirect(`${RETROSPECTIVA_HOST}${novo ?? "/"}`, 301);
    }

    const redirect = resolveWorkersDevRedirect(request.url, new URL(RETROSPECTIVA_HOST).host, request.method);
    if (redirect.shouldRedirect) {
      return Response.redirect(redirect.location, redirect.status);
    }

    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "method not allowed", allowed: ["GET"] }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/sitemap.xml") return sitemapResponse();
    if (url.pathname === "/robots.txt") return robotsResponse();
    return handleGet(request, env);
  },
};

export { normalizeEmail };
