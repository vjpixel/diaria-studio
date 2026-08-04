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
 * Rotas: GET / → HTML completo. GET /sitemap.xml → sitemap estático de 1
 * `<url>` (a própria página, #4546 — descoberta pelo Google; sem `[assets]`
 * neste Worker, então é a rota que precisa servir o XML, diferente de
 * cursos/livros, que servem via `public/sitemap.xml` estático). GET
 * /robots.txt → mesmo raciocínio, mesmo motivo de não poder ser estático
 * (`scripts/lib/shared/robots-txt.ts`, compartilhado com cursos/livros —
 * ver #4546). Qualquer outro path → 404.
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
import { HUB_REGISTRY } from "./hubs/registry.ts"; // #4558 Parte A: hubs temáticos em /temas/{slug}

/**
 * Sitemap PRÓPRIO desta página (#4546) — `PAGE_URL` + 1 `<url>` por hub
 * temático publicado (#4558 Parte A, `HUB_REGISTRY` — cresce sozinho a
 * cada hub novo, sem editar esta lista). NÃO enumera as ~246 edições
 * individuais (essas já vivem no sitemap do host principal,
 * `https://diar.ia.br/sitemap.xml`, consumido acima via `fetchSitemapXml`)
 * — o objetivo aqui é só dar ao Google um caminho de descoberta pra ESTAS
 * páginas, que por sua vez listam `<a href>` reais pra cada edição.
 */
const ARQUIVO_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PAGE_URL}</loc>
  </url>
${Object.keys(HUB_REGISTRY)
  .map((slug) => `  <url>\n    <loc>${PAGE_URL}temas/${slug}</loc>\n  </url>`)
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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      ...(status === 200 ? { "Cache-Control": "public, max-age=3600" } : {}),
    },
  });
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
    if (url.pathname.startsWith("/temas/")) {
      const slug = url.pathname.slice("/temas/".length).replace(/\/$/, "");
      const html = HUB_REGISTRY[slug];
      if (!html) return new Response("Not found", { status: 404 });
      return htmlResponse(html);
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
