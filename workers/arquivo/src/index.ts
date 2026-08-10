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
 * Deliberadamente simples: sem KV, sem secrets, sem `[assets]` — busca o
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
 * cursos/livros — ver #4546). Qualquer outro path → 404.
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
import { buildArchiveHtml, PAGE_URL } from "./render-archive.ts";
import { HUB_REGISTRY, HUB_LASTMOD } from "./hubs/registry.ts"; // #4558 Parte A: hubs temáticos em /temas/{slug}

/**
 * `<lastmod>` da raiz do sitemap (#4909): a data mais recente entre os hubs
 * publicados — não `new Date()` (o HTML dos hubs é gerado e COMMITADO, ver
 * nota de `hub-page.ts`; um valor dinâmico aqui declararia a página
 * "mudou hoje" mesmo em deploys que não tocaram conteúdo nenhum, o mesmo
 * problema que motivou `contentDate` ser estático). Comparação lexicográfica
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
 * `<lastmod>` por `<url>` (#4909) vem de `HUB_LASTMOD` — mesmo `contentDate`
 * que já alimenta o JSON-LD de cada hub, nunca um valor inventado à parte.
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
 * hora real de publicação, é o dia do `contentDate`. */
function toHttpDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

interface HtmlResponseOptions {
  /** `YYYY-MM-DD` do `contentDate` do hub — vira header `Last-Modified`. */
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
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // #4558 Parte C: log estruturado (Workers Logs) quando o Referer aponta
    // pra um dos 4 assistentes de IA — complemento barato ao monitor de
    // citação (scripts/geo-citation-monitor.ts), já que boa parte do
    // tráfego vindo de assistente chega SEM Referer e cai como "direct".
    // Nunca bloqueia a resposta (try/catch isolado, fail-soft).
    try {
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) logAiReferrerHit("arquivo", aiHost, url.pathname);
    } catch {
      // logging nunca derruba a página — ver mesma disciplina do
      // catch genérico em handleIndex de workers/cursos/src/index.ts.
    }
    if (url.pathname === "/sitemap.xml") {
      return sitemapResponse();
    }
    if (url.pathname === "/robots.txt") {
      return robotsResponse();
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
      // #4909: Last-Modified deriva do MESMO contentDate do hub (nunca um
      // valor separado) + ETag do conteúdo — sinal de rastreio pra
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
