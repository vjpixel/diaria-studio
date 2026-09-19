/**
 * site-archive-page-backfill.ts (#8352, #8353 item 1, #8354, #8359)
 *
 * Miolo puro do backfill de páginas do acervo (`workers/site/public/p/{slug}/
 * index.html`) que já estão no DISCO, escritas por uma versão mais antiga de
 * `buildArchivePageHtml` — sem depender de `data/` (OneDrive, só na máquina do
 * editor) nem de nenhuma credencial de API. Ver `scripts/
 * backfill-archive-page-links-seo.ts` (CLI, faz I/O) e a nota em
 * `gen-archive-pages.ts` sobre por que essas páginas não são varridas pela
 * regeneração normal.
 *
 * ## As duas lacunas que este módulo fecha, e por que reusa código em vez de
 * reimplementar
 *
 * 1. **SEO ausente (#8352 OG/Twitter, #8336/#8359 JSON-LD, #8354 h1)** — as
 *    11 páginas publicadas pelo backend Kit (`publish-edition-site-page.ts`,
 *    Stage 6, uma edição de cada vez) foram cada uma escritas com a versão de
 *    `buildArchivePageHtml` vigente NO DIA da publicação — antes de #8336/
 *    #8352/#8354 existirem. `hasSeoBlock` detecta isso por um marcador
 *    (`og:type`) que só existe nas páginas já passadas pela versão atual.
 * 2. **Nav prev/next (#8353 item 1)** — feature NOVA nesta mesma PR, que
 *    `generateArchivePages` já injeta em qualquer regeneração futura, mas as
 *    270 páginas já em disco (Beehiiv + Kit) não passam por uma regeneração
 *    completa até `data/kit-cache/broadcasts/` existir de verdade (ver
 *    `gen-archive-pages.ts`) — sem este backfill, o acervo ficaria sem
 *    linkagem interna indefinidamente, não só as 11.
 *
 * Os blocos de marcação em si (SEO: `renderSeoMeta`/`buildArchiveNewsArticleJsonLd`;
 * heading: `normalizeHeadingHierarchy`; nav: `buildArchiveNeighborNavHtml`) são
 * os MESMOS que `buildArchivePageHtml` usa — nada de markup é reimplementado
 * aqui, só a extração dos campos que o backfill precisa a partir do HTML já
 * renderizado (título, description, dek, canonical/slug), já que não há
 * `content.free.web` cru disponível pra essas 11 fora do cache Kit ausente.
 *
 * ## Idempotência
 *
 * Cada bloco é guardado por um marcador que só existe DEPOIS de aplicado
 * (`og:type` pra SEO, `class="archive-nav"` pra nav) — rodar 2x é sempre um
 * no-op na 2ª vez, mesma disciplina de `commitAndPushSitePage`/outros
 * scripts idempotentes do projeto.
 */

import {
  type ArchivePost,
  type ArchiveNeighbor,
  archiveUrlForSlug,
  buildArchiveNeighborNavHtml,
  buildArchiveNewsArticleJsonLd,
  normalizeHeadingHierarchy,
  publishDateToIso,
} from "./site-archive-pages.ts";
import { renderSeoMeta } from "./shared/seo-meta.ts";
import { escHtml } from "./html-escape.ts";
import { COVER_IMAGE_WIDTH, COVER_IMAGE_HEIGHT } from "./shared/cover-image.ts";

/** Marcador de "já passou pelo bloco de SEO atual" — presente em toda página
 * que já saiu de `renderSeoMeta({ type: "article", ... })` (#8352). */
const SEO_MARKER = 'property="og:type"';

/** Reexportado só pra conveniência de quem importa este módulo — mesmo
 * marcador que `buildArchiveNeighborNavHtml` grava. */
export const ARCHIVE_NAV_MARKER = 'class="archive-nav"';

