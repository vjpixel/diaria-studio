/**
 * video-final-review.ts (#11557): revisão automática do EXPORT do Premiere
 * (`{AAMMDD}/Final/` ou `Editados/`), o que o editor pediu à mão 4 vezes na
 * edição 261029 ("revise o vídeo"). Puro: recebe o que o ffprobe/ffmpeg e a
 * transcrição mediram e devolve achados com o tempo no export e, quando o
 * `plan.json` da montagem existe, o tempo aproximado no bruto. O CLI
 * (`video-montagem.ts review-final`) roda as medições.
 *
 * O que olha, com os casos reais da 261029:
 * - **Formato:** proporção contra o destino do nome (`_Youtube_` = 16:9,
 *   `_Instagram_`/`_Outras redes_` = 9:16). O Instagram V1 saiu 1920x1080 com
 *   a imagem vertical no meio (cropdetect `608:1072:656:4`): `formato` +
 *   `faixa-preta`. Também fps diferente do bruto e vertical acima de 3:00.
 * - **Áudio:** loudness integrado contra -14 LUFS (±1 LU) e true peak acima
 *   de -1 dBTP (o V4 saiu -9,6 LUFS, pico -0,2 dBTP); `estalo` = pico curto
 *   (até 30 ms) e isolado entre trechos quietos (10 ms, pico 0,64, em 0:03,03);
 *   `fragmento` = menos de 0,2 s de som entre dois silêncios (0,12 s antes de
 *   "espere", em 0:51,4).
 * - **Texto:** a transcrição do export contra o roteiro da versão
 *   (`plan.json`), com a mesma comparação da autorrevisão da prévia
 *   (`reviewPreview`): palavra faltando ("eleições presidente", sem o "para"),
 *   hesitação e falso começo ("anos, a, junto"), tomada duplicada.
 *
 * Fora daqui (#11557 item 4, opcional): OCR da legenda queimada.
 */

import { SHORTS_MAX_S } from "./video-montage-docs.ts";
import { videoTargetOf, type VideoTarget } from "./drive-video-source.ts";
import {
  cutPoints,
  reviewPreview,
  type Interval,
  type LoudnessMeasure,
  type ReviewKind,
  type SequencePlan,
  type VocabAlias,
  type Word,
} from "./video-montage.ts";

/** Loudness alvo do export (referência de plataforma, #11557). */
export const FINAL_TARGET_LUFS = -14;
/** Tolerância em LU em torno do alvo. */
export const FINAL_LUFS_TOLERANCE = 1;
/** True peak máximo do export. */
export const FINAL_MAX_TRUE_PEAK_DBTP = -1;
/** Som entre dois silêncios mais curto que isso é fragmento de emenda. */
export const FRAGMENT_MAX_S = 0.2;

export type FinalReviewKind =
  | "formato"
  | "faixa-preta"
  | "fps"
  | "duracao"
  | "loudness"
  | "pico"
  | "estalo"
  | "fragmento"
  | ReviewKind;

export interface FinalReviewFinding {
  kind: FinalReviewKind;
  /** Instante no export (s); `null` = o arquivo inteiro. */
  at: number | null;
  /** Instante aproximado no bruto (s), pelo `plan.json`; ausente sem plano ou fora dos clipes. */
  rawAt?: number | null;
  /** O que está. */
  what: string;
  /** Correção. */
  fix: string;
}

export interface ExportProbe {
  width: number;
  height: number;
  fps: number;
  durationS: number;
}

