/**
 * test/video-montagem-12093-11756-residuo.test.ts — o resíduo de duas issues
 * do gerador de montagem de vídeo, depois da PR #12142 / commit 046eef9d:
 *   - #11756: na vertical "soberana" (261103) o XML punha o `titulo-tela` em
 *     0–2526 quadros, a sequência inteira (84 s); o título dura o 1º trecho
 *     contíguo do bloco e no máximo `SCREEN_TITLE_MAX_S` (7,5 s);
 *   - #12093 (1º comentário): no Gate 2, artigo/preposição do roteiro que a
 *     retranscrição da janela ouve diferente ("utilizado o deepfake" ×
 *     "utilizado deepfake", "o" × "um") vira item para o editor decidir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildXmeml,
  firstTitledVertical,
  SCREEN_TITLE_MAX_S,
  screenTitleSpan,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { isShortWord, shortWordDivergences, shortWordSection } from "../scripts/lib/diaria/video-short-words.ts";

const FPS = 30;
const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261103/bruto.mp4", fps: FPS, durationS: 900, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_soberana_V1", width: 1080, height: 1920, order: ["comentario"], scales: [115, 130], corte: "soberana" };

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number, parts?: PlannedClip["parts"]): PlannedClip {
  return { block, srcIn: frameIn / FPS, srcOut: (frameIn + len) / FPS, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115, ...(parts ? { parts } : {}) };
}

function plan(spec: SequenceSpec, clips: PlannedClip[]): SequencePlan {
  return { spec, clips, durationFrames: clips.length ? clips[clips.length - 1].seqEnd : 0, script: "", missingBlocks: [], dropped: [] };
}

/** A "soberana": um bloco só (o comentário), 2526 quadros em vários clipes. */
const SOBERANA = [clip("comentario", 0, 40, 1000), clip("comentario", 40, 900, 1100), clip("comentario", 940, 1586, 2100)];

describe("#11756: título da vertical nunca cobre a sequência inteira", () => {
  it("a 'soberana' (um bloco só, 2526 quadros): título em 0–225 (7,5 s a 30 fps)", () => {
    assert.equal(SCREEN_TITLE_MAX_S, 7.5);
    assert.deepEqual(screenTitleSpan(plan(SPEC_V, SOBERANA), FPS), { start: 0, end: 225, block: "comentario" });
  });

  it("no XML, o clipe do título da 'soberana' vai de 0 a 225, não até 2526", () => {
    const xml = buildXmeml([plan(SPEC_V, SOBERANA)], SOURCE, FRAMING, { screenTitle: { text: "O que é IA soberana?", mode: "png", pngPath: "G:/Meu Drive/YouTube/261103/261103_titulo_vertical.png" } });
    const title = xml.match(/<clipitem id="titulo-1">[\s\S]*?<\/clipitem>/)?.[0] ?? "";
    assert.match(title, /<start>0<\/start><end>225<\/end><in>0<\/in><out>225<\/out>/);
    assert.doesNotMatch(title, /<end>2526<\/end>/);
  });

  it("bloco de título curto fica com a duração dele (o teto não estica)", () => {
    const clips = [clip("titulo", 0, 60, 300), clip("titulo", 60, 45, 400), clip("comentario", 105, 300, 900)];
    assert.deepEqual(screenTitleSpan(plan(SPEC_V, clips), FPS), { start: 0, end: 105, block: "titulo" });
  });

  it("só o 1º trecho contíguo do bloco: o bloco que volta mais adiante não estende o título", () => {
    const clips = [clip("abertura", 0, 90, 10), clip("comentario", 90, 60, 500), clip("abertura", 150, 30, 700)];
    assert.deepEqual(screenTitleSpan(plan(SPEC_V, clips), FPS), { start: 0, end: 90, block: "abertura" });
  });

  it("clipe fundido de blocos diferentes: o título termina no fim do pedaço do bloco", () => {
    // 4 s de abertura + 10 s de comentário num clipe só (contíguos no bruto).
    const fused = clip("abertura", 0, 420, 300, [
      { block: "abertura", srcIn: 10, srcOut: 14 },
      { block: "comentario", srcIn: 14, srcOut: 24 },
    ]);
    assert.deepEqual(screenTitleSpan(plan(SPEC_V, [fused]), FPS), { start: 0, end: 120, block: "abertura" });
  });

  it("sem fps a função segue servindo para achar a vertical com título", () => {
    assert.equal(firstTitledVertical([plan(SPEC_V, SOBERANA)])?.spec.name, SPEC_V.name);
    assert.equal(screenTitleSpan(plan(SPEC_V, []), FPS), null);
  });
});

