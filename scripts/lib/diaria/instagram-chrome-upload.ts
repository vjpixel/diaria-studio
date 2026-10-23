/**
 * scripts/lib/diaria/instagram-chrome-upload.ts (#10915)
 *
 * Versão do vertical que cabe no `file_upload` do Claude in Chrome (10 MB por
 * chamada), para postar o Reels pelo instagram.com quando a API recusa a
 * duração (#10893/#10916). Rota validada em 22/10/2026 com o vertical de
 * 261022 (114 s, 56 MB): ffmpeg 2-pass, 720x1280, `-b:v 590k`, AAC 64k 48 kHz,
 * `+faststart` deu 9,5 MB, e o editor aprovou a qualidade
 * (https://www.instagram.com/reel/Dezuxl2q6Xy/).
 *
 * Aqui fica só o miolo puro (bitrate e argumentos do ffmpeg); quem roda o
 * ffmpeg é o `scripts/publish-shorts.ts`, fail-soft.
 */

/** Limite do `file_upload` do Claude in Chrome por chamada (10 MB). */
export const CHROME_UPLOAD_MAX_BYTES = 10_000_000;
/** Alvo do arquivo comprimido: mirando 9,5 MB (abaixo do limite de 10 MB do file_upload). */
export const CHROME_UPLOAD_TARGET_BYTES = 9_500_000;
export const CHROME_UPLOAD_AUDIO_KBPS = 64;
export const CHROME_UPLOAD_AUDIO_RATE = 48_000;
/** Abaixo disso 720p fica ruim demais; melhor estourar o alvo e avisar. */
export const CHROME_UPLOAD_MIN_VIDEO_KBPS = 250;
/** Vertical curto não precisa de mais que isso em 720p. */
export const CHROME_UPLOAD_MAX_VIDEO_KBPS = 2_500;
/** Margem pro container MP4 e pro desvio do 2-pass (o 590k de 114 s saiu 9,5 MB). */
export const CHROME_UPLOAD_CONTAINER_OVERHEAD = 0.03;
export const CHROME_UPLOAD_WIDTH = 720;
export const CHROME_UPLOAD_HEIGHT = 1280;

export interface ChromeUploadBitrate {
  videoKbps: number;
  audioKbps: number;
  /** Tamanho estimado do arquivo com esse bitrate. */
  estimatedBytes: number;
  /** false = nem o bitrate mínimo cabe no alvo; o arquivo deve passar dos 9,5 MB. */
  fits: boolean;
  warning?: string;
}

/**
 * Pure (#10915): bitrate de vídeo para o arquivo caber em `targetBytes`, dada
 * a duração. Abaixo do mínimo usa o mínimo e devolve `fits: false` com aviso
 * (acima de 10 MB o `file_upload` recusa e o editor escolhe o arquivo à mão).
 */
export function chromeUploadBitrate(durationSeconds: number, targetBytes: number = CHROME_UPLOAD_TARGET_BYTES): ChromeUploadBitrate {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`duração inválida para o cálculo de bitrate: ${durationSeconds}`);
  }
  const audioKbps = CHROME_UPLOAD_AUDIO_KBPS;
  const budgetKbits = ((targetBytes * 8) / 1000) * (1 - CHROME_UPLOAD_CONTAINER_OVERHEAD);
  const raw = Math.floor(budgetKbits / durationSeconds - audioKbps);
  const fits = raw >= CHROME_UPLOAD_MIN_VIDEO_KBPS;
  const videoKbps = Math.min(CHROME_UPLOAD_MAX_VIDEO_KBPS, Math.max(CHROME_UPLOAD_MIN_VIDEO_KBPS, raw));
  const estimatedBytes = Math.ceil((((videoKbps + audioKbps) * durationSeconds * 1000) / 8) / (1 - CHROME_UPLOAD_CONTAINER_OVERHEAD));
  return {
    videoKbps,
    audioKbps,
    estimatedBytes,
    fits,
    ...(fits
      ? {}
      : {
          warning:
            `${durationSeconds.toFixed(1)} s não cabem em ${(targetBytes / 1e6).toFixed(1)} MB nem a ${CHROME_UPLOAD_MIN_VIDEO_KBPS} kbps: ` +
            `o arquivo deve sair com ~${(estimatedBytes / 1e6).toFixed(1)} MB, e acima de ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB o file_upload do Chrome recusa (o editor escolhe o arquivo)`,
        }),
  };
}

