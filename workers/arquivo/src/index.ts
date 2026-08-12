/**
 * workers/arquivo — Cloudflare Worker (#4105).
 *
 * Problema: só 10.8% (24/223) das edições diárias publicadas da diar.ia.br
 * estão indexadas pelo Google — o site (hospedado no Beehiiv, domínio
 * canônico diar.ia.br) expõe quase nenhum `<a href>` server-side crawlable
 * pra edições antigas.
 *
 * Decisão do editor (comentário em #4105, opção #1 do research): esta
 * página server-renderiza uma listagem estática de TODAS as edições
 * publicadas, com `<a href>` reais — sem JS client-side, sem paginação —
 * reusando a mesma fonte de dados do sitemap oficial (#761,
 * `scripts/lib/fetch-sitemap.ts`).
 *
 * Deliberadamente simples: sem `[assets]` (o Worker ganhou 1 binding KV no
 * #4902 e a var `INDEXNOW_KEY` no #4909 — não é mais "sem KV, sem secrets"
 * como dizia aqui antes; achado da Fase 1.5 desta rodada) — busca o
 * sitemap a cada request (fetch server-side, sem auth, é público) e
 * renderiza on-the-fly. `Cache-Control: public, max-age=3600` + edge cache
 * do Cloudflare absorvem o resto (o sitemap não muda mais que 1x/dia).
 *
 * Rotas: GET / → HTML completo. GET /sitemap.xml → 1 `<url>` pra esta página
 * (#4546) + 1 `<url>` por hub temático publicado, cada um com `<lastmod>`
 * (#4909 — sem `[assets]` neste Worker, então é a rota que precisa servir o
 * XML, diferente de cursos/livros, que servem via `public/sitemap.xml`
 * estático). GET /robots.txt → mesmo raciocínio, mesmo motivo de não poder
 * ser estático (`scripts/lib/shared/robots-txt.ts`, compartilhado com
 * cursos/livros — ver #4546). GET /{INDEXNOW_KEY}.txt → arquivo de chave do
 * IndexNow (#4909 item 2), só quando a var `INDEXNOW_KEY` está configurada
 * — sem ela, path nenhum casa e o comportamento é idêntico a antes.
 * Qualquer outro path → 404.
 *
 * Falha de fetch/parse do sitemap NUNCA lança sem tratamento — cai numa
 * página de erro simples (502), nunca crash.
 *
 * Próximo passo (fora de escopo deste Worker): linkar esta página a partir
 * de diar.ia.br (Beehiiv Website Builder — 3rd-party hosted, não é código
 * deste repo) pra que o Googlebot de fato a descubra. Ver PR body de #4105.
 */
import { parseSitemap } from "../../../scripts/lib/fetch-sitemap.ts";
import { renderCuradoriaRobotsTxt } from "../../../scripts/lib/shared/robots-txt.ts";
import { matchAiReferrerHost, logAiReferrerHit } from "../../../scripts/lib/shared/ai-referrer-log.ts"; // #4558 Parte C
import {
  matchAiFetchBot,
  aiFetchBotCounterKey,
  aiFetchReferrerCounterKey,
  incrementAiFetchCounter,
} from "../../../scripts/lib/shared/ai-fetch-counters.ts"; // #4902, F-17 do #4558
import { buildArchiveHtml, PAGE_URL } from "./render-archive.ts";
import { HUB_REGISTRY, HUB_LASTMOD } from "./hubs/registry.ts"; // #4558 Parte A: hubs temáticos em /temas/{slug}
import { resolveWorkersDevRedirect } from "../../../scripts/lib/shared/workers-dev-redirect.ts"; // #5097 item D

/**
 * Env do Worker `arquivo` (#4902) — o Worker nasceu "sem KV, sem secrets,
 * sem [assets]" (ver docstring do topo) e este é o 1º binding que ele
 * ganha: reusa `CURSOS_SUBSCRIBERS` (mesmo namespace de `workers/cursos`,
 * `id` em `wrangler.toml`), com prefixo próprio `counter:ai-fetch:` — sem
 * criar namespace novo (ver `scripts/lib/shared/ai-fetch-counters.ts` pro
 * porquê). `KVNamespace | undefined` (não obrigatório): defensivo contra um
 * binding ainda não propagado num ambiente (`workers_dev` preview, etc.) —
 * `incrementAiFetchCounter` é NO-OP silencioso nesse caso, nunca derruba a
 * resposta.
 */
