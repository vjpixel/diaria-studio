/**
 * site-videos-page.ts (#13323)
 *
 * Miolo puro da página `diar.ia.br/videos`: todos os vídeos horizontais da
 * série "diar.ia.br: notícias de IA" (até 16/11/2026, "diar.ia.br comentada",
 * #13317), do mais recente ao mais antigo, na mesma grade da
 * seção "Vídeos" da home (`renderVideoCards`, `site-home-page.ts`). Gerada
 * por `scripts/gen-videos-page.ts` como static asset do Worker `workers/site`
 * (mesmo padrão de `/archive`), sem rota nova em `src/index.ts`. `/video`
 * (singular, #12735) continua sendo o redirect da bio para o horizontal mais
 * recente; as duas URLs não se cruzam.
 *
 * Fonte: a MESMA da home (`buildVideoFeed`, `sitemap.xml` + `public/p/`), sem
 * `data/` e sem chamada à YouTube API no build. O card leva à página da
 * edição; "Ver no YouTube" é o link secundário.
 *
 * SEO de vídeo: `ItemList` de `VideoObject` no JSON-LD, um item por vídeo,
 * com os mesmos campos que a página da edição declara (#12080).
 */

import { escHtml } from "./html-escape.ts";
import { renderAnalyticsHead, renderSeoMeta } from "./shared/seo-meta.ts";
import { COLORS } from "./shared/design-tokens.ts";
import { renderSiteNav } from "./shared/site-nav.ts";
import { renderSiteSocialFooter } from "./shared/site-social.ts"; // #13480: rodapé social global, como as demais páginas com o menu (#13321)
import { ARCHIVE_BASE_URL } from "./site-archive-pages.ts";
import { YOUTUBE_EMBED_BASE } from "./site-page-video.ts";
import { YOUTUBE_SERIES_NAME } from "./diaria/youtube-video.ts";
import {
  VIDEOS_PAGE_PATH,
  VIDEO_GRID_CSS,
  renderVideoCards,
  siteVideosSubscribeUrl,
  videoThumbnailUrl,
  type HomeVideoEntry,
} from "./site-home-page.ts";

/** URL canônica da página. */
export const VIDEOS_PAGE_URL = `${ARCHIVE_BASE_URL}${VIDEOS_PAGE_PATH}`;

/** Caminho do arquivo gerado, relativo a `workers/site/public/`. */
export const VIDEOS_PAGE_FILE = "videos/index.html";

/**
 * `ItemList` de `VideoObject` (schema.org). Vídeo sem data de upload (nem
 * data editorial) fica fora do JSON-LD — `uploadDate` é obrigatório para o
 * Google — mas continua na grade. Sem nenhum item, não sai `<script>`.
 */
export function buildVideosItemListJsonLd(entries: readonly HomeVideoEntry[]): string {
  const items = entries
    .filter((v) => v.uploadDate)
    .map((v, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: v.url,
      item: {
        "@type": "VideoObject",
        name: v.title,
        description: v.description || v.title,
        thumbnailUrl: [videoThumbnailUrl(v.videoId)],
        uploadDate: v.uploadDate,
        embedUrl: `${YOUTUBE_EMBED_BASE}${v.videoId}`,
        contentUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
        inLanguage: "pt-BR",
      },
    }));
  if (items.length === 0) return "";
  const node = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Vídeos da diar.ia.br",
    url: VIDEOS_PAGE_URL,
    itemListElement: items,
  };
  // </script>-safe, mesmo padrão de buildVideoObjectJsonLd.
  return `<script type="application/ld+json">${JSON.stringify(node).replaceAll("<", "\\u003c")}</script>`;
}

export function buildVideosPageHtml(entries: readonly HomeVideoEntry[]): string {
  const title = "Vídeos da diar.ia.br";
  const description =
    entries.length > 0
      ? `Todos os ${entries.length} vídeos da série “${YOUTUBE_SERIES_NAME}”: o assunto de IA do dia explicado em poucos minutos, em português.`
      : `Vídeos da série “${YOUTUBE_SERIES_NAME}”: o assunto de IA do dia explicado em poucos minutos, em português.`;
  const seoMeta = renderSeoMeta({ title, description, url: VIDEOS_PAGE_URL });
  const jsonLd = buildVideosItemListJsonLd(entries);
  const grid =
    entries.length > 0
      ? `    <ul class="video-grid">
${renderVideoCards(entries, "h2")}
    </ul>`
      : `    <p class="lede">Nenhum vídeo publicado ainda.</p>`;

  return `<!--
  workers/site/public/${VIDEOS_PAGE_FILE} (#13323)

  Todos os vídeos horizontais da diar.ia.br — ver docstring de
  scripts/lib/site-videos-page.ts.

  Gerado por \`npx tsx scripts/gen-videos-page.ts\` a partir de
  \`workers/site/public/sitemap.xml\` + \`public/p/{slug}/index.html\` — não
  editar direto (a próxima geração sobrescreve).
-->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
${seoMeta}
${jsonLd}
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
.wrap { max-width: 1180px; margin: 0 auto; padding: 48px 24px 72px; }
.top { font-size: 13px; color: var(--ink-faint); margin: 0 0 28px; }
.top a { text-decoration: none; }
h1 { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(28px, 6vw, 40px); letter-spacing: -0.02em; font-weight: 500; margin: 0 0 10px; }
.dot { color: var(--teal); }
.lede { font-size: 15px; color: var(--ink-soft); margin: 0 0 12px; max-width: 62ch; }
.actions { margin: 20px 0 0; }
.btn { display: inline-block; padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 500; text-decoration: none; background: var(--ink); color: var(--paper); }
${VIDEO_GRID_CSS}
.foot { margin: 44px 0 0; font-size: 13px; color: var(--ink-faint); display: flex; gap: 18px; flex-wrap: wrap; }
.foot a { text-decoration: underline; text-underline-offset: 3px; }
</style>
${renderAnalyticsHead()}
</head>
<body>
  ${renderSiteNav({ active: "videos", inheritHostTokens: true })}
  <main class="wrap">
    <p class="top"><a href="/">diar<span class="dot">.</span>ia<span class="dot">.</span>br</a></p>
    <h1>Vídeos</h1>
    <p class="lede">A série “${escHtml(YOUTUBE_SERIES_NAME)}”: o assunto de IA do dia explicado em poucos minutos. Cada vídeo leva à edição em que ele saiu, com a newsletter completa.</p>
    <div class="actions"><a class="btn" href="${escHtml(siteVideosSubscribeUrl())}" rel="noopener">Inscreva-se no canal</a></div>
${grid}
    <div class="foot">
      <a href="/">Página inicial</a>
      <a href="/archive">Todas as edições</a>
      <a href="/assinar">Assinar</a>
    </div>
  </main>
  ${renderSiteSocialFooter({ inheritHostTokens: true })}
</body>
</html>
`;
}
