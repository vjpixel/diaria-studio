/**
 * test/video-montage-title-mode-text-removed-12104.test.ts — decisão do editor
 * (04/11): o `--title-mode text` (gerador "Text" do FCP7 sobre o fundo
 * Color+Crop, nunca validado num import) sai do `build`.
 *   1. pedir `--title-mode text` é erro explícito, nunca cai em silêncio no PNG;
 *   2. o padrão PNG não muda: mesmo XML e mesma versão (`_V{n}`) de antes da
 *      remoção (valores fixados com o código anterior ao #12104).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SCREEN_TITLE_STYLE, buildXmeml, screenTitleLayout, type PlannedClip, type SequencePlan, type SequenceSpec, type SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { parseTitleModeArg, screenTitleXmlFor, xmlVersionHashOf } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/x/261104/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [50, 62] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario"], scales: [115, 130] };
const clip = (block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip => ({
  block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115,
});
const CLIPS = [clip("titulo", 0, 105, 30), clip("comentario", 105, 300, 300)];
const PLANS = [{ spec: SPEC_H, clips: CLIPS, durationFrames: 405 }, { spec: SPEC_V, clips: CLIPS, durationFrames: 405 }] as SequencePlan[];
const TITLE = "Golpe da selfie: criminosos usam IA para copiar seu rosto";
const PNG = "G:/x/261104/261104_titulo_vertical.png";
/** sha256 (16 hex) do XML deste caso, gerado com o código anterior ao #12104. */
const PNG_XML_SHA16 = "1be5c5beec620201";

describe("#12104 --title-mode text removido", () => {
  it("--title-mode text é erro com a causa e as opções que sobraram", () => {
    assert.throws(() => parseTitleModeArg("text"), (e: unknown) => {
      const m = e instanceof Error ? e.message : "";
      return /--title-mode text foi removido \(#12104\)/.test(m) && /png/.test(m) && /off/.test(m);
    });
  });

  it("o que sobra: png (padrão), off; valor desconhecido segue erro", () => {
    assert.equal(parseTitleModeArg(undefined), "png");
    assert.equal(parseTitleModeArg("png"), "png");
    assert.equal(parseTitleModeArg("off"), "off");
    assert.throws(() => parseTitleModeArg("TEXT"), /precisa ser png ou off/);
    assert.throws(() => parseTitleModeArg(""), /title-mode/);
  });

  it("o padrão PNG sai como antes: nenhum gerador, Color, Crop ou Text no XML", () => {
    const xml = buildXmeml(PLANS, SOURCE, { faceX: 0.5, eyeY: 0.5 }, { screenTitle: screenTitleXmlFor(TITLE, PNG) });
    assert.doesNotMatch(xml, /generatoritem|titulo-fundo|<effectid>(?:Color|crop|Text)<\/effectid>/);
    assert.match(xml, /<clipitem id="titulo-2"><name>titulo-tela<\/name>/);
    // Fixado com o código anterior ao #12104 (mesmo SOURCE/PLANS/título): o XML do PNG não mudou nem um byte.
    assert.equal(xml.length, 7837);
    assert.equal(createHash("sha256").update(xml).digest("hex").slice(0, 16), PNG_XML_SHA16);
  });

  it("a versão do XML (_V{n}) do PNG e do off não muda com a remoção", () => {
    const base = { speechDetect: true, audioRefine: true, audioGain: true } as const;
    assert.equal(xmlVersionHashOf("abc", PLANS[1], { ...base, titleMode: "png", screenTitle: screenTitleXmlFor(TITLE, PNG) }), "9003f1038c4e45cb");
    assert.equal(xmlVersionHashOf("abc", PLANS[1], { ...base, titleMode: "off" }), "0dc82e2b85ed995b");
  });

  it("as constantes só do gerador saíram do estilo e do layout", () => {
    assert.equal("xmlSizeRefWidth" in SCREEN_TITLE_STYLE, false);
    assert.equal("xmlLineBreak" in SCREEN_TITLE_STYLE, false);
    assert.equal("xmlFontSize" in screenTitleLayout(TITLE, 1080, 1920), false);
  });
});
