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
 *      na newsletter e nos posts (`readD1VideoUrlForPosts`). Se o convite do
 *      vídeo ainda sobra na edição (`d1_play` em `06-public-images.json` ou a
 *      imagem com o convite em `_internal/newsletter-final.html`: faltou o
 *      upload em modo newsletter ou o re-render, #12618) → `no-video-stale`,
 *      que bloqueia com os comandos.
 *   2. `05-video-url.txt` com link do YouTube → `link-ready`. Um link já
 *      gravado vai para o D1 mesmo com `--skip youtube` (os publishers não
 *      leem o consent): `--skip youtube` só DISPENSA o pré-requisito. Com
 *      `05-youtube-published.json` deste vídeo, o estado relido
 *      (`resolveYouTubeState`, #573) passa pelo mesmo critério do link no D1
 *      (`gateVideoLink`, #10858): privado, estado não confirmado ou agendado
 *      depois do D1 → `link-may-not-open` (#12598), que só AVISA (default
 *      sugerido na issue; bloquear é decisão do editor), no resumo da Etapa 5
 *      e no gate da Etapa 6.
 *   3. `05-video-url.txt` presente mas inválido → `invalid-link`.
 *   4. `--skip youtube`/`none` no consent → `skipped-by-consent`.
 *   5. `05-youtube-published.json` sem link → `video-without-link`.
 *   6. Nada → `no-video`.
 *
 * Bloqueiam: `invalid-link`, `video-without-link`, `no-video`, `no-video-stale` — exceto
 * depois da Etapa 5 concluída (`.step-5-done.json`): retry de canal
 * (`/diaria-5-publicacao newsletter|social`) não volta a exigir um vídeo que
 * a primeira rodada já dispensou (o Passo 0 reescreve o consent a cada
 * invocação, então o `--skip youtube` daquela rodada não fica gravado).
 *
 * Arquivo ilegível nunca lança: link ilegível vira `invalid-link`; consent
 * ilegível conta como auto (fail-closed: bloqueia) e o motivo vai no texto.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { D1_VIDEO_URL_FILE } from "./d1-video-link.ts";
import { readD1VideoUrl } from "./d1-video-link-file.ts";
import { D1_NO_VIDEO_MARKER_FILE, isNoVideoEdition } from "./d1-no-video.ts";
import { D1_INVITE_TEXT, D1_PLAY_HERO_FILE, D1_PLAY_IMAGE_KEY } from "./d1-video-hero.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";
import { YOUTUBE_API_PROJECT_AUDITED } from "./youtube-video.ts";
import {
  d1SocialSlotAt,
  gateVideoLink,
  newsletterSendAt,
  readYouTubeRecordSummary,
  videoLinkRemedy,
} from "./youtube-video-link-gate.ts";
import { resolveYouTubeState, type YouTubeVideoLike } from "../publish-state.ts";
import { youtubeUploadEnabled, type PublishConsent } from "../publish-consent.ts";

export const PUBLISH_CONSENT_FILE = "_internal/05-publish-consent.json";
/** Sentinel da Etapa 5 (`pipeline-sentinel.ts write --step 5`). */
export const STAGE5_DONE_FILE = "_internal/.step-5-done.json";

export type VideoBeforePublishStatus =
  | "link-ready"
  /** #12598: link gravado, mas o registro do upload diz que o vídeo pode não abrir no horário do D1. Só avisa. */
  | "link-may-not-open"
  | "no-video-marked"
  /** #12618: edição marcada sem vídeo, mas o convite do vídeo ainda está no cache de imagens ou no HTML final. */
  | "no-video-stale"
  | "skipped-by-consent"
  | "invalid-link"
  | "video-without-link"
  | "no-video";

/** Status que, antes da Etapa 5 concluída, impedem o dispatch. */
export const BLOCKING_STATUSES: ReadonlySet<VideoBeforePublishStatus> = new Set([
  "invalid-link",
  "video-without-link",
  "no-video",
  "no-video-stale",
]);

/** Cache das imagens públicas da edição (`upload-images-public.ts`). */
export const PUBLIC_IMAGES_FILE = "06-public-images.json";
/** HTML final da newsletter (Stage 4: `render-newsletter-html.ts` + `substitute-image-urls.ts`). */
export const NEWSLETTER_FINAL_HTML_FILE = "_internal/newsletter-final.html";

export interface VideoBeforePublishResult {
  status: VideoBeforePublishStatus;
  /** Link que vai para o D1; só em `link-ready` e `link-may-not-open`. */
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

/**
 * #12618: o que sobrou do convite do vídeo numa edição marcada sem vídeo.
 * `set-d1-no-video.ts` só grava o marcador e apaga a cópia do disco; a chave
 * `d1_play` sai do cache no próximo `upload-images-public.ts --mode
 * newsletter`, e o HTML só perde a imagem com o convite no re-render. Arquivo
 * ausente não acusa nada (não há o que estar defasado); arquivo ilegível
 * acusa, porque não dá para confirmar que o convite saiu.
 */
export function noVideoLeftovers(editionDir: string): string[] {
  const out: string[] = [];
  const cachePath = join(editionDir, PUBLIC_IMAGES_FILE);
  let playUrl: string | null = null;
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as { images?: Record<string, { url?: unknown } | undefined> };
      const entry = raw.images?.[D1_PLAY_IMAGE_KEY];
      if (entry) {
        out.push(`${PUBLIC_IMAGES_FILE} ainda tem a chave ${D1_PLAY_IMAGE_KEY}`);
        if (typeof entry.url === "string" && entry.url) playUrl = entry.url;
      }
    } catch (e) {
      out.push(`${PUBLIC_IMAGES_FILE} ilegível (${(e as Error).message}): não dá para confirmar que ${D1_PLAY_IMAGE_KEY} saiu`);
    }
  }
  const htmlPath = join(editionDir, NEWSLETTER_FINAL_HTML_FILE);
  if (existsSync(htmlPath)) {
    let html: string | null = null;
    try {
      html = readFileSync(htmlPath, "utf8");
    } catch (e) {
      out.push(`${NEWSLETTER_FINAL_HTML_FILE} ilegível (${(e as Error).message}): não dá para confirmar que o convite saiu`);
    }
    if (html !== null && (html.includes(D1_INVITE_TEXT) || html.includes(D1_PLAY_HERO_FILE) || (playUrl !== null && html.includes(playUrl)))) {
      out.push(`${NEWSLETTER_FINAL_HTML_FILE} ainda leva a imagem do D1 com o convite "${D1_INVITE_TEXT}"`);
    }
  }
  return out;
}

/** Os comandos que aplicam o marcador sem vídeo (#11125, #12618): upload em modo newsletter + re-render. */
export function noVideoApplyCommands(editionDir: string): string {
  const d = editionDir.replace(/[\\/]+$/, "");
  return (
    `npx tsx scripts/upload-images-public.ts --edition-dir ${d}/ --mode newsletter, ` +
    `depois npx tsx scripts/render-newsletter-html.ts ${d} --format html --out ${d}/_internal/newsletter-draft.html ` +
    `e npx tsx scripts/substitute-image-urls.ts --html ${d}/_internal/newsletter-draft.html --images ${d}/${PUBLIC_IMAGES_FILE} --out ${d}/${NEWSLETTER_FINAL_HTML_FILE}`
  );
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Horário do post do D1 pelo `platform.config.json` do repo; `null` se não der (nunca lança). */
export function loadD1SlotAtFromConfig(aammdd: string, rootDir: string = REPO_ROOT): Date | null {
  try {
    const cfg = JSON.parse(readFileSync(join(rootDir, "platform.config.json"), "utf8")) as {
      publishing?: { social?: Record<string, unknown> };
    };
    return d1SocialSlotAt(aammdd, cfg.publishing?.social ?? null);
  } catch {
    return null;
  }
}

/** Estado do `rereadStatus` do registro com o relógio de agora (#573); `null` sem `privacyStatus` no registro. */
function rereadStateNow(editionDir: string, now: Date): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(editionDir, YOUTUBE_PUBLISHED_FILE), "utf8")) as { rereadStatus?: YouTubeVideoLike["status"] };
    const st = raw.rereadStatus;
    if (!st || typeof st !== "object" || typeof st.privacyStatus !== "string") return null;
    return resolveYouTubeState({ status: st }, now);
  } catch {
    return null;
  }
}

