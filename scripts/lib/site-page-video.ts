/**
 * scripts/lib/site-page-video.ts (#12080)
 *
 * Vídeo do D1 na PÁGINA WEB da edição (`diar.ia.br/p/{slug}`). A página é a
 * cópia do HTML do e-mail (`_internal/newsletter-final.html`), e no e-mail o
 * vídeo é só a imagem do D1 com link (#10784). Na web:
 *
 *   1. a imagem do D1 vira o player (`youtube-nocookie.com/embed/{id}`), só na
 *      página — o e-mail segue com imagem e link. View de embed conta para o
 *      vídeo;
 *   2. `VideoObject` (JSON-LD) no `<head>`, para o resultado de vídeo na busca;
 *   3. o link do vídeo pode vir do disco (`_internal/05-video-url.txt`) quando
 *      o HTML do e-mail foi renderizado antes de o vídeo ter URL e a imagem
 *      aponta pro canal (261028 e 261103): a página publicada depois do
 *      vídeo, ou republicada (`video-d1-link-watch.ts`), mostra o vídeo;
 *   4. links do vídeo saem com UTM própria da web
 *      (`utm_source=site&utm_medium=web`) no lugar da UTM do e-mail.
 *
 * Edição sem vídeo (hero sem link, ou link pro canal sem URL de vídeo no
 * disco) fica sem player: o link pro canal só troca de UTM.
 *
 * PURO, sem I/O: `buildArchivePageHtml` chama `applyWebVideo` com o que o
 * caller leu do disco (`EditionVideoMeta`).
 */

import { escHtml } from "./html-escape.ts";
import { extractYouTubeVideoId } from "./diaria/d1-video-link.ts";

export const WEB_VIDEO_UTM_SOURCE = "site";
export const WEB_VIDEO_UTM_MEDIUM = "web";
export const YOUTUBE_EMBED_BASE = "https://www.youtube-nocookie.com/embed/";

export interface WebVideoInput {
  /** URL do vídeo lida do disco (vence o link do hero, que pode ser o canal). */
  videoUrl?: string | null;
  /** Título do vídeo (registro do upload); fallback: título da página. */
  name?: string | null;
  /** Descrição para o JSON-LD; fallback: descrição da página. */
  description?: string | null;
  /** ISO da publicação do vídeo; fallback: data da edição. */
  uploadDate?: string | null;
}

export interface WebVideoResult {
  html: string;
  /** Id do vídeo embutido, ou `null` (página sem player). */
  videoId: string | null;
}

const HERO_VIDEO_RE = /<a class="hero-video"[^>]*>[\s\S]*?<\/a>(\s*<p\b[^>]*>[^<]*<\/p>)?/;
const HREF_RE = /href="([^"]*)"/;

function unescAttr(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** `true` para link do YouTube (vídeo ou canal). */
function isYouTubeHref(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^(www|m)\./, "");
    return host === "youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

/** Troca a UTM de e-mail pela da web num link do YouTube (mantém a campanha). */
export function toWebVideoUrl(raw: string): string {
  const u = new URL(raw);
  u.searchParams.set("utm_source", WEB_VIDEO_UTM_SOURCE);
  u.searchParams.set("utm_medium", WEB_VIDEO_UTM_MEDIUM);
  return u.toString();
}

/**
 * Reescreve, no HTML, a UTM dos links do YouTube que vieram do e-mail
 * (`utm_source=newsletter`): o hero do D1 (#10784), o box do vídeo no slot 0
 * (#12073) e o CTA do canal. Link de outro domínio não é tocado.
 */
export function rewriteVideoUtmsForWeb(html: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (full, rawEsc: string) => {
    const raw = unescAttr(rawEsc);
    if (!isYouTubeHref(raw)) return full;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return full;
    }
    if (u.searchParams.get("utm_source") !== "newsletter") return full;
    return `href="${escHtml(toWebVideoUrl(raw))}"`;
  });
}

/** Player responsivo 16:9, no lugar da imagem do D1. */
export function buildVideoEmbedHtml(videoId: string, title: string): string {
  return (
    `<div class="hero-video-embed" style="position:relative;width:100%;padding-top:56.25%;margin-top:24px;border-radius:6px;overflow:hidden;background:#171411;">` +
    `<iframe src="${YOUTUBE_EMBED_BASE}${videoId}" title="${escHtml(title)}" ` +
    `style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" ` +
    `allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
    `referrerpolicy="strict-origin-when-cross-origin" loading="lazy" allowfullscreen></iframe></div>`
  );
}

/**
 * `VideoObject` (schema.org) do vídeo embutido. Campos obrigatórios do Google
 * (`name`, `thumbnailUrl`, `uploadDate`) sempre presentes; sem data, não sai.
 */
export function buildVideoObjectJsonLd(input: {
  videoId: string;
  name: string;
  description: string;
  uploadDate: string | null | undefined;
}): string | undefined {
  if (!input.uploadDate) return undefined;
  const node = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: input.name,
    description: input.description || input.name,
    thumbnailUrl: [`https://i.ytimg.com/vi/${input.videoId}/hqdefault.jpg`],
    uploadDate: input.uploadDate,
    embedUrl: `${YOUTUBE_EMBED_BASE}${input.videoId}`,
    contentUrl: `https://www.youtube.com/watch?v=${input.videoId}`,
    inLanguage: "pt-BR",
  };
  // </script>-safe, mesmo padrão de buildArchiveNewsArticleJsonLd.
  return `<script type="application/ld+json">${JSON.stringify(node).replaceAll("<", "\\u003c")}</script>`;
}

/**
 * Aplica o vídeo à página: player no lugar do hero com link (e da legenda de
 * crédito da imagem logo abaixo dele, que deixa de descrever o que aparece) +
 * UTM da web nos links do YouTube. O id vem de `input.videoUrl` (disco) ou do
 * próprio link do hero; link pro canal sem URL de vídeo = sem player.
 */
export function applyWebVideo(html: string, input: WebVideoInput, fallbackTitle: string): WebVideoResult {
  let videoId: string | null = null;
  const fromDisk = input.videoUrl ? extractYouTubeVideoId(input.videoUrl) : null;
  const m = HERO_VIDEO_RE.exec(html);
  let out = html;
  if (m) {
    const hrefM = HREF_RE.exec(m[0]);
    const fromHero = hrefM ? extractYouTubeVideoId(unescAttr(hrefM[1])) : null;
    videoId = fromDisk ?? fromHero;
    if (videoId) {
      const title = (input.name ?? "").trim() || fallbackTitle;
      out = out.slice(0, m.index) + buildVideoEmbedHtml(videoId, title) + out.slice(m.index + m[0].length);
    }
  }
  return { html: rewriteVideoUtmsForWeb(out), videoId };
}
