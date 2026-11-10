/**
 * scripts/lib/diaria/video-before-publish.ts (#10943, gate desde #12588)
 *
 * Pré-requisito da Etapa 5: o D1 vai sair com o link do vídeo do dia? A ordem
 * montagem → `/diaria-publica-video` → Etapa 5 é obrigatória (decisão do
 * editor, 10/11/2026, #12588: "é necessário inserir o link do Youtube na
 * edição"), e desde o #12591 a própria `/diaria-publica-video` segue para a
 * Etapa 5 depois do horizontal.
 *
 * Fonte ÚNICA da decisão: o Passo 0b do `/diaria-5-publicacao`
 * (`check-video-before-publish.ts`) e o §5b-youtube (`stage5-youtube.ts`)
 * leem o mesmo resultado, então nunca relatam coisas diferentes sobre a
 * mesma edição. Precedência (primeira que casa):
 *   1. `_internal/no-video.json` (#11125) → `no-video-marked`. Vence a URL,
 *      na newsletter e nos posts (`readD1VideoUrlForPosts`).
 *   2. `05-video-url.txt` com link do YouTube → `link-ready`. Um link já
 *      gravado vai para o D1 mesmo com `--skip youtube` (os publishers não
 *      leem o consent): `--skip youtube` só DISPENSA o pré-requisito.
 *   3. `05-video-url.txt` presente mas inválido → `invalid-link`.
 *   4. `--skip youtube`/`none` no consent → `skipped-by-consent`.
 *   5. `05-youtube-published.json` sem link → `video-without-link`.
 *   6. Nada → `no-video`.
 *
 * Bloqueiam: `invalid-link`, `video-without-link`, `no-video` — exceto
 * depois da Etapa 5 concluída (`.step-5-done.json`): retry de canal
 * (`/diaria-5-publicacao newsletter|social`) não volta a exigir um vídeo que
 * a primeira rodada já dispensou (o Passo 0 reescreve o consent a cada
 * invocação, então o `--skip youtube` daquela rodada não fica gravado).
 *
 * Arquivo ilegível nunca lança: link ilegível vira `invalid-link`; consent
 * ilegível conta como auto (fail-closed: bloqueia) e o motivo vai no texto.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { D1_VIDEO_URL_FILE } from "./d1-video-link.ts";
import { readD1VideoUrl } from "./d1-video-link-file.ts";
import { D1_NO_VIDEO_MARKER_FILE, isNoVideoEdition } from "./d1-no-video.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";
import { youtubeUploadEnabled, type PublishConsent } from "../publish-consent.ts";

export const PUBLISH_CONSENT_FILE = "_internal/05-publish-consent.json";
/** Sentinel da Etapa 5 (`pipeline-sentinel.ts write --step 5`). */
export const STAGE5_DONE_FILE = "_internal/.step-5-done.json";

export type VideoBeforePublishStatus =
  | "link-ready"
  | "no-video-marked"
  | "skipped-by-consent"
  | "invalid-link"
  | "video-without-link"
  | "no-video";

/** Status que, antes da Etapa 5 concluída, impedem o dispatch. */
export const BLOCKING_STATUSES: ReadonlySet<VideoBeforePublishStatus> = new Set(["invalid-link", "video-without-link", "no-video"]);

export interface VideoBeforePublishResult {
  status: VideoBeforePublishStatus;
  /** Link que vai para o D1; só em `link-ready`. */
  videoUrl: string | null;
  /** `true` = a Etapa 5 para antes do dispatch (halt banner). Derivado de `status` + Etapa 5 concluída. */
  blocking: boolean;
  /** Texto ao editor: motivo do bloqueio ou aviso (D1 sem o vídeo por decisão). `null` só em `link-ready`. */
  warning: string | null;
}

