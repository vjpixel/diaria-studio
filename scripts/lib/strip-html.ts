/**
 * strip-html.ts (#2834 — EPIC #2808, enxugar scripts/lib/)
 *
 * Duas variantes de "strip HTML → texto plano" que estavam duplicadas
 * byte-a-byte em múltiplos scripts (grep `function stripHtml`):
 *
 * - `stripHtml` — preserva hrefs (`<a href>` → URL inline) e normaliza
 *   quebras de bloco (`<br>`/`</p>`/`</div>` → newline) antes de stripar tags
 *   remanescentes. Usada onde o texto extraído ainda referencia links
 *   (auto-forward-newsletters.ts, capture-newsletter-urls.ts).
 * - `stripHtmlBasic` — strip raso: remove todas as tags primeiro, depois
 *   decodifica um punhado de entidades comuns e colapsa espaços. Usada em
 *   parsers de feed/sitemap onde não há necessidade de preservar link (RSS
 *   description, sitemap `<lastmod>` etc. — fetch-rss.ts, fetch-sitemap.ts).
 *
 * NÃO consolidado aqui (comportamento observável divergente, risco de
 * mudança sutil de output):
 * - `eia-compose.ts` tem uma 3ª variante com ordem de decode de entidades
 *   diferente (quot/#39 antes de lt/gt) — mesmo resultado pra HTML bem-formado
 *   mas não é bytewise-idêntica a `stripHtmlBasic`, então fica local.
 * - `lib/clean-summary.ts` já exporta seu próprio `stripHtml`, propositalmente
 *   mais robusto (double-decode guard #2151, anchors preservando texto interno
 *   em vez de href) — escopo e contrato diferentes, não é duplicata.
 */

/** Preserva hrefs de `<a>` como texto inline; normaliza `<br>`/tags de bloco → newline. */
export function stripHtml(html: string): string {
  // Replace <a href="..."> with the URL followed by a space
  let text = html.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi, "$1 ");
  // Replace <br>, <p>, <div> closings with newlines
  text = text.replace(/<\/(p|div|tr|li)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse multiple spaces/newlines
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Strip raso: remove tags primeiro, decodifica entidades comuns, colapsa espaços em 1 linha. */
export function stripHtmlBasic(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
