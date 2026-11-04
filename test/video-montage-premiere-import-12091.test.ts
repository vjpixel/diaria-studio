/**
 * test/video-montage-premiere-import-12091.test.ts — 1º import validado no
 * Premiere pelo editor (261104):
 *   1. o Center do Basic Motion é lido como fração da largura/altura do BRUTO,
 *      não da sequência: `0.1225` num bruto 3840 virou 470,4 px de Position
 *      quando o deslocamento pretendido era 132 px (rosto à direita);
 *   2. o gerador "Text" mostrou `&#10;` literal na tela e o fundo Color+Crop
 *      virou um bloco preto. O build passa a usar o PNG por padrão; o gerador
 *      só sai com `--title-mode text`, com a quebra como CR literal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildXmeml,
  framingFor,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
} from "../scripts/lib/diaria/video-montage.ts";
import { parseTitleModeArg, screenTitleXmlFor, titlePngXmlPath } from "../scripts/video-montagem.ts";

/** Deslocamento do centro do recorte em px da SEQUÊNCIA (o que o Premiere tem que aplicar na Position). */
function seqShift(fr: ReturnType<typeof framingFor>, srcW: number, srcH: number) {
  const s = fr.scalePct / 100;
  return { dx: (srcW / 2 - (fr.crop.x + fr.crop.w / 2)) * s, dy: (srcH / 2 - (fr.crop.y + fr.crop.h / 2)) * s };
}

describe("#12091 Center do Basic Motion em fração do bruto", () => {
  it("vertical 1080x1920 a 115% num bruto 3840x2160, rosto em 0,47: horiz × 3840 ≈ 132 px", () => {
    const fr = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 115, framing: { faceX: 0.47, eyeY: 0.54 } });
    const { dx, dy } = seqShift(fr, 3840, 2160);
    assert.ok(Math.abs(dx - 132) < 1, `deslocamento pretendido ${dx}`);
    // O Premiere: Position = centro + horiz × largura do bruto (261104).
    assert.ok(Math.abs(fr.center.horiz * 3840 - dx) < 0.5, `horiz ${fr.center.horiz} × 3840 = ${fr.center.horiz * 3840}`);
    assert.ok(Math.abs(fr.center.vert * 2160 - dy) < 0.5, `vert ${fr.center.vert} × 2160 = ${fr.center.vert * 2160}`);
    // A unidade antiga (÷ largura da sequência) dava ~0,1225 e jogava o rosto 470 px à direita.
    assert.ok(fr.center.horiz * 3840 < 200, "nunca mais o deslocamento de ~470 px da 261104");
  });

  it("horizontal 1920x1080 a 62% no mesmo bruto: horiz × 3840 e vert × 2160 dão o deslocamento em px da sequência", () => {
    const fr = framingFor({ srcW: 3840, srcH: 2160, seqW: 1920, seqH: 1080, scalePct: 62, framing: { faceX: 0.47, eyeY: 0.54 } });
    const { dx, dy } = seqShift(fr, 3840, 2160);
    assert.ok(Math.abs(dx) > 10, "o caso tem deslocamento de verdade");
    assert.ok(Math.abs(fr.center.horiz * 3840 - dx) < 0.5);
    assert.ok(Math.abs(fr.center.vert * 2160 - dy) < 0.5);
    // A correção à mão do horizontal da 261104 foi multiplicar o valor antigo por 1920/3840.
    const old = Math.round((dx / 1920) * 10000) / 10000;
    assert.ok(Math.abs(fr.center.horiz - (old * 1920) / 3840) < 0.0002);
  });

  it("o XML leva o Center novo no Basic Motion", () => {
    const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 60, width: 3840, height: 2160, mirrored: false };
    const spec: SequenceSpec = { target: "outras-redes", name: "Vertical", width: 1080, height: 1920, order: ["comentario"], scales: [115, 130] };
    const clip: PlannedClip = { block: "comentario", srcIn: 1, srcOut: 3, frameIn: 30, frameOut: 90, seqStart: 0, seqEnd: 60, scale: 115 };
    const xml = buildXmeml([{ spec, clips: [clip], durationFrames: 60 } as SequencePlan], SOURCE, { faceX: 0.47, eyeY: 0.54 });
    const fr = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 115, framing: { faceX: 0.47, eyeY: 0.54 } });
    assert.ok(xml.includes(`<horiz>${fr.center.horiz}</horiz><vert>${fr.center.vert}</vert>`));
    assert.ok(Math.abs(fr.center.horiz - 0.0344) < 0.0002, `horiz ${fr.center.horiz}`);
  });
});

describe("#12091 título da vertical: PNG por padrão, gerador só por flag", () => {
  const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261104/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
  const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario"], scales: [115, 130] };
  const clip = (block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip => ({
    block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115,
  });
  const plan = { spec: SPEC_V, clips: [clip("titulo", 0, 105, 30), clip("comentario", 105, 300, 300)], durationFrames: 405 } as SequencePlan;
  const TITLE = "Golpe da selfie: criminosos usam IA para copiar seu rosto";
  const pngPath = titlePngXmlPath(SOURCE.path, "261104");

  it("build padrão: o título sai como clipe do PNG, sem gerador de texto nem o Color+Crop do fundo", () => {
    const mode = parseTitleModeArg(undefined);
    assert.equal(mode, "png");
    const xml = buildXmeml([plan], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { screenTitle: screenTitleXmlFor(mode, TITLE, pngPath) });
    assert.doesNotMatch(xml, /generatoritem/);
    assert.doesNotMatch(xml, /<effectid>Color<\/effectid>|<effectid>crop<\/effectid>|<effectid>Text<\/effectid>/);
    assert.doesNotMatch(xml, /&#10;/);
    const titleClip = xml.match(/<clipitem id="titulo-1">[\s\S]*?<\/clipitem>/)?.[0] ?? "";
    assert.match(titleClip, /<name>261104_titulo_vertical\.png<\/name>/);
    assert.match(titleClip, /<start>0<\/start><end>105<\/end>/);
  });

  it("com --title-mode text: o gerador sai, com a quebra de linha como CR literal e nunca `&#10;`", () => {
    const mode = parseTitleModeArg("text");
    const xml = buildXmeml([plan], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { screenTitle: screenTitleXmlFor(mode === "text" ? "text" : "png", TITLE, pngPath) });
    const gen = xml.match(/<generatoritem id="titulo-1">[\s\S]*?<\/generatoritem>/)?.[0] ?? "";
    assert.ok(gen, "gerador de texto presente com a flag");
    const str = /<parameterid>str<\/parameterid><name>Text<\/name><value>([\s\S]*?)<\/value>/.exec(gen)?.[1] ?? "";
    assert.doesNotMatch(str, /&#10;|&#13;/);
    assert.ok(str.includes("\r"), "linhas separadas por CR literal");
    assert.equal(str.split("\r").join(" "), TITLE);
  });
});