export interface CropBox {
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Destino do export pelo nome (`_Youtube_`, `_Instagram_`, `_Outras redes_`). */
export function exportTarget(fileName: string): VideoTarget | null {
  return videoTargetOf(fileName);
}

/** O `crop=w:h:x:y` mais frequente na saída do `cropdetect`; `null` sem nenhum. */
export function parseCropdetect(stderr: string): CropBox | null {
  const counts = new Map<string, number>();
  for (const m of stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
    const k = `${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const [w, h, x, y] = best.split(":").map(Number);
  return { w, h, x, y };
}

/**
 * Formato contra o destino: proporção (16:9 no `youtube`, 9:16 nos
 * verticais, ±2%), faixa preta (o `cropdetect` acha imagem útil menor que 98%
 * do quadro), fps diferente do esperado e vertical acima do teto do Shorts.
 */
export function checkFormat(
  probe: ExportProbe,
  target: VideoTarget,
  opts: { crop?: CropBox | null; expectedFps?: number | null } = {},
): FinalReviewFinding[] {
  const out: FinalReviewFinding[] = [];
  const vertical = target !== "youtube";
  const want = vertical ? 9 / 16 : 16 / 9;
  const ratio = probe.width / probe.height;
  const wantTxt = vertical ? "1080x1920 (9:16)" : "1920x1080 (16:9)";
  if (!(probe.width > 0 && probe.height > 0) || Math.abs(ratio - want) / want > 0.02) {
    out.push({
      kind: "formato",
      at: null,
      what: `${probe.width}x${probe.height} num export do destino ${target}`,
      fix: `exportar a sequência ${vertical ? "vertical" : "horizontal"} em ${wantTxt}`,
    });
  }
  const crop = opts.crop;
  if (crop && probe.width > 0 && probe.height > 0 && (crop.w < probe.width * 0.98 || crop.h < probe.height * 0.98)) {
    out.push({
      kind: "faixa-preta",
      at: null,
      what: `imagem útil ${crop.w}x${crop.h} em ${crop.x},${crop.y} de um quadro ${probe.width}x${probe.height} (cropdetect ${crop.w}:${crop.h}:${crop.x}:${crop.y}): faixas pretas`,
      fix: `exportar sem faixas, com a sequência no formato do destino (${wantTxt})`,
    });
  }
  if (opts.expectedFps && Math.abs(probe.fps - opts.expectedFps) > 0.01) {
    out.push({ kind: "fps", at: null, what: `${probe.fps} fps (o bruto e a montagem são ${opts.expectedFps})`, fix: `exportar em ${opts.expectedFps} fps` });
  }
  if (vertical && probe.durationS > SHORTS_MAX_S) {
    out.push({
      kind: "duracao",
      at: null,
      what: `${probe.durationS.toFixed(1)} s, ${(probe.durationS - SHORTS_MAX_S).toFixed(1)} s acima do teto do vertical (${SHORTS_MAX_S} s)`,
      fix: "cortar até 3:00 (o trecho \"skip\" da vertical no blocks.json)",
    });
  }
  return out;
}

/** Loudness integrado contra -14 LUFS (±1 LU) e true peak acima de -1 dBTP. */
export function checkLoudness(m: LoudnessMeasure | null): FinalReviewFinding[] {
  if (!m) return [{ kind: "loudness", at: null, what: "loudness do export não medido (o loudnorm não imprimiu o resumo)", fix: "medir à mão no Premiere" }];
  const out: FinalReviewFinding[] = [];
  if (Math.abs(m.inputI - FINAL_TARGET_LUFS) > FINAL_LUFS_TOLERANCE) {
    out.push({
      kind: "loudness",
      at: null,
      what: `${m.inputI.toFixed(1)} LUFS integrado`,
      fix: `normalizar para ${FINAL_TARGET_LUFS} LUFS (${m.inputI > FINAL_TARGET_LUFS ? "baixar" : "subir"} ${Math.abs(m.inputI - FINAL_TARGET_LUFS).toFixed(1)} dB)`,
    });
  }
  if (Number.isFinite(m.inputTp) && m.inputTp > FINAL_MAX_TRUE_PEAK_DBTP) {
    out.push({ kind: "pico", at: null, what: `true peak ${m.inputTp.toFixed(1)} dBTP`, fix: `limitar em ${FINAL_MAX_TRUE_PEAK_DBTP} dBTP` });
  }
  return out;
}

export interface PeakWindow {
  /** Início da janela (s). */
  t: number;
  /** Pico da janela em dBFS (`-Infinity` = silêncio digital). */
  peakDb: number;
}

/**
 * Saída do `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level`
 * (uma janela por `asetnsamples`): pares `pts_time:T` e `...Peak_level=X`.
 */
export function parsePeakWindows(text: string): PeakWindow[] {
  const out: PeakWindow[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const pts = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (pts) {
      t = Number(pts[1]);
      continue;
    }
    const peak = /Peak_level=(-?inf|-?[\d.]+)/i.exec(line);
    if (peak && t !== null) {
      const v = peak[1].toLowerCase();
      out.push({ t, peakDb: v.endsWith("inf") ? -Infinity : Number(v) });
      t = null;
    }
  }
  return out;
}

const linear = (db: number) => (Number.isFinite(db) ? 10 ** (db / 20) : 0);

/**
 * Estalo de emenda: trecho de até `maxS` (30 ms) com pico ≥ `minPeakDb`
 * (-12 dBFS), com `guardS` (60 ms) quietos (≤ `quietDb`, -40 dBFS) antes e
 * depois. Fala normal não passa: ela tem som contínuo em volta do pico.
 */
export function detectClicks(
  windows: PeakWindow[],
  opts: { minPeakDb?: number; quietDb?: number; guardS?: number; maxS?: number } = {},
): FinalReviewFinding[] {
  const minPeak = opts.minPeakDb ?? -12;
  const quiet = opts.quietDb ?? -40;
  const guard = opts.guardS ?? 0.06;
  const maxS = opts.maxS ?? 0.03;
  if (windows.length < 2) return [];
  const step = windows[1].t - windows[0].t;
  const out: FinalReviewFinding[] = [];
  let i = 0;
  while (i < windows.length) {
    if (windows[i].peakDb < minPeak) {
      i++;
      continue;
    }
    let k = i;
    while (k + 1 < windows.length && windows[k + 1].peakDb >= minPeak) k++;
    const start = windows[i].t;
    const end = windows[k].t + step;
    const around = windows.filter((w) => (w.t >= start - guard && w.t < start) || (w.t >= end && w.t < end + guard));
    const enough = around.length >= Math.floor((2 * guard) / step) - 1;
    if (end - start <= maxS + 1e-9 && enough && around.every((w) => w.peakDb <= quiet)) {
      const peak = Math.max(...windows.slice(i, k + 1).map((w) => w.peakDb));
      out.push({
        kind: "estalo",
        at: round2(start),
        what: `estalo de ${Math.round((end - start) * 1000)} ms, pico ${linear(peak).toFixed(2)} (${peak.toFixed(1)} dBFS), entre trechos quietos`,
        fix: "aparar a emenda ou aplicar crossfade curto no corte",
      });
    }
    i = k + 1;
  }
  return out;
}

/** Som entre dois silêncios com menos de `maxS` (0,2 s): sobra de emenda. */
export function detectFragments(silences: Interval[], opts: { maxS?: number } = {}): FinalReviewFinding[] {
  const maxS = opts.maxS ?? FRAGMENT_MAX_S;
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const out: FinalReviewFinding[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i].end;
    const end = sorted[i + 1].start;
    const d = end - start;
    if (d > 0 && d < maxS) {
      out.push({
        kind: "fragmento",
        at: round2(start),
        what: `${d.toFixed(2)} s de som isolado entre dois silêncios`,
        fix: "cortar o fragmento (sobra da tomada vizinha na emenda)",
      });
    }
  }
  return out;
}

/**
 * Estalo também é "som entre dois silêncios": o mesmo instante sai uma vez só,
 * como `estalo` (o fragmento a até 50 ms dele é descartado).
 */
export function dedupeAudioFindings(clicks: FinalReviewFinding[], fragments: FinalReviewFinding[]): FinalReviewFinding[] {
  const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 0.05;
  return [...clicks, ...fragments.filter((fr) => !clicks.some((c) => near(c.at, fr.at)))];
}

/**
 * Instante do export → instante no bruto, pelos clipes do `plan.json`
 * (aproximado: o editor pode ter mexido no Premiere). `null` fora dos clipes.
 */
export function exportTimeToRaw(t: number, plan: SequencePlan, fps: number): number | null {
  for (const c of plan.clips) {
    const s = c.seqStart / fps;
    const e = s + (c.frameOut - c.frameIn) / fps;
    if (t >= s && t < e) return round2(c.frameIn / fps + (t - s));
  }
  return null;
}

const TEXT_FIX: Record<ReviewKind, string> = {
  "tomada-duplicada": "tirar a repetição (fica uma tomada só)",
  "silaba-vazada": "aparar o corte (sílaba da tomada vizinha)",
  "fala-extra": "cortar (hesitação, falso começo ou fala fora do roteiro)",
  "fala-faltando": "repor a fala (o corte comeu a palavra)",
  "final-seco": "segurar ~0,3 s depois da última palavra",
};

/** Transcrição do export contra o roteiro da versão (mesma comparação da autorrevisão da prévia). */
export function checkText(input: {
  words: Word[];
  plan: SequencePlan;
  fps: number;
  durationS: number;
  aliases?: VocabAlias[];
}): FinalReviewFinding[] {
  const findings = reviewPreview({
    words: input.words,
    script: input.plan.script,
    cuts: cutPoints(input.plan, input.fps),
    durationS: input.durationS,
    aliases: input.aliases,
  });
  return findings.map((f) => ({
    kind: f.kind,
    at: f.at,
    rawAt: exportTimeToRaw(f.at, input.plan, input.fps),
    what: f.detail,
    fix: TEXT_FIX[f.kind],
  }));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** `m:ss,s` (a notação que o editor usou na 261029: "0:03,03"). */
export function exportClock(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, "0").replace(".", ",")}`;
}

/** Tabela de correções no formato da sessão de 261029: #, tempo no export, tempo no bruto, o que está, correção. */
export function finalReviewTable(findings: FinalReviewFinding[]): string {
  const sorted = [...findings].sort((a, b) => (a.at ?? -1) - (b.at ?? -1));
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = ["| # | Tempo no export | Tempo no bruto | O que está | Correção |", "|---|---|---|---|---|"];
  sorted.forEach((f, i) => {
    const at = f.at === null ? "arquivo inteiro" : exportClock(f.at);
    const raw = f.rawAt === undefined || f.rawAt === null ? "—" : exportClock(f.rawAt);
    lines.push(`| ${i + 1} | ${at} | ${raw} | ${cell(`[${f.kind}] ${f.what}`)} | ${cell(f.fix)} |`);
  });
  if (sorted.length === 0) lines.push("| — | — | — | nenhum achado | — |");
  return lines.join("\n") + "\n";
}
