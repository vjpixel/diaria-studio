/**
 * seo-meta.ts (#3106)
 *
 * Bloco <head> de SEO/compartilhamento compartilhado entre as páginas públicas
 * estáticas da Diar.ia geradas por script (`build-cursos-page.ts`,
 * `build-livros-page.ts`). Cada página tem title/description próprios;
 * `renderSeoMeta` monta description + Open Graph + Twitter card + canonical +
 * favicon (SVG inline via data-URI — zero asset externo, zero custo).
 *
 * Por que NÃO há og:image/twitter:image (decisão #3106, documentada também no
 * corpo do PR): nenhuma das 3 páginas afetadas (cursos, livros, poll
 * leaderboard) tem asset de marca estático versionado no repo — sem favicon,
 * logo ou capa em `context/`, `seed/` ou `workers/{worker}/public/` reutilizável.
 * Gerar uma imagem 1200×630 nova está fora de escopo desta issue (custo +
 * dependência de serviço externo — contra o princípio de zero-custo-recorrente
 * do CLAUDE.md). Um SVG inline via data-URI FUNCIONA bem como favicon
 * (`<link rel="icon">` — todo browser moderno decodifica data: URIs), mas
 * og:image/twitter:image são diferentes: os crawlers de unfurling
 * (WhatsApp/LinkedIn/Facebook/Slack) fazem um GET HTTP(S) SEPARADO na URL
 * declarada em `content` para baixar a imagem — um `data:` URI não é uma "URL"
 * buscável nesse sentido e é tipicamente ignorado ou rejeitado por esses
 * crawlers (spec do Open Graph assume `http`/`https`). Declarar um og:image
 * que nenhum unfurler consegue buscar teria pior UX que omiti-lo (card com
 * campo de imagem "morto" vs. card compacto sem imagem). Decisão: omitir
 * og:image/twitter:image; usar `twitter:card=summary` (sem imagem grande) —
 * title + description continuam aparecendo normalmente no preview.
 */

export interface SeoMetaOptions {
  /** Título da página — reusado em og:title / twitter:title. */
  title: string;
  /** Descrição curta (~150-160 chars ideal) — usada em <meta name="description">, og:description, twitter:description. */
  description: string;
  /** URL absoluta canônica desta página (http/https). */
  url: string;
  /** og:site_name. Default "Diar.ia". */
  siteName?: string;
  /** og:locale. Default "pt_BR". */
  locale?: string;
}

function escAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Favicon SVG inline (data-URI, sem asset externo versionado): marca "d.."
 * em branco (#FFFFFF) sobre fundo teal (#00A0A0) — mesma paleta do DS canônico
 * (`lib/shared/design-tokens.ts`). Os dois pontos são o period do Georgia
 * (redondo). Reusado como `<link rel="icon">` em toda página coberta por este
 * módulo. Trocar o favicon faz o browser tratar como página diferente no
 * histórico/tabs — mudança intencional aqui (alinhamento à marca d..).
 */
export const FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2300A0A0'/%3E%3Ctext x='30' y='46' font-family='Georgia, Times, serif' font-size='40' font-weight='700' fill='%23FFFFFF' text-anchor='middle'%3Ed..%3C/text%3E%3C/svg%3E";

/**
 * Monta o bloco de tags `<head>` de SEO/compartilhamento. Pure — devolve uma
 * string pronta pra interpolar dentro de `<head>...</head>`, entre `<title>`
 * e `<style>`. Ver nota do módulo sobre a ausência intencional de
 * og:image/twitter:image.
 */
export function renderSeoMeta(opts: SeoMetaOptions): string {
  const { title, description, url, siteName = "Diar.ia", locale = "pt_BR" } = opts;
  const t = escAttr(title);
  const d = escAttr(description);
  const u = escAttr(url);
  return `<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<link rel="icon" href="${FAVICON_DATA_URI}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escAttr(siteName)}">
<meta property="og:locale" content="${escAttr(locale)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">`;
}