export interface BackfillContext {
  slug: string;
  prev?: ArchiveNeighbor;
  next?: ArchiveNeighbor;
  /** Unix seconds — data de publicação, quando conhecida (tipicamente
   * derivada do `<lastmod>` do sitemap pra esta página, que já existe pra
   * toda edição publicada — ver CLI). `undefined` faz `buildArchiveNewsArticleJsonLd`
   * omitir o JSON-LD (mesmo fail-soft de sempre), sem impedir o resto do
   * backfill (OG/Twitter/h1/nav não dependem de data). */
  publishDateUnixSeconds?: number;
}

export interface BackfillResult {
  html: string;
  changed: boolean;
  addedSeo: boolean;
  addedNav: boolean;
}

/**
 * Reverso mínimo de `escHtml` — suficiente pro que este módulo precisa
 * desescapar (texto que o PRÓPRIO `buildArchivePageHtml` escapou ao
 * escrever `<title>`/`<meta content="...">` originalmente, nunca HTML
 * arbitrário de terceiros). `&amp;` por último — se viesse antes, `&amp;lt;`
 * desescaparia pra `<` em vez do `&lt;` correto.
 */
function unescapeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Extrai o valor de um `<meta name="{attr}" content="...">` já presente no
 * head — `undefined` se a tag não existir. Aceita `'` ou `"` como aspas
 * (não visto no corpus real, mas mais barato que assumir). */
