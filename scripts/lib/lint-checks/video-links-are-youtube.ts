/**
 * lint-checks/video-links-are-youtube.ts (#3202)
 *
 * Verifica que todo item da seção VÍDEOS de `02-reviewed.md` linka pro
 * YouTube (`youtube.com/watch` ou `youtu.be`) — nunca a página que apenas
 * embeda o vídeo (blog, página oficial da empresa, etc.).
 *
 * Motivação: na 260709 a página oficial da OpenAI que hospedava a livestream
 * "Introducing GPT-Live" bloqueou o bot (403) e acabou usada como URL do
 * vídeo — mesma URL de um destaque, gerando duplicação. #3202 adiciona
 * resolução automática pra YouTube no Stage 1 (`scripts/resolve-video-
 * youtube.ts`); este lint é o backstop GATE-BLOCKING que garante que nenhum
 * item não-YouTube sobrevive até o gate (mesmo se a resolução automática foi
 * pulada, ou se o editor colou um link não-YouTube manualmente no Drive).
 *
 * Reusa `extractUrlsBySection` (mesma infra de `url-bucket.ts` — fonte única
 * de parsing de seção) pra pegar as URLs dentro dos limites da seção VÍDEOS,
 * sem acoplar ao formato exato do item.
 *
 * Exit via CLI:
 *   0 — todos os itens de VÍDEOS são youtube.com/youtu.be (ou seção ausente/vazia)
 *   1 — algum item de VÍDEOS não é YouTube
 *   2 — erro de argumento / arquivo não encontrado
 */

import { extractUrlsBySection } from "./url-bucket.ts";
import { isYoutubeUrl } from "../video-youtube-resolve.ts";

export interface VideoLinkYoutubeError {
  /** Linha do item (1-based). */
  line: number;
  url: string;
}

export interface VideoLinkYoutubeReport {
  ok: boolean;
  errors: VideoLinkYoutubeError[];
}

/**
 * Varre `md` e retorna erro para cada URL na seção VÍDEOS que NÃO é do
 * YouTube. Dedup por URL (markdown link `[label](url)` casa a mesma URL 2x).
 */
export function checkVideoLinksAreYoutube(md: string): VideoLinkYoutubeReport {
  const urlsBySection = extractUrlsBySection(md);
  const videoUrls = urlsBySection["VÍDEOS"] ?? [];

  const errors: VideoLinkYoutubeError[] = [];
  const seen = new Set<string>();
  for (const { url, line } of videoUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isYoutubeUrl(url)) {
      errors.push({ line, url });
    }
  }

  return { ok: errors.length === 0, errors };
}
