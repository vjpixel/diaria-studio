/**
 * site-archive-index.ts (#8353 item 2)
 *
 * Miolo puro do índice PAGINADO do acervo no apex — `diar.ia.br/archive`,
 * `/archive/2`, … — gerado por `scripts/gen-archive-index.ts` como static
 * assets do Worker `workers/site` (mesmo padrão de `/p/{slug}`, `/clarice`,
 * `/assinar`: HTML commitado, nenhum handler novo em `src/index.ts`).
 *
 * ## Por que esta superfície existe, se `arquivo.diar.ia.br` já lista tudo
 *
 * Medição da issue (18/09/2026): `https://diar.ia.br/archive` responde 404,
 * a home linka 7 das 270 edições, e o relatório semanal
 * (`index-status-arquivo-2026-09-13.md`) marca 40 URLs ÓRFÃS (0 referrer) e
 * 110 sem referrer HTML. As 270 páginas só são alcançáveis hoje por
 * `sitemap.xml` (que não passa link equity nenhum) e por
 * `arquivo.diar.ia.br` — **outro host**, que deriva o acervo do sitemap do
 * apex em request-time. Um índice no PRÓPRIO apex é o que dá a cada
 * `/p/{slug}` um link HTML interno, no mesmo domínio, a 1–2 cliques da raiz.
 * Não substitui `arquivo.diar.ia.br` (que tem hubs por tema e busca
 * própria); o índice linka pra lá no rodapé.
 *
 * `/archive` e não `/edicoes`: é o path que a issue cita primeiro e o único
 * que já é pedido no ar hoje (o 404 medido) — trocar por um path novo em
 * português deixaria o 404 existente de pé e ainda exigiria um redirect.
 *
 * ## Fonte de dado (a MESMA da home, de propósito)
 *
 * `buildArchiveIndexFeed` chama `buildHomeFeed` (`site-home-page.ts`) sem
 * limite — `sitemap.xml` + `public/p/{slug}/index.html` já commitados. Nada
 * de `data/` (ausente em clone fresco/worktree), nada de fonte nova:
 *
 *   - **ordenação por DATA EDITORIAL desc**, resolvida por `<lastmod>` do
 *     sitemap ou, na falta dele, por `article:published_time`/`datePublished`
 *     da própria página (#8360). As duas nascem de
 *     `publishDateToIso`/`resolvePublishTimestampMs`, que honram
 *     `beehiiv-publish-date-overrides.json` (#4796) — por isso as edições
 *     importadas em bloco em 04/09/2025 aparecem em agosto/2025, onde foram
 *     de fato enviadas, e não todas empilhadas em setembro como o
 *     `publish_date` cru diria. É a MESMA ordem que o prev/next por data do
 *     #8395 (item 1 desta issue) usa em cada página — índice e nav nunca
 *     discordam de quem vem antes de quem.
 *   - **título** de `<title>` e **linha fina** de `<meta name="dek">`
 *     (`deriveDek`, #7921) — os mesmos campos que a home e a listagem de
 *     `arquivo.diar.ia.br` exibem. Nenhuma leitura nova de
 *     `titles-cache.json`: aquele cache é o atalho de quem NÃO tem as
 *     páginas em disco (o Worker `arquivo`, que roda em outro host); aqui as
 *     270 páginas estão do lado, já com o dek resolvido no `<head>`.
 *   - **edição com data futura fica de fora** (mesmo filtro `todayBrt` do
 *     #7686 que a home usa — o Stage 6 publica a página na noite anterior).
 */

import { escHtml } from "./html-escape.ts";
import { renderAnalyticsHead, renderSeoMeta } from "./shared/seo-meta.ts";
import { COLORS } from "./shared/design-tokens.ts";
import { COVER_IMAGE_WIDTH, COVER_IMAGE_HEIGHT } from "./shared/cover-image.ts";
import { GEO_AUTHOR } from "./shared/geo-faq.ts";
import { ARCHIVE_BASE_URL } from "./site-archive-pages.ts";
import { SITE_FEED_URL } from "./site-feed.ts";
import { renderSiteNav } from "./shared/site-nav.ts"; // #8497: menu global
import {
  buildHomeFeed,
  extractHeroImage,
  formatDateLong,
  type BuildHomeFeedOptions,
  type HomeFeedEntry,
} from "./site-home-page.ts";

/**
 * Edições por página. 30 → 9 páginas pras 270 de hoje.
 *
 * Alto o bastante pra que o acervo inteiro fique a 2 cliques da raiz (home →
 * `/archive` → qualquer página numerada, todas linkadas na paginação), e
 * baixo o bastante pra cada página continuar sendo um documento leve (lista
 * textual, sem capa — ver `omitImages` em `buildArchiveIndexFeed`).
 */
