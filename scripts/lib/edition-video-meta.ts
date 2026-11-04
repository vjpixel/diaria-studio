/**
 * scripts/lib/edition-video-meta.ts (#12073, #12080, #12081)
 *
 * Vídeo do D1 de uma edição, lido do disco: URL, id, título e data de
 * publicação. Fonte única para o box do vídeo no slot 0 da newsletter
 * (#12073), o embed + `VideoObject` da página web da edição (#12080) e a
 * escolha do vídeo mais visto de um período (#12081).
 *
 * A regra de "a edição tem vídeo" é a mesma do link da imagem do D1
 * (`d1VideoHeroFields`, #10784): existe `_internal/05-video-url.txt` com URL
 * de vídeo válida e a edição não está marcada sem vídeo
 * (`_internal/no-video.json`, #11125). Sem o arquivo, nada de vídeo — nunca o
 * canal no lugar.
 *
 * Título e data vêm do registro do upload (`_internal/05-youtube-published.json`)
 * só quando o registro é DESTE vídeo (mesmo id); senão ficam `null` e cada
 * consumidor decide o fallback (título do D1, data da edição).
 *
 * Fail-soft: arquivo ilegível vira ausência, nunca exceção — o vídeo é
 * acessório em todas as superfícies que leem isto.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractYouTubeVideoId } from "./diaria/d1-video-link.ts";
import { readD1VideoUrl } from "./diaria/d1-video-link-file.ts";
import { isNoVideoEdition } from "./diaria/d1-no-video.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./diaria/youtube-upload.ts";

export interface EditionVideoMeta {
  /** URL normalizada do vídeo (`https://youtu.be/{id}`). */
  videoUrl: string;
  videoId: string;
  /** Título do vídeo no YouTube (registro do upload), ou `null`. */
  title: string | null;
  /** ISO da publicação (agendada ou feita) do vídeo, ou `null`. */
  uploadDate: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Pure: título e data do registro do upload, se ele for do vídeo `videoId`. */
export function videoRecordFields(
  raw: unknown,
  videoId: string,
): { title: string | null; uploadDate: string | null } {
  if (!raw || typeof raw !== "object") return { title: null, uploadDate: null };
  const r = raw as Record<string, unknown>;
  if (str(r.videoId) !== videoId) return { title: null, uploadDate: null };
  const reread = (r.rereadStatus ?? null) as { publishAt?: unknown } | null;
  const requested = (r.requested ?? null) as { publishAt?: unknown } | null;
  return {
    title: str(r.title),
    uploadDate: str(reread?.publishAt) ?? str(requested?.publishAt) ?? str(r.uploadedAt),
  };
}

/** Vídeo do D1 da edição, ou `null` (sem vídeo, marcada sem vídeo, URL inválida). */
export function readEditionVideoMeta(editionDir: string): EditionVideoMeta | null {
  if (!existsSync(editionDir)) return null;
  if (isNoVideoEdition(editionDir)) return null;
  const { url } = readD1VideoUrl(editionDir);
  if (!url) return null;
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;
  let raw: unknown = null;
  const recordPath = join(editionDir, YOUTUBE_PUBLISHED_FILE);
  if (existsSync(recordPath)) {
    try {
      raw = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      raw = null;
    }
  }
  return { videoUrl: `https://youtu.be/${videoId}`, videoId, ...videoRecordFields(raw, videoId) };
}
