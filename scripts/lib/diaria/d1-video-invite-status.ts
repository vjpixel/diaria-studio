/**
 * scripts/lib/diaria/d1-video-invite-status.ts (#12946)
 *
 * Diz, a partir do disco da edição, se o D1 da newsletter sai com o convite
 * de vídeo ("Clique para assistir meus comentários", cópia
 * `04-d1-2x1-play.jpg`, #10784) — e monta a linha que o gate 4 mostra.
 *
 * Por que existe: na edição 261113 o D1 foi trocado no gate, o
 * `image-generate.ts` + upload geraram a cópia com o convite e a newsletter
 * saiu renderizada com ele, embora a edição não fosse ter vídeo
 * (`set-d1-no-video.ts` só estava previsto para depois do `sim`). O editor
 * só notou porque olhou a imagem. O gate passa a dizer, em texto, o estado
 * do convite e a oferecer "sem vídeo" ali mesmo.
 *
 * Estados (`D1InviteState`):
 *   - `no-video`: marcador `_internal/no-video.json` (#11125) — o render sai
 *     com o hero puro, qualquer que seja o resto;
 *   - `invite`: a cópia com o convite existe no disco ou a chave `d1_play`
 *     está em `06-public-images.json` — o render põe o convite e o link;
 *   - `pending`: nenhum dos dois — o próximo upload em modo newsletter gera a
 *     cópia (o convite aparece no re-render seguinte).
 *
 * Só leitura; nada aqui grava.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { D1_INVITE_TEXT, D1_PLAY_HERO_FILE, D1_PLAY_IMAGE_KEY, editionFromDir } from "./d1-video-hero.ts";
import { D1_NO_VIDEO_MARKER_FILE, isNoVideoEdition } from "./d1-no-video.ts";
import { readD1VideoUrl } from "./d1-video-link-file.ts";

export type D1InviteState = "no-video" | "invite" | "pending";

export interface D1VideoInviteStatus {
  state: D1InviteState;
  /** `04-d1-2x1-play.jpg` presente no diretório da edição. */
  play_hero_on_disk: boolean;
  /** Chave `d1_play` presente em `06-public-images.json`. */
  play_hero_public: boolean;
  /** URL do vídeo já gravada (`_internal/05-video-url.txt`), ou null. */
  video_url: string | null;
}

/** `true` se `06-public-images.json` tem a chave `d1_play`. Fail-soft: ilegível = false. */
function publicImagesHasD1Play(editionDir: string): boolean {
  const p = join(editionDir, "06-public-images.json");
  if (!existsSync(p)) return false;
  try {
    const images = (JSON.parse(readFileSync(p, "utf8")) as { images?: unknown }).images;
    if (!images || typeof images !== "object" || Array.isArray(images)) return false;
    return Object.prototype.hasOwnProperty.call(images, D1_PLAY_IMAGE_KEY);
  } catch {
    return false;
  }
}

/** Lê o estado do convite do D1 no disco da edição. */
export function readD1VideoInviteStatus(editionDir: string): D1VideoInviteStatus {
  const playOnDisk = existsSync(join(editionDir, D1_PLAY_HERO_FILE));
  const playPublic = publicImagesHasD1Play(editionDir);
  const video = readD1VideoUrl(editionDir).url;
  const state: D1InviteState = isNoVideoEdition(editionDir)
    ? "no-video"
    : playOnDisk || playPublic
      ? "invite"
      : "pending";
  return { state, play_hero_on_disk: playOnDisk, play_hero_public: playPublic, video_url: video };
}

/** Comando que marca a edição como sem vídeo (com `--edition-dir`, que vence o path derivado). */
export function setNoVideoCommand(editionDir: string): string {
  const dir = editionDir.replace(/[\\/]+$/, "");
  const aammdd = editionFromDir(dir) ?? "AAMMDD";
  return `npx tsx scripts/set-d1-no-video.ts ${aammdd} --edition-dir ${dir}`;
}

/**
 * Linha do gate 4 (`{d1_video_invite_line}`). Com o convite ligado, inclui a
 * oferta "sem vídeo" e os 3 comandos que o orchestrator roda se o editor
 * responder isso. @pure
 */
export function formatD1VideoInviteLine(status: D1VideoInviteStatus, editionDir: string): string {
  const dir = editionDir.replace(/[\\/]+$/, "");
  if (status.state === "no-video") {
    return `🎬 D1 SEM convite de vídeo (edição marcada sem vídeo: ${D1_NO_VIDEO_MARKER_FILE}). Para religar: npx tsx scripts/set-d1-no-video.ts ${editionFromDir(dir) ?? "AAMMDD"} --edition-dir ${dir} --clear`;
  }
  const destino = status.video_url ? `link para o vídeo ${status.video_url}` : "link para o canal até o vídeo existir";
  const head =
    status.state === "invite"
      ? `🎬 D1 sai COM o convite "${D1_INVITE_TEXT}" (${D1_PLAY_HERO_FILE}, ${destino}).`
      : `🎬 D1 ainda sem a cópia com o convite — o próximo upload em modo newsletter a gera e o re-render põe "${D1_INVITE_TEXT}" no D1 (${destino}).`;
  return `${head} Sem vídeo hoje? responda "sem vídeo" — marco no-video.json, refaço o upload e re-renderizo aqui no gate.`;
}

/**
 * Passos do "sem vídeo" no gate, em ordem: marcar, re-subir as imagens da
 * newsletter (tira `d1_play` do cache) e re-renderizar o HTML. @pure
 */
export function noVideoGateSteps(editionDir: string): string[] {
  const dir = editionDir.replace(/[\\/]+$/, "");
  return [
    setNoVideoCommand(dir),
    `npx tsx scripts/upload-images-public.ts --edition-dir ${dir}/ --mode newsletter`,
    `Re-render do HTML da newsletter (§4b steps 1-3: render-newsletter-html.ts → embed-images-base64.ts) e re-publicar o Artifact`,
  ];
}

/**
 * #12946 (b): passo extra para os scripts que trocam o D1 no gate. Quando a
 * edição ainda não está marcada sem vídeo, o upload depois da troca recria a
 * cópia com o convite: se a edição não vai ter vídeo, marcar ANTES do upload.
 * Devolve null quando o D1 não mudou ou a edição já está marcada.
 */
export function d1NoVideoSwapStep(editionDir: string, d1Touched: boolean): string | null {
  if (!d1Touched || isNoVideoEdition(editionDir)) return null;
  return (
    `D1 mudou: o upload abaixo recria ${D1_PLAY_HERO_FILE} com "${D1_INVITE_TEXT}". ` +
    `Se a edição NÃO vai ter vídeo, marcar ANTES do upload: ${setNoVideoCommand(editionDir)} (#12946)`
  );
}
