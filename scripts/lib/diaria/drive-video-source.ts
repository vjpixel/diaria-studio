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
 * - nome contém "final" como PALAVRA, sem diferenciar maiúsculas/minúsculas
 *   (`hasFinalInName`): "V3 - final", "_Final", "final.mp4" valem;
 *   "finalizando", "pre-final"/"pré-final" e "não final"/"nao final" não;
 * - é `.mp4`: extensão `.mp4` OU `mimeType` `video/mp4` (`isMp4VideoFile`).
 *   `.mov`/`.webm`/`.mkv` ficam fora mesmo com `video/*`. O download confere
 *   o mesmo critério no `content-type` (`isAcceptableDownloadContentType`);
 * - orientação pela proporção de `videoMediaMetadata`: largura > altura é
 *   horizontal, altura > largura é vertical. Sem metadado não se chuta
 *   (`orientation-unknown`); quadrado não é nenhum dos dois;
 * - 2+ candidatos da mesma orientação → `ambiguous`, com id/nome/data de cada
 *   um (o Drive aceita nomes repetidos). Nunca escolhe sozinho (o editor
 *   costuma deixar V2 e V3 "final" lado a lado);
 * - nenhum candidato → `none` (fail-soft: o editor sobe depois e roda
 *   `/diaria-youtube`).
 *
 * Escopo (premissa, medida na pasta real em 25/10/2026): a pasta
 * `Mentoria Fluxo/VTSD/YouTube` tem uma subpasta por edição (`261021/`,
 * `261022/`, `261023/`), com os brutos e as versões.
 * - **Subpasta `{AAMMDD}/` existe** → só ela conta, sem janela de tempo (o
 *   nome da pasta já diz o dia). Sem candidato da orientação pedida lá dentro
 *   → `none`; a raiz NÃO é consultada, senão um vídeo de outra edição solto
 *   na raiz subiria como o de hoje.
 * - **Subpasta não existe** → arquivos soltos na raiz, só dentro da janela
 *   (~36h, o mais recente entre criado e modificado).
 * - Subpastas de outras edições nunca entram (quem lista não desce nelas).
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
  | { kind: "ambiguous"; orientation: VideoOrientation; candidates: DriveVideoFile[] }
  | { kind: "orientation-unknown"; orientation: VideoOrientation; files: DriveVideoFile[] };

export interface SelectDriveVideoOptions {
  orientation: VideoOrientation;
  now: Date;
  windowHours?: number;
  /**
   * A subpasta `{AAMMDD}/` existe no Drive (mesmo vazia). Default: inferido de
   * algum arquivo com `scope: "edition-folder"` — quem lista deve passar o
   * valor real, porque uma subpasta vazia não deixa rastro na listagem.
   */
  editionFolderPresent?: boolean;
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

const MP4_EXT = /\.mp4$/i;
/** Extensões de vídeo que NÃO são o `.mp4` combinado, mesmo com `mimeType` `video/mp4`. */
const OTHER_VIDEO_EXT = /\.(mov|webm|mkv|avi|m4v|wmv|flv|3gp)$/i;

function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** `.mp4` por extensão, ou `mimeType` `video/mp4` sem extensão de outro formato. */
export function isMp4VideoFile(file: Pick<DriveVideoFile, "name" | "mimeType">): boolean {
  if (MP4_EXT.test(file.name)) return true;
  return baseMime(file.mimeType) === "video/mp4" && !OTHER_VIDEO_EXT.test(file.name);
}

/**
 * `content-type` aceito no download: `video/mp4`, ou `application/octet-stream`
 * quando o nome termina em `.mp4` (o Drive serve assim alguns uploads).
 */
export function isAcceptableDownloadContentType(contentType: string, fileName: string): boolean {
  const t = baseMime(contentType);
  if (t === "video/mp4") return true;
  return t === "application/octet-stream" && MP4_EXT.test(fileName);
}

const FINAL_WORD = /(?<!\p{L})final(?!\p{L})/giu;
/** Prefixo que nega o "final" logo antes dele: "pre-", "pré ", "não ", "nao_". */
const NEGATING_PREFIX = /(?:^|[^\p{L}])(?:pr[eé]|n[aã]o)[\s_.-]*$/iu;

/** "final" como palavra, não negado. */
export function hasFinalInName(name: string): boolean {
  const n = name.normalize("NFC");
  for (const m of n.matchAll(FINAL_WORD)) {
    if (!NEGATING_PREFIX.test(n.slice(0, m.index))) return true;
  }
  return false;
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

function pick(pool: DriveVideoFile[], orientation: VideoOrientation): DriveVideoSelection | null {
  if (pool.length === 0) return null;
  const unknown = pool.filter((f) => classifyOrientation(f) === null);
  const matching = pool.filter((f) => classifyOrientation(f) === orientation);
  // Um "final" sem proporção pode ser justamente o da orientação pedida:
  // escolher outro ao lado dele seria chutar.
  if (unknown.length > 0) return { kind: "orientation-unknown", orientation, files: unknown };
  if (matching.length > 1) return { kind: "ambiguous", orientation, candidates: matching };
  if (matching.length === 1) return { kind: "found", orientation, file: matching[0] };
  return null;
}

export function selectDriveVideo(files: DriveVideoFile[], opts: SelectDriveVideoOptions): DriveVideoSelection {
  const windowHours = opts.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS;
  const editionFolderPresent = opts.editionFolderPresent ?? files.some((f) => f.scope === "edition-folder");
  const finals = files.filter((f) => isMp4VideoFile(f) && hasFinalInName(f.name));

  if (editionFolderPresent) {
    const editionPool = finals.filter((f) => f.scope === "edition-folder");
    const fromEdition = pick(editionPool, opts.orientation);
    if (fromEdition) return fromEdition;
    const videos = files.filter((f) => f.scope === "edition-folder" && isMp4VideoFile(f)).length;
    return {
      kind: "none",
      orientation: opts.orientation,
      reason:
        `a subpasta da edição existe, mas não tem .mp4 ${opts.orientation} com "final" no nome ` +
        `(${editionPool.length} "final", ${videos} .mp4 lá dentro); a raiz não é consultada quando a subpasta existe`,
    };
  }

  const rootPool = finals.filter((f) => f.scope !== "edition-folder" && isWithinWindow(f, opts.now, windowHours));
  const fromRoot = pick(rootPool, opts.orientation);
  if (fromRoot) return fromRoot;

  const videos = files.filter(isMp4VideoFile).length;
  const reason =
    finals.length === 0
      ? `sem subpasta da edição e nenhum .mp4 com "final" no nome na raiz (${videos} .mp4 listado(s))`
      : `sem subpasta da edição e nenhum .mp4 ${opts.orientation} com "final" no nome na raiz nas últimas ${windowHours}h`;
  return { kind: "none", orientation: opts.orientation, reason };
}
