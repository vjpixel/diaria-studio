/**
 * workers/arquivo — Cloudflare Worker (#4105).
 *
 * Problema: só 10.8% (24/223) das edições diárias publicadas da Diar.ia
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
 * Rota única: GET / → HTML completo. Qualquer outro path → 404.
 *
 * Falha de fetch/parse do sitemap NUNCA lança sem tratamento — cai numa
 * página de erro simples (502), nunca crash.
 *
 * Próximo passo (fora de escopo deste Worker): linkar esta página a partir
 * de diar.ia.br (Beehiiv Website Builder — 3rd-party hosted, não é código
 * deste repo) pra que o Googlebot de fato a descubra. Ver PR body de #4105.
 */
import { parseSitemap } from "../../../scripts/lib/fetch-sitemap.ts";
import { buildArchiveHtml } from "./render-archive.ts";

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
<title>Arquivo indisponível — Diar.ia</title>
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
