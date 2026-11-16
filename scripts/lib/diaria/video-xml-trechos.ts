/**
 * XML "leve" (#13219): o XML do Premiere aponta para TRECHOS curtos do bruto
 * em H.264 + PCM, não para o bruto inteiro.
 *
 * Por quê: o bruto do celular é HEVC 4K a ~96 Mbps com áudio AAC (na 261116,
 * 5 arquivos, ~20 GB). O Premiere converte o AAC de cada arquivo INTEIRO
 * (`.cfa`, "Preparing audio"), lendo os 20 GB pelo Google Drive, para uma
 * montagem que usa ~5 min; e o HEVC a 96 Mbps lido por streaming não toca em
 * tempo real ("Error retrieving frame", quadros pretos). O contorno da 261116
 * (script de sessão) cortava só o que os XMLs usam: ~1,6 GB e nenhum conform.
 *
 * Este módulo é puro (planejamento dos trechos, nome, argumentos do ffmpeg,
 * escolha do encoder); quem roda o ffmpeg e escreve o XML é o `build` de
 * `scripts/video-montagem.ts`, e o `<file>` de cada trecho sai em
 * `buildXmeml` (`opts.trechos`).
 *
 *   - Um trecho cobre os clipes de UM arquivo do bruto, com `folgaS` de cada
 *     lado; trechos a menos de `mergeGapS` um do outro viram um só.
 *   - Os limites são arredondados para fora, em segundos inteiros: um rebuild
 *     que mexe pouco nos cortes cai nos mesmos limites e reaproveita o arquivo.
 *   - O nome leva o arquivo do bruto e os quadros de início E fim (a issue
 *     pedia início; com só o início, um rebuild que estica o fim reaproveitaria
 *     um trecho curto demais, com quadro preto no fim do clipe).
 *   - O `<file id>` é `file-{k}-t{início}` (k = arquivo do bruto, 1-based;
 *     início em quadros locais dele): o `verify-xml` volta ao tempo do bruto
 *     só pelo id (`toTimeline`, `video-xml-verify.ts`).
 *   - O 4K fica: o zoom do vertical (115–130%) e do horizontal não perde nada.
 */

export const TRECHOS = {
  /** Folga de cada lado do trecho, em segundos (`--trechos-folga`). */
  folgaS: 1,
  /** Trechos (já com folga) a menos disto um do outro viram um só, em segundos. */
  mergeGapS: 3,
  /** Subpasta do out dir (a pasta da edição) onde os trechos ficam. */
  dirName: "trechos",
  /** GOP curto e sem B-frames: scrubbing e corte no Premiere sem decodificar muito para trás. */
  gop: 15,
  /** Qualidade constante do H.264 (cq do NVENC, crf do libx264). */
  quality: 19,
} as const;

export type TrechoEncoder = "h264_nvenc" | "libx264";

/** Um clipe do plano no arquivo do bruto que ele usa: quadros LOCAIS do arquivo, `out` exclusivo. */
export interface TrechoUse {
  fileIndex: number;
  in: number;
  out: number;
}

/** O que o planejamento lê de cada arquivo do bruto. */
export interface TrechoSourceFile {
  /** Caminho local (o ffmpeg lê dele); o nome sem extensão vai no nome do trecho. */
  path: string;
  frames: number;
}

/** Um trecho planejado: quadros LOCAIS do arquivo `fileIndex`, `end` exclusivo. */
export interface Trecho {
  fileIndex: number;
  start: number;
  end: number;
  /** Nome do `.mov` (estável: arquivo + início + fim). */
  name: string;
  /** `<file id>` no XML. */
  id: string;
}

/** O trecho como o `buildXmeml` o grava: o caminho que vai no `pathurl` e o tamanho do arquivo do bruto de onde saiu. */
export interface TrechoXml extends Trecho {
  xmlPath: string;
  width: number;
  height: number;
}

const stem = (p: string): string => (p.replace(/\\/g, "/").split("/").pop() ?? p).replace(/\.[^.]+$/, "");
const pad = (n: number): string => String(n).padStart(6, "0");

export function trechoName(sourcePath: string, start: number, end: number): string {
  return `${stem(sourcePath)}_q${pad(start)}-${pad(end)}.mov`;
}

export function trechoFileId(fileIndex: number, start: number): string {
  return `file-${fileIndex + 1}-t${start}`;
}

/** `file-{k}-t{início}` → arquivo (0-based) e início local; outro id = null. */
export function parseTrechoFileId(id: string): { fileIndex: number; start: number } | null {
  const m = /^file-(\d+)-t(\d+)$/.exec(id);
  return m ? { fileIndex: Number(m[1]) - 1, start: Number(m[2]) } : null;
}

