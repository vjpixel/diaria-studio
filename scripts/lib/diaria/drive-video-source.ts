/**
 * drive-video-source.ts (#10659, itens 3-4): escolhe, entre os arquivos de uma
 * pasta do Drive, o vídeo "diar.ia.br comentada" do dia — o horizontal
 * (YouTube) ou o vertical (Short/Reels/Story).
 *
 * Puro: recebe a listagem já feita (`scripts/fetch-drive-video.ts` chama a
 * Drive API v3) e um `now` injetável. Casos de negócio voltam como união
 * discriminada, nunca como exceção.
 *
 * Critério (decisão do editor, 25/10/2026, comentário na #10659):
 * - nome contém "final", sem diferenciar maiúsculas/minúsculas;
 * - é vídeo (`mimeType` `video/*` ou extensão `.mp4`);
 * - orientação pela proporção de `videoMediaMetadata`: largura > altura é
 *   horizontal, altura > largura é vertical. Sem metadado não se chuta
 *   (`orientation-unknown`); quadrado não é nenhum dos dois;
 * - 2+ candidatos da mesma orientação → `ambiguous`, com os nomes. Nunca
 *   escolhe sozinho (o editor costuma deixar V2 e V3 "final" lado a lado);
 * - nenhum candidato → `none` (fail-soft: o editor sobe depois e roda
 *   `/diaria-youtube`).
 *
 * Escopo (premissa, medida na pasta real em 25/10/2026): a pasta
 * `Mentoria Fluxo/VTSD/YouTube` tem uma subpasta por edição (`261021/`,
 * `261022/`, `261023/`), com os brutos e as versões. Arquivos na subpasta da
 * PRÓPRIA edição (`scope: "edition-folder"`) valem sem janela de tempo — o
 * nome da pasta já diz de que dia são. Arquivos soltos na raiz
 * (`scope: "root"`) só valem dentro da janela (~36h, criado OU modificado).
 * Quando a subpasta da edição tem candidato da orientação pedida, a raiz é
 * ignorada. Subpastas de outras edições nunca entram (quem lista não desce
 * nelas).
 */

export type VideoOrientation = "horizontal" | "vertical";

/** Janela default para arquivos soltos na raiz da pasta (decisão de 25/10). */
export const DRIVE_VIDEO_WINDOW_HOURS = 36;

export interface DriveVideoFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  modifiedTime?: string;
  /** Tamanho em bytes, como a Drive API devolve (string). */
  size?: string;
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
  /** Onde o arquivo foi listado. Default: `root`. */
  scope?: "edition-folder" | "root";
}

export type DriveVideoSelection =
  | { kind: "found"; orientation: VideoOrientation; file: DriveVideoFile }
  | { kind: "none"; orientation: VideoOrientation; reason: string }
  | { kind: "ambiguous"; orientation: VideoOrientation; candidates: string[] }
  | { kind: "orientation-unknown"; orientation: VideoOrientation; files: string[] };

export interface SelectDriveVideoOptions {
  orientation: VideoOrientation;
  now: Date;
  windowHours?: number;
}

/** Orientação pela proporção; `null` sem largura/altura válidas. */
export function classifyOrientation(file: DriveVideoFile): VideoOrientation | "square" | null {
  const w = file.videoMediaMetadata?.width;
  const h = file.videoMediaMetadata?.height;
  if (typeof w !== "number" || typeof h !== "number" || !(w > 0) || !(h > 0)) return null;
  if (w > h) return "horizontal";
  if (h > w) return "vertical";
  return "square";
}

export function isVideoFile(file: DriveVideoFile): boolean {
  return file.mimeType.toLowerCase().startsWith("video/") || /\.mp4$/i.test(file.name);
}

export function hasFinalInName(name: string): boolean {
  return /final/i.test(name);
}

function latestTimestampMs(file: DriveVideoFile): number | null {
  // Arquivo copiado/enviado preserva o modifiedTime original (pode ser ANTES
  // do createdTime): vale o mais recente dos dois.
  const ts = [file.createdTime, file.modifiedTime]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((n) => Number.isFinite(n));
  return ts.length ? Math.max(...ts) : null;
}

/** Dentro da janela (arquivo do futuro, por relógio adiantado, conta como dentro). */
export function isWithinWindow(file: DriveVideoFile, now: Date, windowHours: number): boolean {
  const ts = latestTimestampMs(file);
  if (ts === null) return false;
  return now.getTime() - ts <= windowHours * 3_600_000;
}

function pick(
  pool: DriveVideoFile[],
  orientation: VideoOrientation,
): DriveVideoSelection | null {
  if (pool.length === 0) return null;
  const unknown = pool.filter((f) => classifyOrientation(f) === null);
  const matching = pool.filter((f) => classifyOrientation(f) === orientation);
  // Um "final" sem proporção pode ser justamente o da orientação pedida:
  // escolher outro ao lado dele seria chutar.
  if (unknown.length > 0) {
    return { kind: "orientation-unknown", orientation, files: unknown.map((f) => f.name) };
  }
  if (matching.length > 1) {
    return { kind: "ambiguous", orientation, candidates: matching.map((f) => f.name) };
  }
  if (matching.length === 1) return { kind: "found", orientation, file: matching[0] };
  return null;
}

export function selectDriveVideo(files: DriveVideoFile[], opts: SelectDriveVideoOptions): DriveVideoSelection {
  const windowHours = opts.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS;
  const finals = files.filter((f) => isVideoFile(f) && hasFinalInName(f.name));
  const editionPool = finals.filter((f) => f.scope === "edition-folder");
  const rootPool = finals.filter((f) => f.scope !== "edition-folder" && isWithinWindow(f, opts.now, windowHours));

  const fromEdition = pick(editionPool, opts.orientation);
  if (fromEdition) return fromEdition;
  const fromRoot = pick(rootPool, opts.orientation);
  if (fromRoot) return fromRoot;

  const videos = files.filter(isVideoFile).length;
  const reason =
    finals.length === 0
      ? `nenhum vídeo com "final" no nome (${videos} vídeo(s) listado(s))`
      : `nenhum vídeo ${opts.orientation} com "final" no nome na subpasta da edição nem na raiz nas últimas ${windowHours}h`;
  return { kind: "none", orientation: opts.orientation, reason };
}
