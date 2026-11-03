/**
 * test/video-montage-xml-11755-11756.test.ts — dois achados da análise #11670
 * sobre o que o editor ainda fazia à mão no Premiere depois do XML:
 *   - #11755: o áudio entrava no nível do bruto (quente, ~-9,5 LUFS, true peak
 *     acima de 0): agora cada clipe de áudio leva o Audio Levels do FCP7 com o
 *     ganho para -14 LUFS, teto -1 dBTP;
 *   - #11756: o título em texto da vertical era lettering à mão: agora a V2
 *     das verticais leva o título (gerador de texto do FCP7, ou PNG).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_GAIN_TARGET_LUFS,
  AUDIO_LEVELS_MAX_DB,
  audioGainFor,
  buildXmeml,
  firstTitledVertical,
  isVerticalSpec,
  parseBlocksFile,
  screenTitleSpan,
  screenTitleSvg,
  wrapScreenTitle,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
} from "../scripts/lib/diaria/video-montage.ts";
import { audioGainLine, parseTitleModeArg, resolveScreenTitle, titlePngXmlPath } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261030/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [50, 62] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario"], scales: [115, 130] };

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}

function plan(spec: SequenceSpec, clips: PlannedClip[]): SequencePlan {
  return { spec, clips, durationFrames: clips.length ? clips[clips.length - 1].seqEnd : 0, script: "", missingBlocks: [], dropped: [] };
}

const V_CLIPS = [clip("titulo", 0, 60, 300), clip("titulo", 60, 45, 400), clip("comentario", 105, 300, 900)];

describe("#11755: ganho de áudio por clipe a partir do loudness.json", () => {
  it("bruto quente da 261028 (-9,87 LUFS, TP +0,68): baixa até -14 LUFS (-4,13 dB)", () => {
    const g = audioGainFor({ inputI: -9.87, inputTp: 0.68, inputLra: 5 });
    assert.ok(g);
    assert.equal(g.db, -4.13);
    assert.equal(g.limitedBy, "target");
    assert.ok(Math.abs(g.linear - 10 ** (-4.13 / 20)) < 1e-6);
  });

  it("as 3 edições da análise caem no alvo sem passar de -1 dBTP", () => {
    for (const m of [
      { inputI: -9.87, inputTp: 0.68 },
      { inputI: -9.39, inputTp: 0.62 },
      { inputI: -9.43, inputTp: 0.33 },
    ]) {
      const g = audioGainFor({ ...m, inputLra: 5 });
      assert.ok(g);
      assert.ok(Math.abs(m.inputI + g.db - AUDIO_GAIN_TARGET_LUFS) < 0.01, `I final ${m.inputI + g.db}`);
      assert.ok(m.inputTp + g.db <= -1 + 1e-9, `TP final ${m.inputTp + g.db}`);
    }
  });

  it("bruto baixo com pico alto: o teto de true peak limita o ganho", () => {
    const g = audioGainFor({ inputI: -31, inputTp: -6, inputLra: 8 });
    assert.ok(g);
    assert.equal(g.db, 5);
    assert.equal(g.limitedBy, "true-peak");
  });

  it("ganho acima de +12 dB para no máximo do Audio Levels", () => {
    const g = audioGainFor({ inputI: -40, inputTp: -30, inputLra: 8 });
    assert.ok(g);
    assert.equal(g.db, AUDIO_LEVELS_MAX_DB);
    assert.equal(g.limitedBy, "max");
    assert.ok(g.linear <= 3.98109 + 1e-5);
  });

  it("sem medida, sem ganho; sem true peak, só atenua", () => {
    assert.equal(audioGainFor(null), null);
    assert.equal(audioGainFor({ inputI: -20, inputTp: Number.NaN, inputLra: 5 }), null);
    assert.equal(audioGainFor({ inputI: -10, inputTp: Number.NaN, inputLra: 5 })?.db, -4);
  });

  it("o XML leva o Audio Levels em CADA clipe de áudio e em nenhum de vídeo", () => {
    const g = audioGainFor({ inputI: -9.87, inputTp: 0.68, inputLra: 5 });
    const xml = buildXmeml([plan(SPEC_H, V_CLIPS), plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING, { audioGain: g });
    const audioClips = xml.match(/<clipitem id="a\d+">[\s\S]*?<\/clipitem>/g) ?? [];
    const videoClips = xml.match(/<clipitem id="v\d+">[\s\S]*?<\/clipitem>/g) ?? [];
    assert.equal(audioClips.length, 6);
    for (const c of audioClips) {
      assert.match(c, /<effectid>audiolevels<\/effectid>/);
      assert.match(c, /<parameterid>level<\/parameterid>[\s\S]*<value>0\.621584<\/value>/);
    }
    for (const c of videoClips) assert.doesNotMatch(c, /audiolevels/);
  });

  it("sem ganho (--no-audio-gain ou sem loudness), o XML sai como antes", () => {
    const before = buildXmeml([plan(SPEC_H, V_CLIPS)], SOURCE, FRAMING);
    assert.equal(buildXmeml([plan(SPEC_H, V_CLIPS)], SOURCE, FRAMING, { audioGain: null }), before);
    assert.doesNotMatch(before, /audiolevels/);
  });

  it("o relato diz o ganho, o limite e pede a conferência no import", () => {
    const line = audioGainLine(audioGainFor({ inputI: -9.87, inputTp: 0.68, inputLra: 5 }), -9.87, 0.68);
    assert.match(line, /-4\.13 dB/);
    assert.match(line, /1º import/);
    assert.match(audioGainLine(null), /\[aviso\]/);
  });
});

describe("#11756: título em texto na abertura da vertical", () => {
  it("título vem do screenTitle do blocks.json, senão do D1 sem markdown", () => {
    assert.deepEqual(resolveScreenTitle({ blocksTitle: "Pais acusam ChatGPT de matar sua filha", d1Title: "outro" }), { text: "Pais acusam ChatGPT de matar sua filha", how: "blocks" });
    assert.deepEqual(resolveScreenTitle({ blocksTitle: "  ", d1Title: "outro" }), { text: null, how: "blocks-off" });
    assert.deepEqual(resolveScreenTitle({ d1Title: "**Lula** quer criar IA brasileira" }), { text: "Lula quer criar IA brasileira", how: "d1" });
    assert.deepEqual(resolveScreenTitle({ d1Title: null }), { text: null, how: "missing" });
  });

  it("blocks.json aceita screenTitle string e recusa outro tipo", () => {
    const base = { edition: "261030", blocks: { comentario: [{ text: "oi" }] } };
    assert.equal(parseBlocksFile({ ...base, screenTitle: "Título curto" }).ok, true);
    const bad = parseBlocksFile({ ...base, screenTitle: 3 });
    assert.equal(bad.ok, false);
    assert.ok(!bad.ok && bad.errors.some((e) => e.includes("screenTitle")));
  });

  it("--title-mode: text por padrão, png/off aceitos, outro valor é erro", () => {
    assert.equal(parseTitleModeArg(undefined), "text");
    assert.equal(parseTitleModeArg("png"), "png");
    assert.equal(parseTitleModeArg("off"), "off");
    assert.throws(() => parseTitleModeArg(""), /title-mode/);
  });

  it("trecho do título: os clipes do bloco titulo; sem ele, o 1º bloco (261029)", () => {
    assert.deepEqual(screenTitleSpan(plan(SPEC_V, V_CLIPS)), { start: 0, end: 105, block: "titulo" });
    const semTitulo = [clip("abertura", 0, 90, 10), clip("comentario", 90, 200, 500)];
    assert.deepEqual(screenTitleSpan(plan(SPEC_V, semTitulo)), { start: 0, end: 90, block: "abertura" });
    assert.equal(screenTitleSpan(plan(SPEC_V, [])), null);
  });

  it("quebra em linhas de até 22 caracteres (#11941; eram 20)", () => {
    assert.deepEqual(wrapScreenTitle("Pais acusam ChatGPT de matar sua filha"), ["Pais acusam ChatGPT de", "matar sua filha"]);
    assert.deepEqual(wrapScreenTitle("GPT 6.1 Terra está mais barato e mais eficaz"), ["GPT 6.1 Terra está", "mais barato e mais", "eficaz"]);
  });

  it("modo text: gerador de texto na V2 SÓ da vertical, no trecho do título", () => {
    const xml = buildXmeml([plan(SPEC_H, V_CLIPS), plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING, { screenTitle: { text: "Pais acusam ChatGPT de matar sua filha", mode: "text" } });
    const seqs = xml.split("<sequence ").slice(1);
    assert.equal(seqs.length, 2);
    assert.doesNotMatch(seqs[0], /generatoritem/, "o horizontal do YouTube não leva título na tela");
    const gens = (seqs[1].match(/<generatoritem[\s\S]*?<\/generatoritem>/g) ?? []).filter((x) => x.includes("<name>titulo-tela</name>"));
    assert.equal(gens.length, 1);
    const g = gens[0];
    assert.match(g, /<start>0<\/start><end>105<\/end><in>0<\/in><out>105<\/out>/);
    assert.match(g, /<effectid>Text<\/effectid>[\s\S]*<effecttype>generator<\/effecttype>/);
    assert.match(g, /<parameterid>str<\/parameterid><name>Text<\/name><value>Pais acusam ChatGPT de&#10;matar sua filha<\/value>/);
    assert.match(g, /<parameterid>fontname<\/parameterid><name>Font<\/name><value>Georgia<\/value>/);
    assert.match(g, /<parameterid>fontstyle<\/parameterid>[\s\S]*?<value>2<\/value>/, "negrito");
    // V2 = fundo (#11941), V3 = texto, depois da faixa dos clipes.
    const video = seqs[1].slice(seqs[1].indexOf("<video>"), seqs[1].indexOf("</video>"));
    assert.equal((video.match(/<track>/g) ?? []).length, 3);
    assert.ok(video.indexOf("<generatoritem") > video.indexOf('<clipitem id="v'));
  });

  it("o texto do título é escapado no XML", () => {
    const xml = buildXmeml([plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING, { screenTitle: { text: "IA & <Brasil>", mode: "text" } });
    assert.match(xml, /<value>IA &amp; &lt;Brasil&gt;<\/value>/);
  });

  it("modo png: clipe do PNG na V2 de cada vertical, <file> definido uma vez", () => {
    const SPEC_IG: SequenceSpec = { ...SPEC_V, target: "instagram", name: "Diaria comentada_Instagram_V1" };
    const pngPath = titlePngXmlPath(SOURCE.path, "261030");
    assert.equal(pngPath, "G:/Meu Drive/YouTube/261030/261030_titulo_vertical.png");
    const xml = buildXmeml([plan(SPEC_H, V_CLIPS), plan(SPEC_IG, V_CLIPS), plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING, { screenTitle: { text: "Título", mode: "png", pngPath } });
    assert.doesNotMatch(xml, /generatoritem/);
    const titleClips = xml.match(/<clipitem id="titulo-\d+">[\s\S]*?<\/clipitem>/g) ?? [];
    assert.equal(titleClips.length, 2);
    assert.match(titleClips[0], /<file id="file-titulo"><name>261030_titulo_vertical\.png<\/name><pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/YouTube\/261030\/261030_titulo_vertical\.png<\/pathurl>/);
    assert.match(titleClips[1], /<file id="file-titulo"\/>/);
    for (const c of titleClips) assert.match(c, /<start>0<\/start><end>105<\/end><in>0<\/in><out>105<\/out>/);
  });

  it("sem título (off, vazio ou ausente), o XML sai como antes", () => {
    const before = buildXmeml([plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING);
    assert.equal(buildXmeml([plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING, { screenTitle: null }), before);
    assert.equal(buildXmeml([plan(SPEC_V, V_CLIPS)], SOURCE, FRAMING, { screenTitle: { text: " ", mode: "text" } }), before);
    assert.doesNotMatch(before, /titulo-tela/);
  });

  it("PNG de reserva: SVG transparente do tamanho da vertical, escapado, e a 1ª vertical com título dá o tamanho", () => {
    const svg = screenTitleSvg("IA & você", 1080, 1920);
    assert.match(svg, /width="1080" height="1920"/);
    assert.match(svg, /<rect [^>]*fill="#000000" fill-opacity="0.7"/, "fundo preto a 70% (#11941); fora dele o PNG sai com alfa");
    assert.match(svg, /IA &amp; você/);
    assert.match(svg, /font-weight="700"/);
    assert.equal(isVerticalSpec(SPEC_H), false);
    assert.equal(firstTitledVertical([plan(SPEC_H, V_CLIPS), plan(SPEC_V, [])]), null);
    assert.equal(firstTitledVertical([plan(SPEC_H, V_CLIPS), plan(SPEC_V, V_CLIPS)])?.spec.target, "outras-redes");
  });
});