/**
 * Os trechos que cobrem todos os `uses` (#13219). Clipe com in/out fora do
 * arquivo (ou vazio) é erro: o plano é de outro bruto.
 */
export function planTrechos(
  uses: readonly TrechoUse[],
  files: readonly TrechoSourceFile[],
  fps: number,
  opts: { folgaS?: number; mergeGapS?: number } = {},
): Trecho[] {
  const folgaS = opts.folgaS ?? TRECHOS.folgaS;
  const mergeGapS = opts.mergeGapS ?? TRECHOS.mergeGapS;
  if (!(fps > 0)) throw new Error(`trechos: fps inválido (${fps})`);
  if (!(folgaS >= 0)) throw new Error(`trechos: folga inválida (${folgaS})`);
  const byFile = new Map<number, { start: number; end: number }[]>();
  for (const u of uses) {
    const f = files[u.fileIndex];
    if (!f) throw new Error(`trechos: clipe aponta o arquivo ${u.fileIndex}, mas o bruto tem ${files.length}`);
    if (!(u.in >= 0 && u.out > u.in && u.out <= f.frames)) throw new Error(`trechos: clipe ${u.in}–${u.out} fora de ${stem(f.path)} (${f.frames} quadros)`);
    // Para fora, em segundos inteiros: o mesmo limite para cortes que mudam pouco.
    const start = Math.max(0, Math.round(Math.floor(u.in / fps - folgaS + 1e-9) * fps));
    const end = Math.min(f.frames, Math.round(Math.ceil(u.out / fps + folgaS - 1e-9) * fps));
    const list = byFile.get(u.fileIndex) ?? [];
    list.push({ start, end });
    byFile.set(u.fileIndex, list);
  }
  const gap = mergeGapS * fps;
  const out: Trecho[] = [];
  for (const k of [...byFile.keys()].sort((a, b) => a - b)) {
    const spans = byFile.get(k)!.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: { start: number; end: number }[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start - last.end < gap) last.end = Math.max(last.end, s.end);
      else merged.push({ ...s });
    }
    for (const m of merged) out.push({ fileIndex: k, start: m.start, end: m.end, name: trechoName(files[k].path, m.start, m.end), id: trechoFileId(k, m.start) });
  }
  return out;
}

/** O trecho que contém o clipe inteiro (`in`/`out` locais do arquivo); nenhum = null. */
export function findTrecho<T extends Trecho>(trechos: readonly T[], fileIndex: number, inF: number, outF: number): T | null {
  return trechos.find((t) => t.fileIndex === fileIndex && t.start <= inF && outF <= t.end) ?? null;
}

/** Quadros de bruto cobertos pelos trechos e o total do bruto (para o relato do build). */
export function trechosCoverage(trechos: readonly Trecho[], files: readonly TrechoSourceFile[]): { frames: number; totalFrames: number } {
  return { frames: trechos.reduce((s, t) => s + (t.end - t.start), 0), totalFrames: files.reduce((s, f) => s + f.frames, 0) };
}

/** NVENC quando o ffmpeg o lista (`ffmpeg -encoders`); senão libx264 (o 300 não tem GPU NVIDIA). */
export function pickTrechoEncoder(encodersListing: string): TrechoEncoder {
  return /^\s*V\S*\s+h264_nvenc\b/m.test(encodersListing) ? "h264_nvenc" : "libx264";
}

/**
 * Argumentos do ffmpeg de um trecho: seek no input (exato com recodificação),
 * vídeo em H.264 no tamanho do bruto (4K fica 4K), CFR no fps do projeto
 * (o XML conta quadros), GOP de 15 sem B-frames, áudio PCM 16 bits 48 kHz.
 * Container MOV forçado (`-f mov`), para a saída poder ser um `.part`.
 */
export function trechoEncodeArgs(input: { src: string; out: string; start: number; end: number; fps: number; encoder: TrechoEncoder }): string[] {
  const startS = (input.start / input.fps).toFixed(6);
  const durS = ((input.end - input.start) / input.fps).toFixed(6);
  const q = String(TRECHOS.quality);
  const video = input.encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", q];
  return [
    "-hide_banner", "-v", "error", "-y",
    "-ss", startS, "-i", input.src, "-t", durS,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-fps_mode", "cfr", "-r", String(input.fps),
    ...video, "-g", String(TRECHOS.gop), "-bf", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", "48000",
    "-f", "mov", input.out,
  ];
}

/** `--trechos-folga S`: segundos de 0 a 10. */
export function parseTrechosFolgaArg(v: string | undefined): number {
  if (v === undefined) return TRECHOS.folgaS;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 10) throw new Error(`--trechos-folga espera segundos de 0 a 10 (recebeu "${v}")`);
  return n;
}
