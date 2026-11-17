/**
 * test/video-legenda-xml-13332.test.ts — legenda das verticais dentro do XML
 * (#13332, pedido do editor de 16/11/2026): o Premiere não importa SRT de
 * dentro do xmeml, então cada cue vira um PNG no estilo da prévia, numa faixa
 * no topo do vídeo da sequência. Na 261117 isso foi feito à mão por um script
 * no scratchpad; aqui o `srt` grava a faixa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  ASS_PLAY_RES,
  cueFrames,
  parseAssColour,
  parseAssStyle,
  subtitleCueSvg,
  subtitleDirName,
  subtitleFileName,
  subtitleLayout,
  subtitleTrack,
  withSubtitleTrack,
  type SubtitleOverlay,
} from "../scripts/lib/diaria/video-legenda-xml.ts";
import { PREVIEW_SUBTITLE_STYLE, buildXmeml, pathUrl, type PlannedClip, type SequencePlan, type SequenceSpec, type SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { parseXmlAudio, xmlPlanIssues } from "../scripts/lib/diaria/video-xml-verify.ts";
import { subtitleSubdirsIn } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261117/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["gancho", "comentario"], scales: [115, 130] };
const clip = (block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip => ({
  block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115,
});
const pv: SequencePlan = { spec: SPEC_V, clips: [clip("gancho", 0, 90, 300), clip("comentario", 90, 60, 900)], durationFrames: 150, script: "", missingBlocks: [], dropped: [] };
const rate = "<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>";
const ov = (index: number, a: number, b: number, xmlPath = `G:/Meu Drive/YouTube/261117/legendas-vertical/261117_legenda_00${index}-h.png`): SubtitleOverlay => ({
  index, text: `cue ${index}`, path: `/out/${index}.png`, xmlPath, width: 1080, height: 1920, in: a, out: b,
});

describe("#13332: o estilo sai da string da prévia", () => {
  it("PREVIEW_SUBTITLE_STYLE: Arial 10, caixa escura a 75%, embaixo no centro, MarginV 100", () => {
    const s = parseAssStyle(PREVIEW_SUBTITLE_STYLE);
    assert.equal(s.font, "Arial");
    assert.equal(s.fontSize, 10);
    assert.equal(s.box, true);
    assert.equal(s.alignment, 2);
    assert.equal(s.marginV, 100);
    assert.deepEqual(s.primary, { r: 255, g: 255, b: 255, opacity: 1 });
    assert.deepEqual({ r: s.back.r, g: s.back.g, b: s.back.b }, { r: 0x10, g: 0x1a, b: 0x20 });
    assert.ok(Math.abs(s.back.opacity - 0.75) < 0.01, `opacidade ${s.back.opacity}`);
  });

  it("cor ASS: &HAABBGGRR, alfa invertido; inválida é erro", () => {
    assert.deepEqual(parseAssColour("&H000000FF"), { r: 255, g: 0, b: 0, opacity: 1 });
    assert.deepEqual(parseAssColour("&HFF00FF00"), { r: 0, g: 255, b: 0, opacity: 0 });
    assert.throws(() => parseAssColour("vermelho"), /#13332/);
  });

  it("geometria na escala do PlayRes do ASS: a letra e a margem crescem com a altura do quadro", () => {
    const s = parseAssStyle(PREVIEW_SUBTITLE_STYLE);
    const k = 1920 / ASS_PLAY_RES.y;
    const { fontPx, lines, anchor } = subtitleLayout("uma linha\nsegunda linha", 1080, 1920, s);
    assert.equal(anchor, "middle");
    assert.ok(Math.abs(fontPx - 10 * k) < 0.01);
    assert.equal(lines.length, 2);
    const last = lines[lines.length - 1];
    assert.ok(Math.abs(last.box.y + last.box.h - (1920 - 100 * k + s.outline * k)) <= 2, "a base da caixa de baixo fica no MarginV (mais a margem da caixa)");
    assert.ok(lines[0].box.y < last.box.y, "a 1ª linha fica acima");
    for (const l of lines) assert.ok(Math.abs(l.box.x + l.box.w / 2 - 540) <= 1, "centrada");
  });

  it("linha mais larga que o quadro quebra nas palavras", () => {
    const s = parseAssStyle(PREVIEW_SUBTITLE_STYLE);
    const { lines } = subtitleLayout("palavra ".repeat(30).trim(), 1080, 1920, s);
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(l.box.x >= 0 && l.box.x + l.box.w <= 1080, `"${l.text}" cabe`);
  });

  it("SVG transparente fora das caixas, texto escapado, uma caixa por linha", async () => {
    const svg = subtitleCueSvg("A & B\nC < D", 1080, 1920, parseAssStyle(PREVIEW_SUBTITLE_STYLE));
    assert.match(svg, /width="1080" height="1920"/);
    assert.match(svg, />A &amp; B</);
    assert.match(svg, />C &lt; D</);
    assert.equal((svg.match(/<rect /g) ?? []).length, 2);
    const png = await sharp(Buffer.from(svg)).png().raw().toBuffer({ resolveWithObject: true });
    assert.equal(png.info.width, 1080);
    assert.equal(png.info.height, 1920);
    assert.equal(png.data[3], 0, "canto de cima transparente");
  });
});

describe("#13332: nomes", () => {
  it("subpasta: legendas-vertical na da edição, legendas-vertical-{corte} no corte (as da 261117)", () => {
    assert.equal(subtitleDirName("outras-redes"), "legendas-vertical");
    assert.equal(subtitleDirName("instagram"), "legendas-vertical");
    assert.equal(subtitleDirName("guia"), "legendas-vertical-guia");
    assert.equal(subtitleFileName("261117", 7, "abc"), "261117_legenda_007-abc.png");
  });

  it("subpastas do out dir que sobem para o Drive: só as de legenda", () => {
    const dir = mkdtempSync(join(tmpdir(), "leg-13332-"));
    try {
      for (const d of ["legendas-vertical", "legendas-vertical-guia", "trechos", "legendas-outra"]) mkdirSync(join(dir, d));
      assert.deepEqual(subtitleSubdirsIn(dir).sort(), ["legendas-vertical", "legendas-vertical-guia"]);
      assert.deepEqual(subtitleSubdirsIn(join(dir, "nao-existe")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13332: faixa no XML", () => {
  it("cues em quadros: arredonda e corta no fim da fala", () => {
    assert.deepEqual(cueFrames([{ start: 0.01, end: 1.5 }, { start: 4.9, end: 6 }], 30, 150), [{ in: 0, out: 45 }, { in: 147, out: 150 }]);
  });

  it("um clipe por cue no tempo dela, nome 'legenda N', <file> definido uma vez por PNG", () => {
    const shared = "G:/Meu Drive/YouTube/261117/legendas-vertical/igual.png";
    const t = subtitleTrack({ overlays: [ov(1, 0, 45), ov(2, 45, 90, shared), ov(3, 100, 140, shared)], rate, url: pathUrl });
    assert.equal((t.match(/<clipitem id="legenda-\d+">/g) ?? []).length, 3);
    assert.match(t, /<name>legenda 1<\/name>/);
    assert.match(t, /<start>45<\/start><end>90<\/end>/);
    assert.equal((t.match(/<pathurl>/g) ?? []).length, 2, "o PNG repetido é só referenciado");
    assert.match(t, /<file id="file-legenda-2"\/>/);
    assert.match(t, /legendas-vertical\/261117_legenda_001-h\.png<\/pathurl>/);
  });

  it("no topo do vídeo da sequência; o áudio (verify-xml) não muda; srt de novo troca a faixa", () => {
    const xml = buildXmeml([pv], SOURCE, { faceX: 0.5, eyeY: 0.5 }, {});
    const t1 = subtitleTrack({ overlays: [ov(1, 0, 45), ov(2, 45, 90)], rate, url: pathUrl });
    const once = withSubtitleTrack(xml, t1);
    const videoEnd = once.indexOf("</video>\n<audio><numOutputChannels>");
    const lastTrack = once.lastIndexOf("<track>", videoEnd);
    assert.ok(once.slice(lastTrack, videoEnd).startsWith('<track><clipitem id="legenda-1">'), "a última faixa de vídeo é a da legenda");
    assert.deepEqual(parseXmlAudio(once).clips, parseXmlAudio(xml).clips, "os clipes de áudio que o verify-xml lê são os mesmos");
    assert.deepEqual(xmlPlanIssues(parseXmlAudio(once), { clips: 2, durationFrames: 150 }), []);
    const t2 = subtitleTrack({ overlays: [ov(1, 10, 50)], rate, url: pathUrl });
    const twice = withSubtitleTrack(once, t2);
    assert.equal((twice.match(/<clipitem id="legenda-/g) ?? []).length, 1, "a faixa anterior saiu");
    assert.match(twice, /<start>10<\/start><end>50<\/end>/);
    assert.equal(withSubtitleTrack(twice, ""), xml, "faixa vazia devolve o XML do build");
  });

  it("XML sem o vídeo da sequência, ou com duas, é erro (nada é gravado pela metade)", () => {
    assert.throws(() => withSubtitleTrack("<xmeml></xmeml>", "x"), /#13332/);
    const xml = buildXmeml([pv], SOURCE, { faceX: 0.5, eyeY: 0.5 }, {});
    assert.throws(() => withSubtitleTrack(xml + xml, "x"), /mais de uma sequência/);
  });
});
