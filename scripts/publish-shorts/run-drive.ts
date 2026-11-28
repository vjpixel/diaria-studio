/**
 * `--from-drive` da rodada (#14327 item 5): baixa o vertical do Drive para o
 * caminho local do vídeo antes de a rodada lê-lo, e no corte avulso confere de
 * novo o "pode publicar" contra os bytes baixados (#11912).
 *
 * Movido de `mainUnlocked` (`run.ts`) sem mudança de comportamento; a
 * condição (`values["from-drive"]`) segue lá.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shortsVideoTerminal } from "../lib/diaria/published-video-cleanup.ts";
import type { CorteSpec } from "../lib/diaria/short-corte.ts";
import { loadShortsConfig } from "../lib/diaria/short-video.ts";
import { gFetchRetry } from "../lib/drive-helpers.ts";
import { DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS, DriveDownloadEmptyError, downloadDriveFileById } from "../lib/drive-download.ts";
import { PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT } from "../lib/diaria/vertical-download-guard.ts";
import { ROOT } from "./_shared.ts";
import { type CorteRevocation, syncCorteAuthorizationWithContent } from "./corte.ts";

/**
 * #14327: o download do `--from-drive`. Devolve o exit code quando a rodada
 * termina aqui (destinos já concluídos `0`, id inválido `2`, download falho
 * `1`, arquivo ainda subindo `PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT`), ou o
 * corte com a autorização reconferida (no modo edição, `null` como entrou).
 */
export async function fetchShortsVideoFromDrive(input: {
  driveId: string;
  dir: string;
  aammdd: string;
  videoPath: string;
  replaceRun: boolean;
  corte: CorteSpec | null;
  requireCorteAuth: boolean;
  cleanup: () => void;
  onRevoked: (r: CorteRevocation) => void;
}): Promise<number | { corte: CorteSpec | null }> {
  const { dir, aammdd, videoPath, replaceRun, requireCorteAuth, cleanup } = input;
  let corte = input.corte;
  // #12279: na substituição todos os destinos já estão registrados; o V2 baixa assim mesmo.
  if (!replaceRun && !existsSync(videoPath) && shortsVideoTerminal(dir, aammdd,
    loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))))) {
    cleanup();
    console.error("[ok] destinos do vertical já concluídos — nada a baixar");
    return 0;
  }
  const id = input.driveId;
  if (!/^[\w-]{10,}$/.test(id)) {
    console.error(`--from-drive espera o id do arquivo no Drive, recebido ${JSON.stringify(id)}`);
    return 2;
  }
  if (existsSync(videoPath)) console.error(`[aviso] substituindo ${videoPath} pelo arquivo do Drive`);
  // #11082: mesmo download protegido do fetch-drive-video.ts (.part, teto de 20 min,
  // 60 s sem bytes aborta, tamanho conferido contra o metadado, só .mp4).
  try {
    const { bytes } = await downloadDriveFileById(
      { driveFetch: (url, init) => gFetchRetry(url, init ?? {}) },
      id,
      videoPath,
      DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS,
      (line) => console.error(line),
    );
    console.error(`[ok] vídeo curto baixado do Drive (${(bytes / 1e6).toFixed(1)} MB) → ${videoPath}`);
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    // #13540/#13541: arquivo ainda subindo para o Drive — exit próprio, que os timers leem como espera.
    return e instanceof DriveDownloadEmptyError ? PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT : 1;
  }
  // #11912: outro arquivo no lugar do vídeo aprovado não herda o "pode publicar".
  if (corte && !requireCorteAuth) corte = syncCorteAuthorizationWithContent(dir, new Date().toISOString(), { log: (l) => console.error(l), onRevoked: input.onRevoked });
  return { corte };
}