export interface Env {
  CURSOS_SUBSCRIBERS?: KVNamespace;
  /**
   * Chave IndexNow (#4909 item 2) — string opaca gerada pelo editor em
   * indexnow.org/documentation, provisionada como Worker var (`wrangler
   * secret put INDEXNOW_KEY` ou `[vars]`, fora deste repo). Serve o arquivo
   * de chave em `GET /{INDEXNOW_KEY}.txt` (ver `indexNowKeyResponse`
   * abaixo) — é assim que o Bing confirma que quem pinga
   * `api.indexnow.org` é dono do host. `undefined`/ausente: a rota
   * simplesmente não casa com nenhum path (nenhum comportamento novo),
   * mesma disciplina defensiva de `CURSOS_SUBSCRIBERS` acima — permite o
   * Worker rodar sem a var configurada até o editor provisionar a chave.
   */
  INDEXNOW_KEY?: string;
}

/**
 * `<lastmod>` da raiz do sitemap (#4909): a data mais recente entre os hubs
 * publicados — não `new Date()` (o HTML dos hubs é gerado e COMMITADO, ver
 * nota de `hub-page.ts`; um valor dinâmico aqui declararia a página
 * "mudou hoje" mesmo em deploys que não tocaram conteúdo nenhum, o mesmo
 * problema que motivou `publishedDate`/`updatedDate` serem estáticos, #4911).
 * Comparação lexicográfica
 * funciona porque as datas são sempre `YYYY-MM-DD`. `undefined` só se algum
 * dia não houver hub nenhum publicado (nunca aconteceu — `HUB_REGISTRY`
 * nasceu com o primeiro hub).
 */
const ROOT_LASTMOD: string | undefined = Object.values(HUB_LASTMOD).reduce<string | undefined>(
  (max, d) => (max === undefined || d > max ? d : max),
  undefined,
);

/**
 * Sitemap PRÓPRIO desta página (#4546) — `PAGE_URL` + 1 `<url>` por hub
 * temático publicado (#4558 Parte A, `HUB_REGISTRY` — cresce sozinho a
 * cada hub novo, sem editar esta lista). NÃO enumera as ~246 edições
 * individuais (essas já vivem no sitemap do host principal,
 * `https://diar.ia.br/sitemap.xml`, consumido acima via `fetchSitemapXml`)
 * — o objetivo aqui é só dar ao Google um caminho de descoberta pra ESTAS
 * páginas, que por sua vez listam `<a href>` reais pra cada edição.
 * `<lastmod>` por `<url>` (#4909) vem de `HUB_LASTMOD` — mesmo `updatedDate`
 * que já alimenta `dateModified` no JSON-LD de cada hub (#4911), nunca um
 * valor inventado à parte.
 */
const ARQUIVO_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PAGE_URL}</loc>${ROOT_LASTMOD ? `\n    <lastmod>${ROOT_LASTMOD}</lastmod>` : ""}
  </url>
${Object.keys(HUB_REGISTRY)
  .map((slug) => {
    const lastmod = HUB_LASTMOD[slug];
    return `  <url>\n    <loc>${PAGE_URL}temas/${slug}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}\n  </url>`;
  })
  .join("\n")}