const words = (spec: string, t0 = 10, step = 0.3): Word[] =>
  spec.split(" ").map((text, i) => ({ start: t0 + i * step, end: t0 + i * step + 0.25, text }));

describe("#12093: palavras curtas do roteiro × retranscrição da janela", () => {
  it("o caso da 261104: o editor tirou o artigo ('utilizado deepfake'), a janela ouve 'o'", () => {
    const heard = words("numa chamada onde foi utilizado o deepfake");
    assert.deepEqual(shortWordDivergences(heard, "numa chamada onde foi utilizado deepfake"), [{ script: "", heard: "o", at: 11.5 }]);
  });

  it("troca de artigo: o roteiro diz 'o', a janela ouve 'um'", () => {
    const d = shortWordDivergences(words("foi utilizado um deepfake na chamada"), "foi utilizado o deepfake na chamada");
    assert.deepEqual(d, [{ script: "o", heard: "um" }]);
  });

  it("artigo do roteiro que a janela não ouviu", () => {
    const d = shortWordDivergences(words("foi utilizado deepfake na chamada"), "foi utilizado um deepfake na chamada");
    assert.deepEqual(d, [{ script: "um", heard: "" }]);
  });

  it("roteiro e ouvido iguais, ou a folga da janela nas bordas: nenhuma divergência", () => {
    assert.deepEqual(shortWordDivergences(words("foi utilizado um deepfake"), "foi utilizado um deepfake"), []);
    // "o" e "a" ouvidos antes/depois do item são a folga da janela, não divergência.
    assert.deepEqual(shortWordDivergences(words("o foi utilizado um deepfake a"), "foi utilizado um deepfake"), []);
  });

  it("troca entre palavras longas não é com esta conferência", () => {
    assert.deepEqual(shortWordDivergences(words("criminosos estão usando IA"), "criminosos estão utilizando IA"), []);
    assert.equal(isShortWord("Uma,"), true);
    assert.equal(isShortWord("deepfake"), false);
  });

  it("sem retranscrição ou sem texto: nada a comparar", () => {
    assert.deepEqual(shortWordDivergences([], "foi utilizado um deepfake"), []);
    assert.deepEqual(shortWordDivergences(words("foi utilizado"), "  "), []);
  });

  it("a seção do Gate 2: tabela com item, trecho, roteiro e ouvido; aviso quando não rodou", () => {
    const md = shortWordSection([
      { id: "resumo[1]", text: "numa chamada onde foi utilizado deepfake", start: 30, end: 33, divergences: [{ script: "", heard: "o", at: 31.5 }] },
      { id: "comentario[0]", text: "foi utilizado o deepfake", start: 40, end: 42, divergences: [{ script: "o", heard: "um" }] },
      { id: "fecho[0]", text: "até amanhã", start: 90, end: 91, divergences: [] },
    ]).join("\n");
    assert.match(md, /## Palavras curtas: roteiro × retranscrição \(#12093\)/);
    assert.match(md, /\| resumo\[1\] \| 31\.5 s \| \(sem a palavra\) \| o \|/);
    assert.match(md, /\| comentario\[0\] \| 40\.0–42\.0 s \| o \| um \|/);
    assert.doesNotMatch(md, /fecho\[0\]/);
    assert.match(shortWordSection([{ id: "fecho[0]", text: "até amanhã", start: 90, end: 91, divergences: [] }]).join("\n"), /Nenhuma divergência em 1 item/);
    const skipped = shortWordSection(null, "áudio do bruto ausente").join("\n");
    assert.match(skipped, /\[aviso\] conferência não rodou \(áudio do bruto ausente\)/);
    assert.doesNotMatch(skipped, /Nenhuma divergência/);
  });
});