function extractMetaContent(html: string, name: string): { raw: string; value: string } | undefined {
  const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([\\s\\S]*?)["']\\s*/?>`, "i");
  const m = html.match(re);
  return m ? { raw: m[0], value: unescapeHtmlEntities(m[1]) } : undefined;
}

function extractCanonical(html: string): { raw: string; href: string } | undefined {
  const m = html.match(/<link\s+rel=["']canonical["']\s+href=["']([\s\S]*?)["']\s*\/?>/i);
  return m ? { raw: m[0], href: m[1] } : undefined;
}

/**
 * Deriva `og:image`/`twitter:image` a partir do PRIMEIRO `<img class="hero"
 * ...>` do corpo — a capa 2:1 do D1 (`04-d1-2x1.jpg`, mesma convenção de
 * `COVER_IMAGE_WIDTH`/`COVER_IMAGE_HEIGHT`, #5131), sempre a primeira imagem
 * hero da edição (destaque em ordem D1→D2→D3). É a MESMA imagem que
 * `thumbnail_url` do cache Beehiiv já aponta pras 259 páginas de origem
 * Beehiiv (confirmado ao vivo: `og:image` delas resolve pro upload do MESMO
 * `04-d1-2x1.jpg`, só hospedado num CDN diferente) — não é uma aproximação
 * nova, é a fonte que faltava só pro lado Kit (`kitUnifiedPostToArchivePost`
 * não tem campo equivalente a `thumbnail_url`, ver docstring dele).
 * `undefined` quando a página não tem nenhum `<img class="hero">` (nunca
 * visto nas 11 do #8359, mas o resto do backfill segue sem imagem, mesmo
 * fail-soft que `renderSeoMeta`/`buildArchivePageHtml` já aplicam a
 * `thumbnail_url` ausente).
 */
export function extractHeroImageUrl(html: string): string | undefined {
  const imgTagRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgTagRe.exec(html))) {
    const tag = m[0];
    if (!/\bclass=["']hero["']/i.test(tag)) continue;
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch) return srcMatch[1];
  }
  return undefined;
}

/** `undefined` se não houver `<title>` (não deveria acontecer — toda página
 * do acervo já tem `<title>` desde a 1ª versão de `buildArchivePageHtml`). */
export function extractPageTitle(html: string): string | undefined {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? unescapeHtmlEntities(m[1]) : undefined;
}

/**
 * Aplica o backfill de SEO (OG/Twitter/JSON-LD/h1) numa página que ainda não
 * tem `SEO_MARKER`. Devolve o HTML intocado se faltar algum dos 3 campos
 * mínimos (`<title>`, `<meta name="description">`, `<link rel="canonical">`)
 * — nunca visto no corpus real (toda página já tem os 3 desde a 1ª versão de
 * `buildArchivePageHtml`), mas falhar fechado é mais seguro que publicar um
 * `<head>` pior do que o que já estava lá.
 */
function backfillSeo(html: string, ctx: BackfillContext): { html: string; changed: boolean } {
  const title = extractPageTitle(html);
  const description = extractMetaContent(html, "description");
  const canonical = extractCanonical(html);
  if (!title || !description || !canonical) {
    return { html, changed: false };
  }
  const dek = extractMetaContent(html, "dek");
  const heroImageUrl = extractHeroImageUrl(html);

  const post: ArchivePost = {
    slug: ctx.slug,
    title,
    subtitle: dek?.value ?? null,
    status: "confirmed",
    web_url: canonical.href,
    publish_date: ctx.publishDateUnixSeconds ?? null,
    thumbnail_url: heroImageUrl ?? null,
    content: null,
  };

  const articlePublishedTime = publishDateToIso(post);
  const seoBlock = renderSeoMeta({
    title,
    description: description.value,
    url: canonical.href,
    type: "article",
    articlePublishedTime,
    image: heroImageUrl ? { url: heroImageUrl, width: COVER_IMAGE_WIDTH, height: COVER_IMAGE_HEIGHT } : undefined,
  });
  const jsonLd = buildArchiveNewsArticleJsonLd(post) ?? "";
  const dekMeta = dek ? `<meta name="dek" content="${escHtml(dek.value)}">` : "";

  // Remove as 3 tags antigas (description/canonical/dek) — o bloco novo as
  // substitui por completo (`renderSeoMeta` já emite description+canonical),
  // então mantê-las duplicaria a tag. `dekMeta` acima já recria o `dek` com o
  // MESMO valor, só reposicionado junto do resto do bloco de SEO — igual ao
  // que `buildArchivePageHtml` já faz pra página nova.
  let out = html.replace(description.raw, "").replace(canonical.raw, "");
  if (dek) out = out.replace(dek.raw, "");

  out = out.replace(/<\/title>/i, (m) => `${m}${seoBlock}${dekMeta}${jsonLd}`);
  out = normalizeHeadingHierarchy(out, title);

  return { html: out, changed: true };
}

/**
 * Aplica o backfill de nav prev/next (#8353 item 1) numa página que ainda
 * não tem `ARCHIVE_NAV_MARKER`. Sem `prev` nem `next` resolvidos (post mais
 * antigo/mais recente do acervo, ou vizinho sem título conhecido), devolve o
 * HTML intocado — mesmo fail-soft de `buildArchiveNeighborNavHtml`.
 */
function backfillNav(html: string, ctx: BackfillContext): { html: string; changed: boolean } {
  const navHtml = buildArchiveNeighborNavHtml(ctx.prev, ctx.next);
  if (!navHtml) return { html, changed: false };
  const out = html.replace(/<body[^>]*>/i, (full) => `${full}${navHtml}`);
  return { html: out, changed: true };
}

/**
 * Aplica os dois backfills (SEO + nav) numa única página, cada um guardado
 * pelo seu próprio marcador — uma página pode precisar só de um dos dois
 * (ex: uma das 259 Beehiiv já tem SEO completo, só falta nav).
 */
export function backfillArchivePageOnDisk(html: string, ctx: BackfillContext): BackfillResult {
  let out = html;
  let addedSeo = false;
  let addedNav = false;

  if (!out.includes(SEO_MARKER)) {
    const seoResult = backfillSeo(out, ctx);
    out = seoResult.html;
    addedSeo = seoResult.changed;
  }

  if (!out.includes(ARCHIVE_NAV_MARKER)) {
    const navResult = backfillNav(out, ctx);
    out = navResult.html;
    addedNav = navResult.changed;
  }

  return { html: out, changed: addedSeo || addedNav, addedSeo, addedNav };
}

/** Reexportado pra quem só precisa montar a URL de um vizinho sem importar
 * de `site-archive-pages.ts` diretamente. */
export { archiveUrlForSlug };
