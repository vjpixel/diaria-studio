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
 * Favicon SVG inline (data-URI, sem asset externo versionado): marca "d.." em
 * branco num CÍRCULO teal (#00A0A0), transparente fora do círculo — teal é
 * visível em qualquer tab (claro/escuro). É a composição canônica do avatar
 * (ver diaria-design `guidelines/avatar-proportion.md`): "d" como <path>
 * outlined do Georgia (font-independent — não depende da fonte instalada),
 * haste centrada no círculo, 2 pontos REDONDOS equidistantes, proporção 1.2×.
 * Reusado como `<link rel="icon">`. Trocar o favicon faz o browser tratar como
 * página diferente no histórico/tabs — mudança intencional (proporção 1.2×).
 */
export const FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1080 1080'%3E%3Ccircle cx='540' cy='540' r='540' fill='%2300A0A0'/%3E%3Cg transform='translate(540 540) scale(1.2000) translate(-540 -540)'%3E%3Cpath transform='translate(310 700) scale(0.229492 -0.229492)' d='M1351 21 858 -8 843 6V98L836 100Q787 47 703.5 7.5Q620 -32 535 -32Q333 -32 202.0 118.0Q71 268 71 506Q71 717 217.5 868.0Q364 1019 572 1019Q654 1019 726.0 1000.5Q798 982 841 957V1284Q841 1321 826.0 1353.5Q811 1386 786 1404Q755 1426 708.5 1435.5Q662 1445 615 1449V1522L1155 1548L1170 1532V221Q1170 183 1182.5 157.0Q1195 131 1223 116Q1244 105 1284.5 100.0Q1325 95 1351 94ZM841 199V764Q834 787 821.5 815.0Q809 843 787 868Q767 889 733.5 905.0Q700 921 658 921Q558 921 494.0 808.0Q430 695 430 489Q430 408 441.5 343.5Q453 279 482 226Q511 173 556.5 143.0Q602 113 666 113Q727 113 767.0 136.5Q807 160 841 199Z' fill='%23FFFFFF'/%3E%3Ccircle cx='699' cy='662' r='45' fill='%23FFFFFF'/%3E%3Ccircle cx='824' cy='662' r='45' fill='%23FFFFFF'/%3E%3C/g%3E%3C/svg%3E";

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
