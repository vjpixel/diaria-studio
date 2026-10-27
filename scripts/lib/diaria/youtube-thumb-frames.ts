/**
 * scripts/lib/diaria/youtube-thumb-frames.ts (#11228)
 *
 * Retrato da capa horizontal a partir do vídeo BRUTO (4K) do Drive, com o
 * frame escolhido pelo editor. Medido na edição 261027: o frame do vídeo
 * final (1080p) deixou o retrato com baixa resolução; o bruto
 * (`20261026_191548.mp4`, 4K HEVC, 7,9 GB, na subpasta `{AAMMDD}/` do Drive)
 * dá um recorte nítido, e o `ffmpeg` lê o frame direto da Drive API
 * (`-headers "Authorization: Bearer …"` + `-ss`), sem baixar os gigabytes.
 *
 * Partes determinísticas (este módulo, sem rede):
 *   - `frameTimes` — os instantes das N opções (default 5, espalhadas no miolo
 *     do vídeo) ou os passados pelo editor;
 *   - `planDriveFrameArgs` — os argumentos do `ffmpeg` para um frame;
 *   - `redactFfmpegArgs` — os mesmos argumentos sem o token, para log;
 *   - `buildFrameSheet` — a folha de opções numeradas que o editor olha
 *     para escolher (o critério: olhando para a câmera, boca fechada, mãos fora
 *     do quadro — a escolha é do editor, nunca automática).
 *
 * O acesso ao Drive (token OAuth do projeto, `getAccessToken`) e o `ffmpeg`
 * ficam no CLI `scripts/gen-youtube-thumb.ts --frames-from-drive`.
 */

import sharp from "sharp";
import { COLORS, FONTS } from "../shared/design-tokens.ts";
import { DRIVE_API } from "../drive-constants.ts";
import { escapeXml } from "./youtube-thumb.ts";

/** Quantas opções de frame a folha mostra por padrão (5 em 261027). */
export const DEFAULT_FRAME_COUNT = 5;
/** Pasta (relativa à edição) dos frames extraídos e da folha de opções. */
export const THUMB_FRAMES_DIR = "_internal/youtube-thumb-frames";
export const THUMB_FRAMES_SHEET = "opcoes.jpg";
export const THUMB_FRAME_PICKED = "escolhido.png";

export function thumbFrameFileName(n: number): string {
  return `frame-${n}.png`;
}

/**
 * Instantes (s) das opções. Com `explicit` (ex.: "12,30.5,48"), usa esses,
 * validados contra a duração. Senão, `count` instantes no miolo do vídeo
 * (10% a 90%, no centro de cada fatia), arredondados a 0,1 s: o começo e o fim
 * costumam ter a claquete/a mão no botão de gravar.
 */
export function frameTimes(durationS: number | null, opts: { count?: number; explicit?: string } = {}): number[] {
  if (opts.explicit !== undefined) {
    const times = opts.explicit.split(",").map((t) => t.trim()).filter(Boolean).map(Number);
    if (times.length === 0 || times.some((t) => !Number.isFinite(t) || t < 0)) {
      throw new Error(`--times inválido: ${JSON.stringify(opts.explicit)} (segundos separados por vírgula, ex.: 12,30.5,48)`);
    }
    if (durationS !== null) {
      const past = times.filter((t) => t >= durationS);
      if (past.length) throw new Error(`--times além do fim do vídeo (${durationS.toFixed(1)} s): ${past.join(", ")}`);
    }
    return times;
  }
  const count = opts.count ?? DEFAULT_FRAME_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error(`--count inválido: ${count} (1 a 12)`);
  if (durationS === null || !(durationS > 0)) {
    throw new Error("duração do vídeo desconhecida (o Drive ainda não processou o vídeo?) — passe --times com os instantes");
  }
  return Array.from({ length: count }, (_, i) => Math.round(durationS * (0.1 + (0.8 * (i + 0.5)) / count) * 10) / 10);
}

/** URL de download do arquivo pela Drive API (a mesma do `downloadDriveFile`). */
export function driveMediaUrl(fileId: string): string {
  return `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

/**
 * Argumentos do `ffmpeg` para extrair UM frame do arquivo do Drive em
 * `atSeconds`, sem baixar o vídeo: `-ss` antes de `-i` faz o seek por range
 * HTTP. PNG sem perda (o recorte do rembg vem depois).
 */
export function planDriveFrameArgs(input: { fileId: string; accessToken: string; atSeconds: number; out: string }): string[] {
  if (!input.fileId.trim()) throw new Error("file id do Drive vazio");
  if (!input.accessToken.trim()) throw new Error("token OAuth vazio");
  if (!Number.isFinite(input.atSeconds) || input.atSeconds < 0) throw new Error(`instante inválido: ${input.atSeconds}`);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-headers",
    `Authorization: Bearer ${input.accessToken}\r\n`,
    "-ss",
    String(input.atSeconds),
    "-i",
    driveMediaUrl(input.fileId),
    "-frames:v",
    "1",
    "-y",
    input.out,
  ];
}

/** Os mesmos argumentos com o token trocado por `***` (para log e erro). */
export function redactFfmpegArgs(args: string[]): string[] {
  return args.map((a) => (/^Authorization: Bearer /.test(a) ? "Authorization: Bearer ***" : a));
}

/** Largura de cada miniatura na folha e colunas da grade. */
const SHEET_CELL_W = 640;
const SHEET_COLS = 3;
const SHEET_PAD = 12;

/**
 * Folha de opções: as miniaturas em grade de 3 colunas, cada uma com o número
 * (1..N) num selo no canto superior esquerdo, que é o que o editor responde.
 * JPEG, fundo `COLORS.ink`.
 */
export async function buildFrameSheet(frames: Buffer[]): Promise<Buffer> {
  if (frames.length === 0) throw new Error("nenhum frame para a folha de opções");
  const cells = await Promise.all(
    frames.map(async (f) => sharp(f).rotate().resize({ width: SHEET_CELL_W }).png().toBuffer({ resolveWithObject: true })),
  );
  const cellH = Math.max(...cells.map((c) => c.info.height));
  const cols = Math.min(SHEET_COLS, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const width = cols * SHEET_CELL_W + (cols + 1) * SHEET_PAD;
  const height = rows * cellH + (rows + 1) * SHEET_PAD;
  const badge = (n: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88">` +
        `<circle cx="44" cy="44" r="40" fill="${COLORS.brand}"/>` +
        `<text x="44" y="60" text-anchor="middle" font-family="${escapeXml(FONTS.serif)}" font-weight="700" ` +
        `font-size="48" fill="${COLORS.onInk}">${n}</text></svg>`,
    );
  const layers = cells.flatMap((c, i) => {
    const left = SHEET_PAD + (i % cols) * (SHEET_CELL_W + SHEET_PAD);
    const top = SHEET_PAD + Math.floor(i / cols) * (cellH + SHEET_PAD);
    return [
      { input: c.data, left, top },
      { input: badge(i + 1), left: left + 12, top: top + 12 },
    ];
  });
  return sharp({ create: { width, height, channels: 3, background: COLORS.ink } })
    .composite(layers)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