export const ARCHIVE_INDEX_PAGE_SIZE = 30;

/** Path público (sem host) da página `n` do índice — 1 é `/archive`, sem sufixo. */
export function archiveIndexPath(page: number): string {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`archiveIndexPath: página inválida (${page}) — esperado inteiro >= 1`);
  }
  return page === 1 ? "/archive" : `/archive/${page}`;
}

/** URL canônica absoluta da página `n` do índice. */
export function archiveIndexUrl(page: number): string {
  return `${ARCHIVE_BASE_URL}${archiveIndexPath(page)}`;
}

/**
 * Caminho do arquivo gerado, relativo a `workers/site/public/` — `/archive`
 * vira `archive/index.html` e `/archive/2` vira `archive/2/index.html`.
 * `html_handling = "drop-trailing-slash"` (workers/site/wrangler.toml) faz
 * os dois serem servidos na forma SEM barra, que é a canônica declarada
 * aqui.
 */
export function archiveIndexFilePath(page: number): string {
  return page === 1 ? "archive/index.html" : `archive/${page}/index.html`;
}

/**
 * Feed completo do acervo (mais recente primeiro) — ver docstring do módulo
 * pro porquê de reusar `buildHomeFeed` em vez de reler o cache.
 *
 * `omitImages` pula a capa: o índice é lista textual, e sem isso a geração
 * cuspiria ~195 warns de "sem `<img class="hero">`" que não são sintoma de
 * nada nesta superfície.
 */
export function buildArchiveIndexFeed(
  sitemapXml: string,
  readPageHtml: (slug: string) => string | null,
  opts: BuildHomeFeedOptions = {},
): HomeFeedEntry[] {
  return buildHomeFeed(sitemapXml, readPageHtml, Number.MAX_SAFE_INTEGER, { ...opts, omitImages: true });
}

/** Nº total de páginas do índice pra `total` edições — sempre >= 1 (acervo vazio ainda rende `/archive`). */
export function archiveIndexPageCount(total: number, pageSize = ARCHIVE_INDEX_PAGE_SIZE): number {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`archiveIndexPageCount: pageSize inválido (${pageSize}) — esperado inteiro >= 1`);
  }
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Fatia as edições da página `page` (1-based). Página fora do range devolve
 * `[]` — quem gera nunca pede uma (itera `1..archiveIndexPageCount`), e o
 * comportamento no AR pra `/archive/999` é 404 do próprio asset lookup
 * (não existe arquivo), nunca uma página vazia publicada.
 */
export function archiveIndexPageEntries(
  entries: HomeFeedEntry[],
  page: number,
  pageSize = ARCHIVE_INDEX_PAGE_SIZE,
): HomeFeedEntry[] {
  if (!Number.isInteger(page) || page < 1) return [];
  return entries.slice((page - 1) * pageSize, page * pageSize);
}

/**
 * Rótulo de mês/ano em pt-BR a partir de `YYYY-MM-DD` — "agosto de 2025".
 * `null` pra data ausente/malformada: o grupo dessas entradas sai sem
 * cabeçalho (`""`), nunca com "undefined de NaN".
 */
export function monthLabel(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const months = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  ];
  return `${months[m - 1]} de ${y}`;
}

/**
 * Capa de compartilhamento do índice (#8353, finding 2 do self-review da
 * PR #8399): a capa da edição MAIS RECENTE do acervo — mesma escolha que o
 * `og:image` da raiz de `arquivo.diar.ia.br` já faz desde o #5131 (a capa
 * mais viva disponível, sem asset de marca novo pra manter).
 *
 * A MESMA imagem vai nas N páginas do índice de propósito: as 9 páginas são
 * uma superfície só (o acervo), e uma capa por página faria o card de
 * `/archive/7` mudar toda vez que uma edição entrasse e empurrasse a
 * paginação.
 *
 * `null` (edição sem `<img class="hero">`, página ausente) omite
 * `og:image`/`twitter:image` e mantém `twitter:card=summary` — exatamente o
 * que `renderSeoMeta` faz sem `image`, nunca uma tag com URL vazia.
 *
 * Devolve sempre URL ABSOLUTA: a capa vive no próprio Worker e o `<img>` da
 * página a referencia como path relativo (`/img/…`, #7011), mas unfurler
 * (Slack, WhatsApp, X) não resolve `og:image` relativo — seria o mesmo card
 * sem imagem que este fix existe pra tirar.
 */
export function resolveArchiveIndexCover(
  entries: HomeFeedEntry[],
  readPageHtml: (slug: string) => string | null,
): string | null {
  const newest = entries[0];
  if (!newest) return null;
  const src = extractHeroImage(readPageHtml(newest.slug) ?? "");
  if (!src) return null;
  return src.startsWith("/") ? `${ARCHIVE_BASE_URL}${src}` : src;
}

