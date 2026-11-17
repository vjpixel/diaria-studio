/**
 * #13256: na 261116 o editor escolheu, entre três opções de capa do Short, o
 * frame de 9 s com a 1ª legenda da fala ("O Google lançou o Gemini 4
 * Hydrogen.") e disse: "a capa deve incluir a 1a legenda". O default
 * `--panel-top 0.62` cobria a legenda queimada. Agora `--short-cover --srt`
 * sugere o instante da 1ª legenda e põe o painel abaixo da caixa dela.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captionBottomPx, parseSrtCues, planShortCoverCaption, shortCoverCaptionWarnings, SHORT_COVER_PANEL_TOP_MAX } from "../scripts/lib/diaria/short-cover-caption.ts";
import { PREVIEW_SUBTITLE_STYLE } from "../scripts/lib/diaria/video-montage.ts";
import { parseAssStyle, subtitleLayout } from "../scripts/lib/diaria/video-legenda-xml.ts";
import { SHORT_COVER_H, SHORT_COVER_PANEL_TOP_RATIO } from "../scripts/lib/diaria/youtube-thumb.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// O vertical da 261116: o lettering do título nos 3,5 s iniciais, a 1ª legenda da fala a partir de 7,9 s.
const srt261116 = [
  "1\n00:00:07,900 --> 00:00:10,200\nO Google lançou o Gemini\n4 Hydrogen.\n",
  "2\n00:00:10,200 --> 00:00:12,600\nÉ de graça para quem usa.\n",
].join("\n");

describe("#13256: capa do Short com a 1ª legenda", () => {
  it("parseSrtCues lê tempos, texto com quebra e ignora bloco sem tempo", () => {
    const cues = parseSrtCues("﻿" + srt261116 + "\nlixo sem tempo\n");
    assert.equal(cues.length, 2);
    assert.deepEqual(cues[0], { start: 7.9, end: 10.2, text: "O Google lançou o Gemini\n4 Hydrogen." });
  });

  it("regressão: o painel default (0.62) cobria a legenda; o sugerido fica abaixo da caixa dela", () => {
    const plan = planShortCoverCaption(parseSrtCues(srt261116));
    assert.ok(plan);
    // A caixa da legenda, pela mesma geometria dos PNGs da legenda do XML (#13332).
    const layout = subtitleLayout(plan.cue.text, 1080, 1920, parseAssStyle(PREVIEW_SUBTITLE_STYLE));
    const top = Math.min(...layout.lines.map((l) => l.box.y));
    const bottom = Math.max(...layout.lines.map((l) => l.box.y + l.box.h));
    assert.equal(plan.captionBottomPx, bottom);
    assert.ok(SHORT_COVER_H * SHORT_COVER_PANEL_TOP_RATIO < bottom, "o default cobre a legenda: é o bug");
    assert.ok(SHORT_COVER_H * plan.panelTopRatio >= bottom, `painel ${plan.panelTopRatio} começa acima da base da legenda (${bottom}px)`);
    assert.ok(SHORT_COVER_H * plan.panelTopRatio > top, "a legenda inteira fica acima do painel");
    assert.ok(plan.panelTopRatio <= SHORT_COVER_PANEL_TOP_MAX);
  });

  it("sugere o instante no meio da 1ª legenda, depois do lettering do título", () => {
    const plan = planShortCoverCaption(parseSrtCues(srt261116));
    assert.ok(plan);
    assert.equal(plan.at, 9.1);
    assert.equal(plan.firstCue, true);
    assert.deepEqual(plan.warnings, []);
  });

  it("1ª legenda dentro do lettering: usa a seguinte, com aviso", () => {
    const plan = planShortCoverCaption(parseSrtCues("1\n00:00:01,000 --> 00:00:03,000\nOi!\n\n2\n00:00:03,000 --> 00:00:06,000\nO Google lançou.\n"));
    assert.ok(plan);
    assert.equal(plan.cue.text, "O Google lançou.");
    assert.ok(plan.at > 3.5 && plan.at < 6, String(plan.at));
    assert.equal(plan.firstCue, false);
    assert.match(plan.warnings.join("\n"), /termina dentro do lettering/);
  });

  it("sem legenda depois do lettering: null", () => {
    assert.equal(planShortCoverCaption(parseSrtCues("1\n00:00:00,500 --> 00:00:03,000\nOi!\n")), null);
    assert.equal(planShortCoverCaption([]), null);
  });

  it("legenda de 2 linhas desce o painel mais que a de 1", () => {
    assert.ok(captionBottomPx("uma linha") <= captionBottomPx("O Google lançou o Gemini\n4 Hydrogen."));
  });

  it("--at e --panel-top à mão que escondem a legenda viram aviso", () => {
    const plan = planShortCoverCaption(parseSrtCues(srt261116));
    assert.ok(plan);
    const w = shortCoverCaptionWarnings(plan, 14, SHORT_COVER_PANEL_TOP_RATIO);
    assert.equal(w.length, 2);
    assert.match(w[0], /--at 14 fica fora da legenda/);
    assert.match(w[1], /--panel-top 0.62 cobre a legenda/);
    assert.deepEqual(shortCoverCaptionWarnings(plan, plan.at, plan.panelTopRatio), []);
  });

  it("o CLI aceita --srt no lugar de --at e documenta a flag", () => {
    const src = readFileSync(resolve(ROOT, "scripts/gen-youtube-thumb.ts"), "utf8");
    assert.match(src, /planShortCoverCaption\(parseSrtCues\(/);
    assert.match(src, /--short-cover \(--at SEGUNDOS \| --srt SRT_DO_VERTICAL\)/);
  });
});