</urlset>
`;

function sitemapResponse(): Response {
  return new Response(ARQUIVO_SITEMAP_XML, {
    status: 200,
    headers: {
      "Content-Type": "application/xml;charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * `robots.txt` PRÓPRIO (#4546) — mesmo conteúdo/racional de cursos/livros
 * (ver `scripts/lib/shared/robots-txt.ts`), só que servido dinamicamente
 * porque este Worker não tem `[assets]`. `Sitemap:` aponta pro
 * `/sitemap.xml` deste próprio host, não pro do host principal.
 */
const ARQUIVO_ROBOTS_TXT = renderCuradoriaRobotsTxt(`${PAGE_URL}sitemap.xml`);

function robotsResponse(): Response {
  return new Response(ARQUIVO_ROBOTS_TXT, {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * Arquivo de chave do IndexNow (#4909 item 2) — `GET /{env.INDEXNOW_KEY}.txt`
 * devolve a própria chave em texto puro, exatamente como o protocolo exige
 * (indexnow.org/documentation: "the key location... must simply contain the
 * key"). Mesmo padrão dinâmico de `/sitemap.xml`/`/robots.txt` (Worker sem
 * `[assets]`, então qualquer arquivo estático precisa de rota em código).
 * `key` sempre não-vazia aqui (o dispatch já checou `env.INDEXNOW_KEY`
 * truthy antes de chamar isto).
 */
function indexNowKeyResponse(key: string): Response {
  return new Response(key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

const SITEMAP_URL = "https://diar.ia.br/sitemap.xml";
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Hash não-criptográfico (FNV-1a 32-bit) do corpo, pra `ETag` (#4909). Não
 * precisa ser à prova de colisão adversarial — só precisa mudar quando o
 * conteúdo muda, pra um `If-None-Match` de crawler funcionar. Puramente em
 * JS (sem `crypto.subtle`, que é assíncrono, nem `node:crypto`, que exigiria
 * `nodejs_compat` só pra isto) — mantém `htmlResponse` síncrona.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** `YYYY-MM-DD` → formato RFC 7231 (`Last-Modified`/`If-Modified-Since`).
 * Meia-noite UTC — mesma disciplina de data ESTÁTICA de `hub-page.ts`: não é
 * hora real de publicação, é o dia do `updatedDate`. */
function toHttpDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

interface HtmlResponseOptions {
  /** `YYYY-MM-DD` do `updatedDate` do hub (#4911) — vira header `Last-Modified`. */
  lastModified?: string;
  /** `true` pra emitir `ETag` (hash do `body`). */
  etag?: boolean;
}

function htmlResponse(body: string, status = 200, opts?: HtmlResponseOptions): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html;charset=utf-8",
  };
  if (status === 200) {
    headers["Cache-Control"] = "public, max-age=3600";
    if (opts?.lastModified) headers["Last-Modified"] = toHttpDate(opts.lastModified);
    if (opts?.etag) headers["ETag"] = `"${fnv1aHex(body)}"`;
  }
  return new Response(body, { status, headers });
}

function errorPage(): Response {
  return htmlResponse(
    `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Arquivo indisponível — diar.ia.br</title>
<meta name="robots" content="noindex">
</head>
<body>
  <main>
    <h1>Arquivo temporariamente indisponível</h1>
    <p>Não foi possível carregar a lista de edições agora. Tente novamente em instantes.</p>
  </main>
