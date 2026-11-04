/**
 * scripts/lib/site-page-video-republish.ts (#12080, item 3)
 *
 * "Atualizar a página da edição depois do envio quando o vídeo aparecer."
 *
 * A página `diar.ia.br/p/{slug}` sai no início da Etapa 5 (§5b-site). Se o
 * vídeo do D1 ainda não tinha URL nessa hora (261028, 261103), a página fica
 * com a imagem apontando pro canal. Quem grava a URL depois é a task
 * `Diaria-Video-D1-Link-Watch` (`video-d1-link-watch.ts`, 06:05 BRT); com o
 * desfecho `aplicado`, ela consulta esta decisão e, se for o caso, roda
 * `publish-edition-site-page.ts` de novo — a página nova lê o vídeo do disco
 * (`_internal/05-video-url.txt`) e troca o link do canal pelo player.
 *
 * O state da página (`_internal/site-page-published.json`) grava a URL do
 * vídeo que a página publicada embutiu (`SITE_PAGE_VIDEO_URL_FIELD`). PURO.
 */

import { extractYouTubeVideoId } from "./diaria/d1-video-link.ts";

/** Campo do state da página com a URL do vídeo embutido (`null` = sem vídeo). */
export const SITE_PAGE_VIDEO_URL_FIELD = "video_url";

export type SiteVideoRepublishDecision =
  | { republish: true; reason: string }
  | { republish: false; reason: string };

/**
 * Republica quando a página já foi publicada e o vídeo do disco não é o que
 * ela embutiu. Página nunca publicada fica com o fluxo normal da Etapa 5/6
 * (ela vai ler o vídeo quando sair); state ilegível não republica.
 */
export function siteVideoRepublishDecision(state: unknown, videoUrl: string | null): SiteVideoRepublishDecision {
  if (!videoUrl) return { republish: false, reason: "edição sem URL de vídeo no disco" };
  const id = extractYouTubeVideoId(videoUrl);
  if (!id) return { republish: false, reason: `URL de vídeo inválida: ${videoUrl}` };
  if (!state || typeof state !== "object") return { republish: false, reason: "página da edição ainda não publicada (sem state)" };
  const s = state as Record<string, unknown>;
  if (s.published !== true) return { republish: false, reason: "página da edição ainda não publicada" };
  const embedded = typeof s[SITE_PAGE_VIDEO_URL_FIELD] === "string" ? (s[SITE_PAGE_VIDEO_URL_FIELD] as string) : null;
  if (embedded && extractYouTubeVideoId(embedded) === id) {
    return { republish: false, reason: "a página já embute este vídeo" };
  }
  return {
    republish: true,
    reason: embedded ? `a página embute outro vídeo (${embedded})` : "a página saiu sem o vídeo",
  };
}