export interface AssessVideoOptions {
  now?: Date;
  /** Horário do post do D1. Ausente = `platform.config.json` do repo; `null` = desconhecido. */
  d1SlotAt?: Date | null;
}

/**
 * #12598: o link gravado abre para o leitor no horário do D1? Só com registro
 * do upload DESTE vídeo (mesmo id): link colado à mão de outro vídeo não tem
 * o que conferir. `null` = nada a avisar. Registro ilegível vira aviso (não dá
 * para conferir). O agendado sem auditoria até o envio do D1 passa sem aviso
 * aqui, como no `gateVideoLink` (o upload já avisou, #11548).
 */
export function videoReaderAccessWarning(
  editionDir: string,
  aammdd: string,
  videoUrl: string,
  opts: AssessVideoOptions = {},
): string | null {
  if (!existsSync(join(editionDir, YOUTUBE_PUBLISHED_FILE))) return null;
  const now = opts.now ?? new Date();
  let record;
  try {
    record = readYouTubeRecordSummary(editionDir);
  } catch (e) {
    return `Link do vídeo pronto, mas não deu para conferir se ele abre para o leitor: ${(e as Error).message}.`;
  }
  if (!record) return null;
  const state = rereadStateNow(editionDir, now) ?? record.state;
  const d1SlotAt = opts.d1SlotAt !== undefined ? opts.d1SlotAt : loadD1SlotAtFromConfig(aammdd);
  const gate = gateVideoLink({
    videoUrl,
    record: { ...record, state },
    d1SlotAt,
    newsletterSendAt: newsletterSendAt(editionDir, aammdd).at,
  });
  if (gate.ok || !gate.record_matched) return null;
  const projectAudited = record.auditBlocked == null ? YOUTUBE_API_PROJECT_AUDITED : !record.auditBlocked;
  return (
    `Link do vídeo pronto (${videoUrl}), mas o vídeo pode não abrir para o leitor no horário do D1: ${gate.reason}. ` +
    `${videoLinkRemedy(projectAudited)} antes do D1. ` +
    `Se ele já está público (ou o link foi gravado com link-video-d1.ts --assume-public depois de conferir no Studio), ignore este aviso.`
  );
}

