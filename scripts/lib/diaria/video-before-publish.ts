/**
 * scripts/lib/diaria/video-before-publish.ts (#10943, gate desde #12588)
 *
 * Pré-requisito do `/diaria-5-publicacao` (Passo 0b): o D1 vai sair com o
 * link do vídeo do dia? A ordem montagem → `/diaria-publica-video` → Etapa 5
 * é obrigatória (decisão do editor, 10/11/2026, #12588: "é necessário inserir
 * o link do Youtube na edição"), e desde o #12591 a própria
 * `/diaria-publica-video` segue para a Etapa 5 depois do horizontal.
 *
 * Bloqueia (`blocking: true`) quando não há link nem decisão explícita de
 * seguir sem ele. Não bloqueia: link pronto, edição marcada sem vídeo
 * (`_internal/no-video.json`, `set-d1-no-video.ts`, #11125) ou
 * `--skip youtube` no consent da Etapa 5 (`youtubeUploadEnabled` falso).
 * Até o #12588 isto era só aviso, e o D1 saía sem o link em silêncio.
 *
 * Arquivo ilegível nunca lança: vira o motivo do bloqueio.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { D1_VIDEO_URL_FILE } from "./d1-video-link.ts";
import { readD1VideoUrl } from "./d1-video-link-file.ts";
import { D1_NO_VIDEO_MARKER_FILE, isNoVideoEdition } from "./d1-no-video.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";
import { youtubeUploadEnabled, type PublishConsent } from "../publish-consent.ts";

export const PUBLISH_CONSENT_FILE = "_internal/05-publish-consent.json";

export type VideoBeforePublishStatus =
  /** `05-video-url.txt` com URL válida: o D1 sai com o link. */
  | "link-ready"
  /** `_internal/no-video.json`: o editor decidiu que a edição não tem vídeo. */
  | "no-video-marked"
  /** `--skip youtube` (ou `none`) no consent da Etapa 5. */
  | "skipped-by-consent"
  /** Vídeo subiu (`05-youtube-published.json`), mas o link não foi liberado. */
  | "video-without-link"
  /** Nem registro de upload nem `05-video-url.txt`. */
  | "no-video";

export interface VideoBeforePublishResult {
  status: VideoBeforePublishStatus;
  videoUrl: string | null;
  /** `true` = a Etapa 5 para antes do dispatch (halt banner). */
  blocking: boolean;
  /** Texto ao editor; `null` quando `status === "link-ready"`. */
  warning: string | null;
}

/** Consent da Etapa 5 desliga o vídeo? Ausente/ilegível = não (auto). */
function consentSkipsVideo(editionDir: string): boolean {
  const p = join(editionDir, PUBLISH_CONSENT_FILE);
  if (!existsSync(p)) return false;
  try {
    return !youtubeUploadEnabled(JSON.parse(readFileSync(p, "utf8")) as PublishConsent);
  } catch {
    return false;
  }
}

/** As duas saídas do bloqueio, iguais em todo texto. */
export function videoGateActions(aammdd: string): string {
  return (
    `rode /diaria-publica-video ${aammdd} (sobe o horizontal, grava o link e segue para a Etapa 5), ` +
    `ou, se a edição não tem vídeo, npx tsx scripts/set-d1-no-video.ts ${aammdd} ` +
    `(depois upload-images-public.ts --mode newsletter e o re-render do HTML, #11125) e rode de novo`
  );
}

export function assessVideoBeforePublish(editionDir: string, aammdd: string): VideoBeforePublishResult {
  // #11125: o marcador vence a URL do vídeo.
  if (isNoVideoEdition(editionDir)) {
    return {
      status: "no-video-marked",
      videoUrl: null,
      blocking: false,
      warning: `Edição ${aammdd} marcada sem vídeo (${D1_NO_VIDEO_MARKER_FILE}): o D1 sai sem o link, por decisão do editor.`,
    };
  }
  const read = readD1VideoUrl(editionDir);
  if (read.url) return { status: "link-ready", videoUrl: read.url, blocking: false, warning: null };

  if (consentSkipsVideo(editionDir)) {
    return {
      status: "skipped-by-consent",
      videoUrl: null,
      blocking: false,
      warning: `--skip youtube nesta Etapa 5 (${PUBLISH_CONSENT_FILE}): o D1 da edição ${aammdd} sai SEM o link do vídeo.`,
    };
  }

  const invalidNote = read.warning ? ` (${read.warning})` : "";
  if (existsSync(join(editionDir, YOUTUBE_PUBLISHED_FILE))) {
    return {
      status: "video-without-link",
      videoUrl: null,
      blocking: true,
      warning:
        `O vídeo da edição ${aammdd} subiu (${YOUTUBE_PUBLISHED_FILE}), mas ${D1_VIDEO_URL_FILE} não tem link${invalidNote}. ` +
        `A Etapa 5 não publica sem o link do vídeo no D1 (#12588). Libere o link e rode de novo: ` +
        `npx tsx scripts/link-video-d1.ts ${aammdd} --save (com --assume-public se ele recusar e o vídeo já estiver público ou agendado antes do D1)`,
    };
  }
  return {
    status: "no-video",
    videoUrl: null,
    blocking: true,
    warning:
      `Nenhum vídeo da edição ${aammdd} (${YOUTUBE_PUBLISHED_FILE} e ${D1_VIDEO_URL_FILE} ausentes)${invalidNote}. ` +
      `A ordem é /diaria-video-montagem, /diaria-publica-video, Etapa 5: a Etapa 5 não publica sem o link do vídeo no D1 (#12588). ` +
      `Saídas: ${videoGateActions(aammdd)}.`,
  };
}