/** Consent da Etapa 5: `skip` = `--skip youtube`/`none`; ausente/ilegível = auto, com nota no ilegível. */
export function readVideoConsent(editionDir: string): { skip: boolean; note: string | null } {
  const p = join(editionDir, PUBLISH_CONSENT_FILE);
  if (!existsSync(p)) return { skip: false, note: null };
  try {
    return { skip: !youtubeUploadEnabled(JSON.parse(readFileSync(p, "utf8")) as PublishConsent), note: null };
  } catch (e) {
    return { skip: false, note: `${PUBLISH_CONSENT_FILE} ilegível (${(e as Error).message}): tratado como auto, um --skip youtube dessa rodada não valeu` };
  }
}

/** As saídas do bloqueio, iguais em todo texto. */
export function videoGateActions(aammdd: string): string {
  return (
    `rode /diaria-publica-video ${aammdd} (sobe o horizontal, grava o link e segue para a Etapa 5), ` +
    `ou, se a edição não tem vídeo, npx tsx scripts/set-d1-no-video.ts ${aammdd} ` +
    `(depois upload-images-public.ts --mode newsletter e o re-render do HTML, #11125) e rode de novo, ` +
    `ou rode de novo com --skip youtube`
  );
}

export function assessVideoBeforePublish(editionDir: string, aammdd: string): VideoBeforePublishResult {
  const result = (status: VideoBeforePublishStatus, videoUrl: string | null, warning: string | null): VideoBeforePublishResult => {
    const stage5Done = existsSync(join(editionDir, STAGE5_DONE_FILE));
    const blocking = BLOCKING_STATUSES.has(status) && !stage5Done;
    const retryNote = BLOCKING_STATUSES.has(status) && stage5Done ? " Etapa 5 já concluída (retry de canal): não bloqueia." : "";
    return { status, videoUrl, blocking, warning: warning === null ? null : warning + retryNote };
  };

  if (isNoVideoEdition(editionDir)) {
    return result("no-video-marked", null, `Edição ${aammdd} marcada sem vídeo (${D1_NO_VIDEO_MARKER_FILE}): o D1 sai sem o link, por decisão do editor.`);
  }
  const read = readD1VideoUrl(editionDir);
  if (read.url) return result("link-ready", read.url, null);
  if (read.warning) {
    return result(
      "invalid-link",
      null,
      `${read.warning}. A Etapa 5 não publica sem o link do vídeo no D1 (#12588). ` +
        `Corrija com npx tsx scripts/link-video-d1.ts ${aammdd} --save --video-url URL, ou marque a edição sem vídeo (set-d1-no-video.ts ${aammdd}).`,
    );
  }

  const consent = readVideoConsent(editionDir);
  const consentNote = consent.note ? ` (${consent.note})` : "";
  if (consent.skip) {
    return result("skipped-by-consent", null, `--skip youtube nesta Etapa 5 (${PUBLISH_CONSENT_FILE}): o D1 da edição ${aammdd} sai SEM o link do vídeo.`);
  }
  if (existsSync(join(editionDir, YOUTUBE_PUBLISHED_FILE))) {
    return result(
      "video-without-link",
      null,
      `O vídeo da edição ${aammdd} subiu (${YOUTUBE_PUBLISHED_FILE}), mas ${D1_VIDEO_URL_FILE} não existe${consentNote}. ` +
        `A Etapa 5 não publica sem o link do vídeo no D1 (#12588). Libere o link e rode de novo: ` +
        `npx tsx scripts/link-video-d1.ts ${aammdd} --save (com --assume-public se ele recusar e o vídeo já estiver público ou agendado antes do D1)`,
    );
  }
  return result(
    "no-video",
    null,
    `Nenhum vídeo da edição ${aammdd} (${YOUTUBE_PUBLISHED_FILE} e ${D1_VIDEO_URL_FILE} ausentes)${consentNote}. ` +
      `A ordem é /diaria-video-montagem, /diaria-publica-video, Etapa 5: a Etapa 5 não publica sem o link do vídeo no D1 (#12588). ` +
      `Saídas: ${videoGateActions(aammdd)}.`,
  );
}