</body>
</html>
`,
    502,
  );
}

/** Busca o `sitemap.xml` público e retorna o XML cru. Lança em falha
 * (HTTP não-200, timeout, erro de rede) — o caller (`fetch` handler) trata. */
async function fetchSitemapXml(): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SITEMAP_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml, */*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`sitemap fetch HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export default {
  // `env = {}` (default, não obrigatório): `test/arquivo-render.test.ts`
  // chama `worker.fetch(new Request(...))` com 1 argumento só (Env não
  // existia antes do #4902) — default vazio preserva isso sem exigir que
  // cada call site passe um `env` explícito, e casa com o resto do módulo
  // (`incrementAiFetchCounter` já trata KV ausente como no-op).
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    // #5097 item D: fecha o host genérico `arquivo.diaria.workers.dev` —
    // confirmado ao vivo (#5097) servindo 200 com o conteúdo INTEIRO em
    // paralelo ao host canônico. 301 ANTES de qualquer outra lógica (log de
    // Referer, sitemap, robots, hubs) — nenhuma delas deveria rodar quando a
    // resposta certa é só redirecionar.
    const redirect = resolveWorkersDevRedirect(request.url, new URL(PAGE_URL).host);
    if (redirect.shouldRedirect) {
      return Response.redirect(redirect.location!, 301);
    }

    const url = new URL(request.url);
    // #4558 Parte C: log estruturado (Workers Logs) quando o Referer aponta
    // pra um dos 4 assistentes de IA — complemento barato ao monitor de
    // citação (scripts/geo-citation-monitor.ts), já que boa parte do
    // tráfego vindo de assistente chega SEM Referer e cai como "direct".
    // Nunca bloqueia a resposta (try/catch isolado, fail-soft).
    try {
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) {
        logAiReferrerHit("arquivo", aiHost, url.pathname);
        // #4902 item 2: persiste o hit que o log acima já detecta mas não
        // retém (console.log nunca é lido depois — wrangler tail só mostra
        // ao vivo).
        const day = new Date().toISOString().slice(0, 10);
        // await (não fire-and-forget): sem `ctx.waitUntil`, uma promise solta
        // pode ser cancelada quando o execution context termina — mesmo
        // padrão (await direto) de `incrementKvCounter` em
        // `workers/cursos/src/index.ts`.
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchReferrerCounterKey(aiHost, day));
      }
    } catch {
      // logging nunca derruba a página — ver mesma disciplina do
      // catch genérico em handleIndex de workers/cursos/src/index.ts.
    }
    // #4902 item 1: contador de FETCH por bot de recuperação nomeado
    // (OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot,
    // PerplexityBot, Perplexity-User, Googlebot, bingbot) — complementa o
    // log de Referer acima, que só capta a MINORIA do tráfego de assistente
    // que chega com Referer preenchido. Mesmo bloco fail-soft, try/catch
    // isolado — nunca bloqueia a resposta.
    try {
      const bot = matchAiFetchBot(request.headers.get("User-Agent"));
      if (bot) {
        const day = new Date().toISOString().slice(0, 10);
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchBotCounterKey(bot, day));
      }
    } catch {
      // mesma disciplina fail-soft do bloco de Referer acima.
    }
    if (url.pathname === "/sitemap.xml") {
      return sitemapResponse();
    }
    if (url.pathname === "/robots.txt") {
      return robotsResponse();
    }
    // #4909 item 2: arquivo de chave do IndexNow — só casa quando a var
    // está configurada (ver docstring de Env.INDEXNOW_KEY); sem ela, este
    // `if` nunca é verdadeiro e o pathname cai no 404 normal, igual antes.
    if (env.INDEXNOW_KEY && url.pathname === `/${env.INDEXNOW_KEY}.txt`) {
      return indexNowKeyResponse(env.INDEXNOW_KEY);
    }
    // #4558 Parte A: hubs temáticos — HTML já gerado e commitado
    // (`hubs/registry.ts`), servido tal qual, sem fetch/render em runtime.
    // `Object.hasOwn` (não `HUB_REGISTRY[slug]` cru + `!html`) — achado do
    // fleet review da PR: um slug igual a uma propriedade herdada de
    // `Object.prototype` (`constructor`, `toString`, `hasOwnProperty`,
    // `__proto__`) faz o lookup em objeto plano devolver essa função/valor
    // herdado (truthy) em vez de `undefined`, escapando do `if (!html)` e
    // servindo 200 com lixo (`String(Object.prototype.toString)`) em vez do
    // 404 esperado.
    if (url.pathname.startsWith("/temas/")) {
      const slug = url.pathname.slice("/temas/".length).replace(/\/$/, "");
      if (!Object.hasOwn(HUB_REGISTRY, slug)) return new Response("Not found", { status: 404 });
      // #4909: Last-Modified deriva do MESMO updatedDate do hub (#4911,
      // nunca um valor separado) + ETag do conteúdo — sinal de rastreio pra
      // crawler/cache, não fator de citação declarado por nenhum fabricante.
      return htmlResponse(HUB_REGISTRY[slug], 200, { lastModified: HUB_LASTMOD[slug], etag: true });
    }
    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    let xml: string;
    try {
      xml = await fetchSitemapXml();
    } catch (e) {
      console.error(
        "[arquivo] falha ao buscar sitemap:",
        e instanceof Error ? e.message : String(e),
      );
      return errorPage();
    }

    try {
      const entries = parseSitemap(xml);
      return htmlResponse(buildArchiveHtml(entries));
    } catch (e) {
      console.error(
        "[arquivo] sitemap inválido:",
        e instanceof Error ? e.message : String(e),
      );
      return errorPage();
    }
  },
};