function renderEntry(entry: HomeFeedEntry): string {
  const date = formatDateLong(entry.date);
  const dateHtml = entry.date && date ? `<time datetime="${escHtml(entry.date)}">${escHtml(date)}</time>` : "";
  const dek = entry.description ? `<p class="edition-dek">${escHtml(entry.description)}</p>` : "";
  return `      <li class="edition">
        <div class="edition-meta">${dateHtml}</div>
        <h3 class="edition-title"><a href="${escHtml(entry.url)}">${escHtml(entry.title)}</a></h3>
        ${dek}
      </li>`;
}

/**
 * Agrupa as entradas da página por mês editorial PRESERVANDO a ordem
 * recebida (o feed já vem desc) — nunca reordena nem reagrupa entradas do
 * mesmo mês que estejam separadas na lista. Entrada sem data entra no grupo
 * corrente sem cabeçalho novo.
 */
function renderEntries(entries: HomeFeedEntry[]): string {
  const blocks: string[] = [];
  let currentLabel: string | null = null;
  let open = false;
  for (const entry of entries) {
    const label = monthLabel(entry.date);
    if (label && label !== currentLabel) {
      if (open) blocks.push("    </ul>");
      blocks.push(`    <h2 class="month">${escHtml(label)}</h2>`);
      blocks.push('    <ul class="editions">');
      currentLabel = label;
      open = true;
    } else if (!open) {
      blocks.push('    <ul class="editions">');
      open = true;
    }
    blocks.push(renderEntry(entry));
  }
  if (open) blocks.push("    </ul>");
  return blocks.join("\n");
}

/**
 * Paginação: TODAS as páginas linkadas, não só prev/next. São 9 páginas
 * hoje (e ~1 a mais a cada 30 edições, ~6 semanas) — listar todas mantém o
 * acervo inteiro a 2 cliques da raiz, que é exatamente o que a issue mede
 * como quebrado (40 URLs órfãs). Prev/next sozinhos deixariam a página 9 a
 * 8 cliques de distância, profundidade que um crawler tende a não
 * percorrer.
 */
function renderPagination(page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const links: string[] = [];
  if (page > 1) {
    links.push(`<a class="page-nav" rel="prev" href="${archiveIndexPath(page - 1)}">← anterior</a>`);
  }
  for (let n = 1; n <= totalPages; n++) {
    links.push(
      n === page
        ? `<span class="page-num page-num--current" aria-current="page">${n}</span>`
        : `<a class="page-num" href="${archiveIndexPath(n)}">${n}</a>`,
    );
  }
  if (page < totalPages) {
    links.push(`<a class="page-nav" rel="next" href="${archiveIndexPath(page + 1)}">próxima →</a>`);
  }
  return `<nav class="pagination" aria-label="Paginação do acervo">\n      ${links.join("\n      ")}\n    </nav>`;
}

export interface BuildArchiveIndexHtmlOptions {
  /** Edições DESTA página, já fatiadas e na ordem final (mais recente primeiro). */
  entries: HomeFeedEntry[];
  /** 1-based. */
  page: number;
  totalPages: number;
  /** Total de edições no acervo inteiro (todas as páginas) — só pro subtítulo. */
  totalEditions: number;
  /**
   * URL absoluta da capa de compartilhamento (`resolveArchiveIndexCover`).
   * Ausente/`null`: `og:image`/`twitter:image` omitidos e
   * `twitter:card=summary`, igual a qualquer caller de `renderSeoMeta` sem
   * `image`.
   */
  coverImage?: string | null;
}