/** Nome do arquivo comprimido em `_internal/` (#10915). */
export function chromeUploadFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}-short-instagram-chrome.mp4`;
}

/**
 * Pure (#10915): as duas passadas do ffmpeg. Escala para caber em 720x1280 sem
 * distorcer (pad se a proporção não for 9:16). `nullSink` = `/dev/null` ou
 * `NUL` (Windows), o descarte da 1ª passada.
 */
export function buildChromeUploadFfmpegPasses(opts: {
  input: string;
  output: string;
  videoKbps: number;
  passlogfile: string;
  nullSink: string;
}): [string[], string[]] {
  const w = CHROME_UPLOAD_WIDTH;
  const h = CHROME_UPLOAD_HEIGHT;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const video = ["-c:v", "libx264", "-preset", "medium", "-b:v", `${opts.videoKbps}k`, "-pix_fmt", "yuv420p", "-passlogfile", opts.passlogfile];
  const common = ["-y", "-hide_banner", "-loglevel", "error", "-i", opts.input, "-vf", vf, ...video];
  return [
    [...common, "-pass", "1", "-an", "-f", "mp4", opts.nullSink],
    [
      ...common,
      "-pass",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      `${CHROME_UPLOAD_AUDIO_KBPS}k`,
      "-ar",
      String(CHROME_UPLOAD_AUDIO_RATE),
      "-movflags",
      "+faststart",
      opts.output,
    ],
  ];
}

/** Resultado do preparo do arquivo comprimido (o lado com I/O, em `publish-shorts.ts`). */
export type ChromeUploadResult =
  | { ok: true; path: string; sizeBytes: number; videoKbps: number; reused: boolean; warning?: string }
  | { ok: false; error: string };

/**
 * O arquivo do passo guiado, legível por máquina (#10915): a skill confere
 * `fitsChromeUpload` antes de chamar o `file_upload` do Chrome. false = o
 * editor escolhe o arquivo à mão (compressão falhou e sobrou o original, ou o
 * encode passou de 10 MB).
 */
export interface ChromeUploadPlanFile {
  path: string;
  sizeBytes: number | null;
  fitsChromeUpload: boolean;
}

/** Cabe no `file_upload` do Chrome? Tamanho desconhecido ou 0 byte = não. */
export function fitsChromeUpload(sizeBytes: number | null): boolean {
  return sizeBytes !== null && sizeBytes > 0 && sizeBytes <= CHROME_UPLOAD_MAX_BYTES;
}

/**
 * Sidecar `.json` ao lado do arquivo comprimido (#10915): o arquivo só é
 * reaproveitado quando a fonte (path, tamanho, mtime), o bitrate e o próprio
 * arquivo gerado batem EXATAMENTE. mtime sozinho deixava passar um vertical
 * trocado por outro mais velho, ou um arquivo de outro bitrate.
 */
export interface ChromeUploadSidecar {
  source: { path: string; sizeBytes: number; mtimeMs: number };
  videoKbps: number;
  outputSizeBytes: number;
}

export function chromeUploadSidecarPath(output: string): string {
  return `${output}.json`;
}

/** Pure: o arquivo já gerado pode ser reaproveitado? */
export function chromeUploadReusable(
  sidecarRaw: string | null,
  expected: { source: { path: string; sizeBytes: number; mtimeMs: number }; videoKbps: number },
  output: { size: number } | null,
): boolean {
  if (!sidecarRaw || !output || !fitsChromeUpload(output.size)) return false;
  let s: ChromeUploadSidecar;
  try {
    s = JSON.parse(sidecarRaw);
  } catch {
    return false;
  }
  return (
    s?.source?.path === expected.source.path &&
    s.source.sizeBytes === expected.source.sizeBytes &&
    s.source.mtimeMs === expected.source.mtimeMs &&
    s.videoKbps === expected.videoKbps &&
    s.outputSizeBytes === output.size
  );
}