export function assessVideoBeforePublish(editionDir: string, aammdd: string, opts: AssessVideoOptions = {}): VideoBeforePublishResult {
  const result = (status: VideoBeforePublishStatus, videoUrl: string | null, warning: string | null): VideoBeforePublishResult => {
    const stage5Done = existsSync(join(editionDir, STAGE5_DONE_FILE));
    const blocking = BLOCKING_STATUSES.has(status) && !stage5Done;
    const retryNote = BLOCKING_STATUSES.has(status) && stage5Done ? " Etapa 5 já concluída (retry de canal): não bloqueia." : "";
    return { status, videoUrl, blocking, warning: warning === null ? null : warning + retryNote };
  };

  if (isNoVideoEdition(editionDir)) {
    const leftovers = noVideoLeftovers(editionDir);
    if (leftovers.length > 0) {
      return result(
        "no-video-stale",
        null,
        `Edição ${aammdd} marcada sem vídeo (${D1_NO_VIDEO_MARKER_FILE}), mas o convite do vídeo ainda está na edição: ${leftovers.join("; ")}. ` +
          `Falta aplicar o marcador (#11125): ${noVideoApplyCommands(editionDir)}. Depois rode de novo.`,
      );
    }
    return result("no-video-marked", null, `Edição ${aammdd} marcada sem vídeo (${D1_NO_VIDEO_MARKER_FILE}): o D1 sai sem o link, por decisão do editor.`);
  }
  const read = readD1VideoUrl(editionDir);
  if (read.url) {
    const access = videoReaderAccessWarning(editionDir, aammdd, read.url, opts);
    return access ? result("link-may-not-open", read.url, access) : result("link-ready", read.url, null);
  }
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