export function buildArchiveIndexHtml(opts: BuildArchiveIndexHtmlOptions): string {
  const { entries, page, totalPages, totalEditions, coverImage } = opts;
  if (!Number.isInteger(page) || page < 1 || page > Math.max(1, totalPages)) {
    throw new Error(`buildArchiveIndexHtml: página ${page} fora do range 1..${totalPages}`);
  }
  const pageSuffix = page > 1 ? ` — página ${page} de ${totalPages}` : "";
  // "diar.ia.br" entra UMA vez, no fim (o `<title>` abaixo não acrescenta
  // outro sufixo de marca) — "Todas as edições da diar.ia.br — página 9 de
  // 9 — diar.ia.br" repetia a marca duas vezes no mesmo título.
  const title = `Todas as edições${pageSuffix} — diar.ia.br`;
  // Description por página, nunca a mesma string nas 9 (duplicate meta
  // description é exatamente o que o Search Console reporta como conteúdo
  // duplicado num índice paginado).
  const description =
    page > 1
      ? `Arquivo completo da diar.ia.br: ${totalEditions} edições sobre inteligência artificial, da mais recente à mais antiga. Página ${page} de ${totalPages}.`
      : `Arquivo completo da diar.ia.br: ${totalEditions} edições sobre inteligência artificial, da mais recente à mais antiga.`;
  const canonical = archiveIndexUrl(page);
  const relPrev = page > 1 ? `<link rel="prev" href="${archiveIndexUrl(page - 1)}">\n` : "";
  const relNext = page < totalPages ? `<link rel="next" href="${archiveIndexUrl(page + 1)}">\n` : "";
  // #8353 (finding 2 do self-review da PR #8399): o `<head>` montado à mão
  // aqui declarava og:type/title/description/url e NENHUM
  // `og:image`/`twitter:card` — compartilhar `/archive` rendia card sem
  // imagem, ao contrário de `/p/{slug}` (#8352). Passa a sair do MESMO
  // `renderSeoMeta` das outras superfícies, que também traz canonical,
  // favicon e o bloco twitter:* completo.
  const seoMeta = renderSeoMeta({
    title,
    description,
    url: canonical,
    feed: { url: SITE_FEED_URL }, // #8333
    image: coverImage
      ? { url: coverImage, width: COVER_IMAGE_WIDTH, height: COVER_IMAGE_HEIGHT }
      : undefined,
  });

  return `<!--
  workers/site/public/${archiveIndexFilePath(page)} (#8353 item 2)

  Índice paginado do acervo no apex — ver docstring de
  scripts/lib/site-archive-index.ts pro racional completo.

  Gerado por \`npx tsx scripts/gen-archive-index.ts\` a partir de
  \`workers/site/public/sitemap.xml\` + \`public/p/{slug}/index.html\` — não
  editar direto (a próxima geração sobrescreve).
-->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
${relPrev}${relNext}${seoMeta}
<style>
:root {
  --teal: ${COLORS.brand};
  --teal-deep: #007a7a;
  --ink: ${COLORS.ink};
  --ink-soft: rgba(23,20,17,0.72);
  --ink-faint: rgba(23,20,17,0.5);
  --paper: ${COLORS.paper};
  --rule: ${COLORS.rule};
}
* { box-sizing: border-box; }
body {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 72px; }
.top { font-size: 13px; color: var(--ink-faint); margin: 0 0 28px; }
h1 { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(28px, 6vw, 40px); letter-spacing: -0.02em; margin: 0 0 10px; }
.dot { color: var(--teal); }
.lede { font-size: 15px; color: var(--ink-soft); margin: 0 0 36px; }
.month {
  font-family: 'Geist Mono', 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.16em; font-weight: 500;
  color: var(--teal-deep); margin: 36px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--rule);
}
.editions { list-style: none; margin: 0; padding: 0; }
.edition { padding: 16px 0; border-bottom: 1px solid var(--rule); }
.edition-meta { font-size: 12px; color: var(--ink-faint); margin-bottom: 4px; }
.edition-title { font-family: Georgia, 'Times New Roman', serif; font-size: 19px; font-weight: 500; line-height: 1.3; margin: 0; }
.edition-title a { text-decoration: none; }
.edition-title a:hover { color: var(--teal-deep); text-decoration: underline; text-underline-offset: 3px; }
.edition-dek { font-size: 14px; color: var(--ink-soft); margin: 6px 0 0; }
.pagination { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 40px 0 0; }
.page-num, .page-nav {
  display: inline-block; min-width: 34px; text-align: center; padding: 7px 10px;
  border: 1px solid var(--rule); border-radius: 999px; font-size: 13px; text-decoration: none;
}
.page-num--current { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.page-nav { padding: 7px 14px; }
.foot { margin: 44px 0 0; font-size: 13px; color: var(--ink-faint); display: flex; gap: 18px; flex-wrap: wrap; }
.foot a { text-decoration: underline; text-underline-offset: 3px; }
</style>
${renderAnalyticsHead()}
</head>
<body>
  ${renderSiteNav({ active: "edicoes", inheritHostTokens: true })}
  <main class="wrap">
    <p class="top"><a href="/">← diar<span class="dot">.</span>ia<span class="dot">.</span>br</a></p>
    <h1>Todas as edições</h1>
    <p class="lede">${escHtml(String(totalEditions))} edições da diar.ia.br — a newsletter diária de inteligência artificial em português, por ${escHtml(GEO_AUTHOR.name)}. Da mais recente à mais antiga${page > 1 ? `, página ${page} de ${totalPages}` : ""}.</p>
${renderEntries(entries)}
    ${renderPagination(page, totalPages)}
    <div class="foot">
      <a href="/">Página inicial</a>
      <a href="/assinar">Assinar</a>
      <a href="https://arquivo.diar.ia.br/">Buscar por tema</a>
    </div>
  </main>
</body>
</html>
`;
}
