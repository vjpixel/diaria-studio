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
import { PREVIEW_SUBTITLE_STYLE } from "./video-montage.ts";
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
