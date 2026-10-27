/**
 * scripts/lib/diaria/video-before-publish.ts (#10943)
 *
 * Aviso (nunca gate) do `/diaria-5-publicacao`: o vídeo do dia já passou
 * pelo `/diaria-publica-video` antes da Etapa 5? O fluxo ideal desde
 * 22/10/2026 é `/diaria-edicao` → `/diaria-publica-video` (que juntou o
 * `/diaria-youtube` e o `/diaria-shorts`, #11209) → `/diaria-5-publicacao`,
 * cada skill standalone (#5578). Com o vídeo antes,
 * o Stage 5 já encontra `_internal/05-video-url.txt` e põe o link no D1 de
 * X, Threads e Facebook na criação do post (#10772, #10858).
 *
 * Sem vídeo a Etapa 5 segue normal (o vídeo pode ainda não existir): o
 * resultado só diz ao editor que o D1 vai sair sem o link. Fail-soft: arquivo
 * ilegível vira aviso, nunca exceção.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { D1_VIDEO_URL_FILE } from "./d1-video-link.ts";
import { readD1VideoUrl } from "./d1-video-link-file.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";

export type VideoBeforePublishStatus =
  /** `05-video-url.txt` com URL válida: o D1 sai com o link. */
  | "link-ready"
  /** Vídeo subiu (`05-youtube-published.json`), mas o link não foi liberado. */
  | "video-without-link"
  /** Nem registro de upload nem `05-video-url.txt`. */
  | "no-video";

export interface VideoBeforePublishResult {
  status: VideoBeforePublishStatus;
  videoUrl: string | null;
  /** Texto do aviso ao editor; `null` quando `status === "link-ready"`. */
  warning: string | null;
}

export function assessVideoBeforePublish(editionDir: string, aammdd: string): VideoBeforePublishResult {
  const read = readD1VideoUrl(editionDir);
  if (read.url) return { status: "link-ready", videoUrl: read.url, warning: null };

  const invalidNote = read.warning ? ` (${read.warning})` : "";
  if (existsSync(join(editionDir, YOUTUBE_PUBLISHED_FILE))) {
    return {
      status: "video-without-link",
      videoUrl: null,
      warning:
        `O vídeo da edição ${aammdd} subiu (${YOUTUBE_PUBLISHED_FILE}), mas ${D1_VIDEO_URL_FILE} não tem link${invalidNote}: ` +
        `o D1 de X, Threads e Facebook sairá SEM o link do vídeo. Se o vídeo já está público (ou agendado antes do D1), ` +
        `libere o link antes de seguir: npx tsx scripts/link-video-d1.ts ${aammdd} --save --assume-public`,
    };
  }
  return {
    status: "no-video",
    videoUrl: null,
    warning:
      `Nenhum vídeo da edição ${aammdd} (${YOUTUBE_PUBLISHED_FILE} e ${D1_VIDEO_URL_FILE} ausentes)${invalidNote}: ` +
      `o D1 de X, Threads e Facebook sairá SEM o link do vídeo. Fluxo ideal (#10943, #11209): /diaria-publica-video ${aammdd} ` +
      `antes de /diaria-5-publicacao. A publicação segue mesmo assim (aviso, não gate).`,
  };
}
