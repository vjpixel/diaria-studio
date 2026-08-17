/**
 * seo-meta.ts (#3106)
 *
 * Bloco <head> de SEO/compartilhamento compartilhado entre as páginas públicas
 * estáticas da diar.ia.br geradas por script (`build-cursos-page.ts`,
 * `build-livros-page.ts`, `hub-page.ts`, `render-archive.ts`). Cada página tem
 * title/description próprios; `renderSeoMeta` monta description + Open Graph +
 * Twitter card + canonical + favicon (SVG inline via data-URI — zero asset
 * externo, zero custo) + og:image opcional (abaixo) + feed RSS opcional
 * (abaixo).
 *
 * **og:image/twitter:image — decisão #3106 REABERTA em #5131 (12/ago/2026).**
 * A decisão original (permanece documentada aqui pra não se perder o
 * histórico) foi omitir os dois: nenhuma das 3 páginas afetadas na época
 * (cursos, livros, poll leaderboard) tinha asset de marca estático
 * versionado no repo, e gerar uma imagem nova estava fora de escopo (custo +
 * dependência de serviço externo, contra zero-custo-recorrente do
 * CLAUDE.md). As DUAS premissas que embasaram isso caducaram: `sharp` já é
 * dependência do repo, e o pipeline diário gera e hospeda capas 1600×800
 * (`data/editions/{ed}/_internal/06-public-images.json` → `images.cover.url`)
 * todo dia — o asset que faltava em #3106 já existe como subproduto de
 * outro trabalho. Decisão do #5131: emitir `og:image`/`twitter:image`
 * QUANDO uma imagem estiver disponível (parâmetro `image`, opcional — ver
 * `SeoMetaOptions.image` abaixo), com `twitter:card=summary_large_image` no
 * lugar de `summary`. Omitir `image` preserva o comportamento antigo
 * byte-a-byte (nenhum teste de `seo-meta.test.ts`/`poll-*` que já passava
 * sem passar `image` deveria mudar). **`especial.diar.ia.br` já emite
 * `og:image` desde antes (#5126) — mas por um caminho PARALELO, HTML
 * estático commitado à mão (`workers/artigos/public/2026/o-agente/index.html`),
 * sem passar por este módulo.** Registrado aqui porque, sem essa nota, a
 * próxima sessão que ler este docstring concluiria que ninguém no projeto
 * emite `og:image` — o que já era falso antes mesmo do #5131.
 *
 * Continua não usando o favicon SVG data-URI como og:image — a mesma
 * limitação de sempre (unfurlers fazem GET HTTP(S) separado na URL
 * declarada; `data:` URI não é uma URL buscável nesse sentido) segue valendo
 * pro favicon, só não é mais a única imagem disponível.
 */

/**
 * Container GTM único, compartilhado por todos os hosts servidos por Worker
 * deste repo — GA4, pixel Meta e tag de conversão do Google Ads são
 * gerenciados DENTRO do container (há precedente em produção: a tag `lintrk`
 * do LinkedIn), então uma única constante aqui cobre as 3 plataformas sem
 * precisar de redeploy quando uma delas muda.
 */
export const GTM_CONTAINER_ID = "GTM-TC8C65ZN";

/**
 * Monta o snippet `<script>` do container GTM (#5498) — a mesma tag que já
 * roda na home (`diar.ia.br`, campo nativo do Beehiiv, fora deste repo), pra
 * que os hosts servidos por Worker (`arquivo`, `livros`, `cursos`,
 * `especial`, `eia`) também emitam PageView rastreável. Chamar ao lado de
 * `renderSeoMeta()` em todo `<head>` — inclusive nas 3 páginas que não
 * passam por `renderSeoMeta()` (`render-app.ts`, `render-privacy.ts`,
 * `gate-page.ts`). Emite só o container (nada de tags soltas de GA4/Meta/
 * conversão — essas vivem dentro do container no console do GTM).
 */
export function renderAnalyticsHead(): string {
  return `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_CONTAINER_ID}');</script>`;
}

export interface SeoMetaOptions {
  /** Título da página — reusado em og:title / twitter:title. */
  title: string;
  /** Descrição curta (~150-160 chars ideal) — usada em <meta name="description">, og:description, twitter:description. */
  description: string;
  /** URL absoluta canônica desta página (http/https). */
  url: string;
  /** og:site_name. Default "diar.ia.br". */
  siteName?: string;
  /** og:locale. Default "pt_BR". */
  locale?: string;
  /**
   * Imagem de compartilhamento (#5131) — QUANDO presente, emite
   * `og:image`/`twitter:image` (+ `og:image:width`/`og:image:height` se
   * `width`/`height` vierem) e troca `twitter:card` de `summary` pra
   * `summary_large_image`. `url` precisa ser http(s) buscável por unfurler
   * (nunca um `data:` URI — ver nota do módulo). Omitido (default):
   * comportamento idêntico a antes do #5131 — sem og:image/twitter:image,
   * `twitter:card=summary`.
   */
  image?: {
    url: string;
    width?: number;
    height?: number;
  };
  /**
   * Feed RSS/Atom desta página (#5127) — QUANDO presente, declara
   * `<link rel="alternate" type="application/rss+xml">` no `<head>`, pra
   * leitores/agregadores descobrirem o feed sem depender só do
   * `robots.txt`. Omitido (default): nenhum `<link rel="alternate">` é
   * emitido — comportamento idêntico a antes do #5127.
   */
  feed?: {
    url: string;
    /** `title` do `<link>` — texto que o leitor de feed mostra na lista de
     * assinaturas. Default: "{siteName} — Feed RSS". */
    title?: string;
  };
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
 * e `<style>`. Ver nota do módulo sobre `image`/`feed` (opcionais, #5131/#5127)
 * e a ausência de og:image/twitter:image quando `image` não é passado.
 */
export function renderSeoMeta(opts: SeoMetaOptions): string {
  const { title, description, url, siteName = "diar.ia.br", locale = "pt_BR", image, feed } = opts;
  const t = escAttr(title);
  const d = escAttr(description);
  const u = escAttr(url);
  const imageTags = image
    ? `\n<meta property="og:image" content="${escAttr(image.url)}">` +
      (image.width ? `\n<meta property="og:image:width" content="${image.width}">` : "") +
      (image.height ? `\n<meta property="og:image:height" content="${image.height}">` : "") +
      `\n<meta name="twitter:image" content="${escAttr(image.url)}">`
    : "";
  const feedTag = feed
    ? `\n<link rel="alternate" type="application/rss+xml" title="${escAttr(feed.title ?? `${siteName} — Feed RSS`)}" href="${escAttr(feed.url)}">`
    : "";
  return `<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<link rel="icon" href="${FAVICON_DATA_URI}">${feedTag}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escAttr(siteName)}">
<meta property="og:locale" content="${escAttr(locale)}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">${imageTags}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">`;
}
