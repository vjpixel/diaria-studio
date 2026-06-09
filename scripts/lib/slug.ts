/**
 * slug.ts (#1989) — geração de slug acent-correto + meta description pra SEO.
 *
 * `slugify` foi extraído de build-cursos-page.ts (era a única impl; agora
 * compartilhada — cursos page + slug SEO de post). `seoSlug`/`seoMetaDescription`
 * são novos (#1989): o publish flow (Chrome paste de HTML) não seta slug, então
 * a Beehiiv auto-deriva e **mangla acentos PT-BR** (ex: `automa-o`, `p-nico`).
 * Slug quebrado prejudica SEO + UX + compartilhamento.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Slug estável: NFD-strip diacríticos + lowercase + kebab. Pure. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * #1989: slug SEO de post — slugify + trunca em PALAVRA inteira até `maxLen`
 * (default 60ch; slugs muito longos são ruins pra UX/compartilhamento). Nunca
 * corta no meio de uma palavra nem deixa hífen pendente.
 */
export function seoSlug(title: string, maxLen = 60): string {
  const full = slugify(title);
  if (full.length <= maxLen) return full;
  const cut = full.slice(0, maxLen);
  const lastDash = cut.lastIndexOf("-");
  // se há hífen, corta na última palavra inteira; senão usa o corte cru.
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/**
 * #1989: meta description SEO — combina título + subtítulo, colapsa espaços,
 * trunca em palavra inteira até `maxLen` (default 155ch — limite prático do
 * snippet do Google) com reticências. Determinístico (sem LLM).
 */
export function seoMetaDescription(title: string, subtitle?: string, maxLen = 155): string {
  const raw = [title, subtitle].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
  if (raw.length <= maxLen) return raw;
  const cut = raw.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s—-]+$/, "") + "…";
}
