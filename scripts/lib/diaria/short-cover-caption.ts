/**
 * Capa do Short com a 1ª legenda da fala no frame (#13256, preferência do
 * editor na 261116: "a capa deve incluir a 1a legenda").
 *
 * Até aqui o painel escuro do gancho (`composeShortCover`, #12462) começava em
 * 62% da altura e cobria a legenda queimada. Agora o `--short-cover` com
 * `--srt` sugere o instante da 1ª legenda (depois do lettering do título) e põe
 * o painel logo abaixo da caixa dela, para a legenda ficar legível acima do
 * gancho.
 *
 * A posição da legenda sai da mesma geometria que desenha os PNGs da legenda
 * no XML da vertical (`subtitleLayout` sobre `PREVIEW_SUBTITLE_STYLE`, #13332),
 * não de um número fixo: mudar a letra da prévia muda a conta daqui.
 *
 * Puro: o CLI (`gen-youtube-thumb.ts`) lê o SRT e aplica.
 */
import { basename, join } from "node:path";
import sharp from "sharp";
import { driveCacheDir, workDirDefault } from "./video-montage-drive.ts";
import { PREVIEW_SUBTITLE_STYLE, screenTitleSpan, type SequencePlan } from "./video-montage.ts";
import { parseAssStyle, subtitleLayout, type SubtitleStyle } from "./video-legenda-xml.ts";
import { SHORT_COVER_H, SHORT_COVER_LETTERING_WINDOW_S, SHORT_COVER_W } from "./youtube-thumb.ts";

export interface SrtCue {
  start: number;
  end: number;
  /** Texto da cue, com a quebra de linha do SRT (`\n`). */
  text: string;
}

