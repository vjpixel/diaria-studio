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
import { loadPublishDateOverrides } from "./beehiiv-publish-date.ts";

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

/**
 * Só posts publicados de verdade entram no acervo — nunca rascunho (ex: o
 * `new-post` duplicado achado no cache). Type predicate (não só `boolean`)
 * pra `posts.filter(isPublishedPost)` estreitar o tipo de retorno —
 * `slug` deixa de ser opcional pro caller depois do filter.
 */
export function isPublishedPost(
  post: ArchivePost,
): post is ArchivePost & { status: "confirmed"; slug: string } {
  return post.status === "confirmed" && !!post.slug && post.slug !== "new-post";
}

/** Filtra + ordena (mais recente primeiro) — determinístico pro sitemap e pro teste.
 * Ordena pela mesma data "canônica" resolvida via override (#4796) que
 * `publishDateToIso` usa pro `<lastmod>` — sem isso, as 6 primeiras edições
 * (cujo `publish_date` bruto aponta pro dia do import em lote, não pro
 * envio real) podiam ficar fora de ordem cronológica real no acervo. */
export function selectPublishedPosts(posts: ArchivePost[]): ArchivePost[] {
  return posts
    .filter(isPublishedPost)
    .sort((a, b) => (resolvePublishTimestampMs(b) ?? 0) - (resolvePublishTimestampMs(a) ?? 0));
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
  if (!isPublishedPost(post)) {
    throw new Error(
      `post "${post.slug}" não é publicado (status="${post.status}") — buildArchivePageHtml não gera página pra rascunho`,
    );
  }

  const rawHtml = post.content?.free?.web;
  if (!rawHtml) {
    throw new Error(`post "${post.slug}" não tem content.free.web — não é gerável`);
  }

  const title = escHtml(derivePageTitle(post));
  const description = escHtml(deriveMetaDescription(post));
  const canonical = archiveUrlForSlug(post.slug);

  let html = rawHtml;

  // Precisa haver <html ...> pra injetar lang + (no fallback abaixo) head —
  // sem essa tag, um .replace() vira no-op silencioso e a página sai sem
  // lang/title/description/canonical sem nenhum erro. Falha alto e nomeia o
  // slug em vez de degradar em silêncio.
  const HTML_TAG_PATTERN = /<html(\s[^>]*)?>/i;
  if (!HTML_TAG_PATTERN.test(html)) {
    throw new Error(
      `post "${post.slug}" não tem tag <html> no HTML de origem (content.free.web) — buildArchivePageHtml não consegue injetar lang/head`,
    );
  }

  // <html ...> → <html lang="pt-BR" ...> (o cache nunca tem `lang`; se um
  // dia vier a ter, substitui em vez de duplicar o atributo).
  html = html.replace(HTML_TAG_PATTERN, (full, attrs: string | undefined) => {
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

  // Guard (#6210): rejeita qualquer merge tag não resolvida antes de publicar.
  verifyNoUnresolvedMergeTags(html, post.slug);

  // Sanitiza links de voto com merge tag crua — substitui por valor vazio
  // até a decisão editorial sobre o voto na superfície web (#6210).
  html = html.replace(/email=\{\{email\}\}/gi, "email=");

  return html;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export function sitemapEntriesForPosts(posts: ArchivePost[]): SitemapEntry[] {
  return selectPublishedPosts(posts).map((post) => ({
    loc: archiveUrlForSlug(post.slug),
    lastmod: publishDateToIso(post),
  }));
}

/**
 * Data de publicação "canônica" em ms — consulta o override por slug
 * (`beehiiv-publish-date-overrides.json`, #4796) primeiro, porque
 * `publish_date` bruto MENTE pras 6 primeiras edições publicadas (aponta
 * pro dia do import em lote pro Beehiiv, não pro envio real por e-mail —
 * ver docstring de `beehiiv-publish-date.ts`). Cai pro `publish_date` bruto
 * do cache (epoch segundos ou, defensivamente, ms) pra toda edição fora do
 * override. Usado tanto pra ordenar `selectPublishedPosts` quanto pro
 * `<lastmod>` do sitemap — as duas leituras da mesma data precisam
 * concordar.
 */
function resolvePublishTimestampMs(post: ArchivePost): number | undefined {
  const overrides = loadPublishDateOverrides().overrides;
  if (post.slug && Object.hasOwn(overrides, post.slug)) {
    const ms = Date.parse(`${overrides[post.slug]}T00:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  const publishDate = post.publish_date;
  if (!publishDate) return undefined;
  // publish_date do cache Beehiiv vem em epoch segundos (ver
  // scripts/lib/beehiiv-publish-date.ts).
  const ms = publishDate > 1e12 ? publishDate : publishDate * 1000;
  return Number.isNaN(ms) ? undefined : ms;
}

function publishDateToIso(post: ArchivePost): string | undefined {
  const ms = resolvePublishTimestampMs(post);
  if (ms === undefined) return undefined;
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

/** Guard (#6210): rejeita HTML com merge tag não resolvida (ex: `{{email}}` literal).
 * O vazamento das 87 páginas do acervo vem do `content.free.web` da Beehiiv —
 * a tag chega crua, e sem esta verificação a página publica o template como texto.
 */
export function verifyNoUnresolvedMergeTags(html: string, slug: string): void {
  // Qualquer `{{...}}` que não seja uma substituição já feita pelo gerador indica vazamento.
  const unresolved = html.match(/\{\{[^}]+\}\}/g);
  if (unresolved && unresolved.length > 0) {
    throw new Error(
      `post "${slug}" contém merge tag não resolvida no HTML (${unresolved[0]} ... ${unresolved.length} ocorrências) — guard #6210 rejeitou`,
    );
  }
}
