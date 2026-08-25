/**
 * site-archive-pages.ts (#467, 1º item do checklist revisado)
 *
 * Miolo puro do gerador de páginas do acervo `/p/{slug}` a partir do cache
 * `data/beehiiv-cache/posts/post_*.json` (`content.free.web` — HTML completo
 * já renderizado pela Beehiiv via API oficial, `expand[]=free_web_content`).
 *
 * Escopo desta unidade: só o acervo EXISTENTE (258 posts em cache, 253
 * `status: "confirmed"`). NÃO cobre o passo de pipeline que publica a
 * página de uma edição NOVA (2º item do checklist, #467) nem `/`,
 * `/subscribe`, `/forms/*` (3º item) — ver PR desta unidade.
 *
 * Duas correções aplicadas no HTML gerado, ambas linkadas no #467
 * (resolvem "de graça" com este trabalho):
 *   - `<html lang="pt-BR">` — o cache não tem NENHUM atributo `lang` (a
 *     versão SERVIDA pela Beehiiv injeta `lang="en"` no template de
 *     request-time, bug de plataforma documentado em docs/seo-notes.md
 *     Fato 6/#5101 item 1 — não presente no HTML cru que a API devolve).
 *   - meta description por página — o cache não tem `<title>`/`<meta
 *     name="description">` nenhum; `meta_default_title`/
 *     `meta_default_description` costumam vir `null` (#5101 item 2), então
 *     o fallback usa `subtitle`/`preview_text` do post, nunca um genérico.
 */

import { escHtml } from "./html-escape.ts";

export interface ArchivePost {
  slug: string;
  title: string;
  subtitle?: string | null;
  preview_text?: string | null;
  meta_default_title?: string | null;
  meta_default_description?: string | null;
  status: string;
  web_url?: string | null;
  displayed_date?: string | null;
  publish_date?: number | null;
  content?: {
    free?: {
      web?: string | null;
    } | null;
  } | null;
}

export const ARCHIVE_BASE_URL = "https://diar.ia.br";

/** Só posts publicados de verdade entram no acervo — nunca rascunho (ex: o `new-post` duplicado achado no cache). */
export function isPublishedPost(post: ArchivePost): boolean {
  return post.status === "confirmed" && !!post.slug && post.slug !== "new-post";
}

/** Filtra + ordena (mais recente primeiro) — determinístico pro sitemap e pro teste. */
export function selectPublishedPosts(posts: ArchivePost[]): ArchivePost[] {
  return posts
    .filter(isPublishedPost)
    .sort((a, b) => (b.publish_date ?? 0) - (a.publish_date ?? 0));
}

export function derivePageTitle(post: ArchivePost): string {
  return post.meta_default_title || post.title || post.slug;
}

/**
 * `meta_default_description` costuma ser `null` (#5101 item 2) — cai pra
 * `subtitle`, depois `preview_text`, nunca deixa a página sem description.
 * Último fallback (título) só dispara se os 3 campos de conteúdo faltarem.
 */
export function deriveMetaDescription(post: ArchivePost): string {
  return (
    post.meta_default_description ||
    post.subtitle ||
    post.preview_text ||
    post.title ||
    "diar.ia.br — 5 minutos diários sobre inteligência artificial."
  );
}

export function archiveUrlForSlug(slug: string): string {
  return `${ARCHIVE_BASE_URL}/p/${slug}`;
}

/**
 * Injeta `lang="pt-BR"`, `<title>`, `<meta name="description">` e
 * `<link rel="canonical">` no HTML cru de `content.free.web` — que não tem
 * NENHUM desses (confirmado ao vivo nos 258 posts do cache, #467).
 * Preserva o resto do documento (estilos inline, corpo) sem tocar.
 */
export function buildArchivePageHtml(post: ArchivePost): string {
  const rawHtml = post.content?.free?.web;
  if (!rawHtml) {
    throw new Error(`post "${post.slug}" não tem content.free.web — não é gerável`);
  }

  const title = escHtml(derivePageTitle(post));
  const description = escHtml(deriveMetaDescription(post));
  const canonical = archiveUrlForSlug(post.slug);

  let html = rawHtml;

  // <html ...> → <html lang="pt-BR" ...> (o cache nunca tem `lang`; se um
  // dia vier a ter, substitui em vez de duplicar o atributo).
  html = html.replace(/<html(\s[^>]*)?>/i, (full, attrs: string | undefined) => {
    if (attrs && /\blang\s*=/i.test(attrs)) {
      return full.replace(/lang\s*=\s*(["']).*?\1/i, 'lang="pt-BR"');
    }
    return `<html lang="pt-BR"${attrs ?? ""}>`;
  });

  const headInject =
    `<meta charset="utf-8">` +
    `<title>${title}</title>` +
    `<meta name="description" content="${description}">` +
    `<link rel="canonical" href="${escHtml(canonical)}">`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (full) => `${full}${headInject}`);
  } else {
    // Nunca visto no cache real (todo post tem <head>), mas não deixar a
    // página sair sem os metadados se algum post futuro vier sem.
    html = html.replace(/<html[^>]*>/i, (full) => `${full}<head>${headInject}</head>`);
  }

  return html;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export function sitemapEntriesForPosts(posts: ArchivePost[]): SitemapEntry[] {
  return selectPublishedPosts(posts).map((post) => ({
    loc: archiveUrlForSlug(post.slug),
    lastmod: publishDateToIso(post.publish_date),
  }));
}

function publishDateToIso(publishDate: number | null | undefined): string | undefined {
  if (!publishDate) return undefined;
  // publish_date do cache Beehiiv vem em epoch segundos (ver
  // scripts/lib/beehiiv-publish-date.ts).
  const ms = publishDate > 1e12 ? publishDate : publishDate * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `\n    <lastmod>${escXml(entry.lastmod)}</lastmod>` : "";
      return `  <url>\n    <loc>${escXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