const TS = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function tsSeconds(s: string): number | null {
  const m = TS.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** Cues de um SRT, em ordem de início. Bloco sem tempo legível ou sem texto é ignorado. */
export function parseSrtCues(srt: string): SrtCue[] {
  const cues: SrtCue[] = [];
  for (const block of srt.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim());
    const k = lines.findIndex((l) => l.includes("-->"));
    if (k < 0) continue;
    const [a, b] = lines[k].split("-->");
    const start = tsSeconds(a);
    const end = tsSeconds(b ?? "");
    const text = lines.slice(k + 1).filter(Boolean).join("\n");
    if (start === null || end === null || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Folga (px) entre a base da caixa da legenda e o topo do painel do gancho. */
export const SHORT_COVER_CAPTION_GAP_PX = 24;
/** O painel não começa abaixo disto: abaixo, o gancho de 2 linhas não cabe. */
export const SHORT_COVER_PANEL_TOP_MAX = 0.8;
/** Margem (s) depois do fim do lettering do título antes de aceitar o frame. */
const AFTER_LETTERING_S = 0.2;

export interface ShortCoverCaptionPlan {
  /** Instante sugerido para o `--at` (s, 1 casa). */
  at: number;
  /** A cue que aparece no frame (a 1ª da fala visível depois do lettering). */
  cue: SrtCue;
  /** A cue é a 1ª do SRT (`false` = a 1ª acabava dentro do lettering do título). */
  firstCue: boolean;
  /** Base da caixa da legenda no quadro de 1080x1920 (px). */
  captionBottomPx: number;
  /** Onde começa o painel para a legenda ficar acima dele (fração da altura, 3 casas). */
  panelTopRatio: number;
  warnings: string[];
}

/**
 * Base da caixa da legenda de `text` no quadro (px), pela geometria da legenda
 * do XML da vertical (`subtitleLayout`, #13332).
 */
export function captionBottomPx(text: string, style: SubtitleStyle = parseAssStyle(PREVIEW_SUBTITLE_STYLE), width = SHORT_COVER_W, height = SHORT_COVER_H): number {
  const { lines } = subtitleLayout(text, width, height, style);
  return Math.max(0, ...lines.map((l) => l.box.y + l.box.h));
}

/**
 * O frame e o painel da capa com a 1ª legenda (#13256). `null` quando o SRT
 * não tem nenhuma cue visível depois do lettering do título. Puro.
 */
export function planShortCoverCaption(
  cues: SrtCue[],
  opts: { style?: SubtitleStyle; letteringS?: number; gapPx?: number } = {},
): ShortCoverCaptionPlan | null {
  const lettering = opts.letteringS ?? SHORT_COVER_LETTERING_WINDOW_S;
  const minAt = lettering + AFTER_LETTERING_S;
  const idx = cues.findIndex((c) => c.end > minAt + 0.1);
  if (idx < 0) return null;
  const cue = cues[idx];
  const from = Math.max(cue.start, minAt);
  const at = Math.round(((from + cue.end) / 2) * 10) / 10;
  const warnings: string[] = [];
  if (idx > 0) {
    warnings.push(
      `a 1ª legenda ("${cues[0].text.replace(/\n/g, " ")}") termina dentro do lettering do título (0–${lettering}s); a capa usa a seguinte ("${cue.text.replace(/\n/g, " ")}")`,
    );
  }
  const bottom = captionBottomPx(cue.text, opts.style);
  let panelTopRatio = Math.ceil(((bottom + (opts.gapPx ?? SHORT_COVER_CAPTION_GAP_PX)) / SHORT_COVER_H) * 1000) / 1000;
  if (panelTopRatio > SHORT_COVER_PANEL_TOP_MAX) {
    warnings.push(`a legenda termina em ${bottom}px: o painel ficaria em ${panelTopRatio}, abaixo do máximo ${SHORT_COVER_PANEL_TOP_MAX}; usado o máximo, a base da legenda pode ficar sob o painel`);
    panelTopRatio = SHORT_COVER_PANEL_TOP_MAX;
  }
  return { at, cue, firstCue: idx === 0, captionBottomPx: bottom, panelTopRatio, warnings };
}

/**
 * Avisos para `--at`/`--panel-top` passados à mão junto do `--srt`: frame fora
 * da cue escolhida, ou painel que cobre a legenda. Puro.
 */
export function shortCoverCaptionWarnings(plan: ShortCoverCaptionPlan, at: number | undefined, panelTopRatio: number | undefined): string[] {
  const out: string[] = [];
  const cueText = plan.cue.text.replace(/\n/g, " ");
  if (at !== undefined && (at < plan.cue.start || at >= plan.cue.end)) {
    out.push(`--at ${at} fica fora da legenda "${cueText}" (${plan.cue.start}–${plan.cue.end}s): a capa pode sair sem a 1ª legenda (#13256); sugerido --at ${plan.at}`);
  }
  if (panelTopRatio !== undefined && Math.round(SHORT_COVER_H * panelTopRatio) < plan.captionBottomPx) {
    out.push(`--panel-top ${panelTopRatio} cobre a legenda (que termina em ${plan.captionBottomPx}px de ${SHORT_COVER_H}): a capa deve mostrar a 1ª legenda (#13256); sugerido --panel-top ${plan.panelTopRatio}`);
  }
  return out;
}

// ── Lettering medido e legenda conferida no frame (#13570) ─────────────────
//
// Na 261118 o `--srt` do vertical V2 escolheu `--at 4.5` contando com o
// lettering do título em 0–3,5 s fixos, e a capa saiu com a caixa do título do
// D1 ainda no alto e nenhuma legenda: o título do vertical dura o bloco de
// abertura (até `SCREEN_TITLE_MAX_S`, 7,5 s, `screenTitleSpan`), não 3,5 s.
// Agora o fim do lettering sai do `plan.json` da montagem (o mesmo
// `screenTitleSpan` que monta o título no XML), e o frame extraído é conferido
// nos pixels antes de afirmar que a legenda está nele.

/**
 * Nome da sequência a partir do SRT da montagem (`{sequência} - legendas.srt`
 * ou `{sequência} - legendas do export.srt`); `null` para outro nome.
 */
export function sequenceNameFromSrtPath(path: string): string | null {
  const m = /^(.+?) - legendas(?: do export)?\.srt$/i.exec(basename(path));
  return m ? m[1] : null;
}

/**
 * Fim do lettering do título (s) na sequência `seqName` do `plan.json` da
 * montagem, pelo `screenTitleSpan` que põe o título no XML. `null` quando o
 * plano não tem a sequência, não tem fps ou a sequência não leva título.
 * Puro sobre o JSON lido.
 */
export function letteringEndFromPlanFile(planFile: unknown, seqName: string): number | null {
  if (!planFile || typeof planFile !== "object") return null;
  const pf = planFile as { source?: { fps?: unknown }; plans?: unknown };
  const fps = typeof pf.source?.fps === "number" && pf.source.fps > 0 ? pf.source.fps : null;
  if (!fps || !Array.isArray(pf.plans)) return null;
  const plan = (pf.plans as SequencePlan[]).find((p) => p?.spec?.name === seqName);
  if (!plan || !Array.isArray(plan.clips)) return null;
  const span = screenTitleSpan(plan, fps);
  if (!span || span.end <= span.start) return null;
  return Math.round((span.end / fps) * 100) / 100;
}

/**
 * Onde a montagem deixa o `plan.json` por padrão (`workDirDefault`): o work
 * dir do modo API (no cache, `DIARIA_VIDEO_CACHE_DIR` ou `~/.cache`) e o do
 * modo local (no tmp). Um `--work-dir` explícito na montagem não é adivinhado:
 * para ele, `--plan`.
 */
export function montagemPlanPathsDefault(edition: string, env: { tmp: string; home: string; cacheEnv?: string }): string[] {
  const out: string[] = [];
  try {
    const cacheDir = driveCacheDir(edition, undefined, env.cacheEnv, env.home, () => "ok");
    out.push(join(workDirDefault("api", cacheDir, env.tmp, edition), "plan.json"));
  } catch {
    /* cache indisponível: fica só o work dir local */
  }
  out.push(join(workDirDefault("local", "", env.tmp, edition), "plan.json"));
  return out;
}

export type LetteringEnd ={ endS: number; from: string } | { endS: null; reason: string };

/**
 * Fim do lettering do título para o vertical do `srtPath`: o 1º `plan.json`
 * de `planPaths` (lido por `read`, `undefined` = ausente ou ilegível) que tem
 * a sequência do SRT com título. Sem nenhum, o motivo, para o CLI avisar que
 * caiu nos 3,5 s fixos. Puro sobre `read`.
 */
export function letteringEndForSrt(srtPath: string, planPaths: string[], read: (p: string) => unknown): LetteringEnd {
  const seq = sequenceNameFromSrtPath(srtPath);
  if (!seq) return { endS: null, reason: `o nome do SRT não é "{sequência} - legendas.srt" da montagem (${basename(srtPath)})` };
  const tried: string[] = [];
  for (const p of planPaths) {
    const pf = read(p);
    if (pf === undefined) {
      tried.push(`${p} (ausente ou ilegível)`);
      continue;
    }
    const end = letteringEndFromPlanFile(pf, seq);
    if (end !== null) return { endS: end, from: `${p}, sequência "${seq}"` };
    tried.push(`${p} (sem a sequência "${seq}" com título)`);
  }
  return { endS: null, reason: tried.length ? tried.join("; ") : "nenhum plan.json da montagem indicado" };
}

export interface CaptionBoxStats {
  /** Pixels conferidos dentro das caixas das linhas da legenda. */
  pixels: number;
  /** Fração de pixels claros (o texto branco da legenda). */
  bright: number;
  /** Fração dos pixels não claros que é escura (o fundo da caixa). */
  dark: number;
  /** Desvio padrão da luminância dos pixels não claros (o fundo da caixa é liso). */
  stdDark: number;
  visible: boolean;
}

/** Luminância a partir da qual o pixel conta como texto branco. */
const CAPTION_BRIGHT_MIN = 200;
/** Luminância até a qual o pixel conta como fundo da caixa (75% opaco sobre o vídeo, `PREVIEW_SUBTITLE_STYLE`). */
const CAPTION_DARK_MAX = 90;

/**
 * Heurística da legenda queimada no frame, sobre a imagem em cinza: dentro das
 * caixas onde a legenda deveria estar, texto claro (≥ 2% dos pixels) sobre um
 * fundo escuro (≥ 60% dos outros pixels) e liso (desvio ≤ 30). Rosto, roupa ou
 * cenário sem a caixa escura falham pelo fundo. Não calibrada em lote de
 * frames reais: o resultado só decide entre `[premissa]` e `[aviso]` no CLI,
 * nunca barra a capa. Puro.
 */
export function captionBoxStats(
  gray: Uint8Array,
  width: number,
  height: number,
  boxes: Array<{ x: number; y: number; w: number; h: number }>,
): CaptionBoxStats {
  let n = 0;
  let bright = 0;
  let darkN = 0;
  let sum = 0;
  let sum2 = 0;
  let rest = 0;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width, Math.ceil(b.x + b.w));
    const y1 = Math.min(height, Math.ceil(b.y + b.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = gray[y * width + x];
        n++;
        if (v >= CAPTION_BRIGHT_MIN) {
          bright++;
          continue;
        }
        rest++;
        sum += v;
        sum2 += v * v;
        if (v <= CAPTION_DARK_MAX) darkN++;
      }
    }
  }
  const mean = rest ? sum / rest : 0;
  const stdDark = rest ? Math.sqrt(Math.max(0, sum2 / rest - mean * mean)) : 0;
  const brightFrac = n ? bright / n : 0;
  const darkFrac = rest ? darkN / rest : 0;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    pixels: n,
    bright: r(brightFrac),
    dark: r(darkFrac),
    stdDark: Math.round(stdDark * 10) / 10,
    visible: n > 0 && brightFrac >= 0.02 && darkFrac >= 0.6 && stdDark <= 30,
  };
}

/**
 * A legenda `text` aparece no frame (JPEG/PNG do vertical)? Escala a geometria
 * de `subtitleLayout` (quadro de 1080x1920) para o tamanho real do frame e
 * aplica `captionBoxStats`.
 */
export async function captionVisibleInFrame(frame: Buffer, text: string, style: SubtitleStyle = parseAssStyle(PREVIEW_SUBTITLE_STYLE)): Promise<CaptionBoxStats> {
  const { data, info } = await sharp(frame).greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sx = info.width / SHORT_COVER_W;
  const sy = info.height / SHORT_COVER_H;
  const boxes = subtitleLayout(text, SHORT_COVER_W, SHORT_COVER_H, style).lines.map((l) => ({ x: l.box.x * sx, y: l.box.y * sy, w: l.box.w * sx, h: l.box.h * sy }));
  // Por garantia, com mais de 1 canal só o 1º conta (em cinza os canais são iguais).
  const gray = info.channels === 1 ? new Uint8Array(data) : Uint8Array.from({ length: info.width * info.height }, (_, i) => data[i * info.channels]);
  return captionBoxStats(gray, info.width, info.height, boxes);
}
