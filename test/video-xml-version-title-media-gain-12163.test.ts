/**
 * #12163 — a versão `_V{n}` do XML (#12111/#12160) deixava de fora entradas que
 * mudam o XML: o título da vertical (do D1 em `02-reviewed.md` ou do
 * blocks.json), o caminho do bruto (`--xml-media-root`) e o ganho calculado do
 * loudness. O editor trocava o título do D1, rodava `build`, e o XML novo saía
 * com o mesmo `_V{n}` e `<sequence id>`: o Premiere reabria a sequência antiga.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSequencePlan, defaultSequences, isVerticalSpec, pickXmlVersion, type ResolvedItem, type SequenceSpec, type SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { effectiveScreenTitleOf, planHashOf, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: true };
const item = (start: number, end: number, text: string): ResolvedItem => ({ interval: { start, end }, text, words: [], lastWordEnd: null, holdLimit: end, how: "explicit" });
const vertical = defaultSequences().find((s) => isVerticalSpec(s))!;
const horizontal = defaultSequences().find((s) => !isVerticalSpec(s))!;
const VSPEC: SequenceSpec = { ...vertical, name: "Diaria comentada_Instagram_V1", order: ["comentario"] };
const HSPEC: SequenceSpec = { ...horizontal, name: "Diaria comentada_Youtube_V1", order: ["comentario"] };
const INPUTS = planHashOf('{"comentario":[]}', '{"path":"bruto.mp4"}', "[]", "{}");
const BASE: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png", mediaPath: "G:/x/bruto.mp4", gainDb: -2.5 };
const title = (text: string) => ({ mode: "png" as const, text, pngPath: "G:/x/titulo.png" });

describe("#12163 versão do XML segue título, mediaPath e ganho", () => {
  const vplan = buildSequencePlan(VSPEC, { comentario: [item(10, 20, "Um.")] }, [], SOURCE);
  const hplan = buildSequencePlan(HSPEC, { comentario: [item(10, 20, "Um.")] }, [], SOURCE);

  it("regressão: mesmo plano, título do D1 trocado → versão nova (V3, não reaproveita a V2)", () => {
    const v2 = xmlVersionHashOf(INPUTS, vplan, { ...BASE, screenTitle: title("Título antigo") });
    const v3 = xmlVersionHashOf(INPUTS, vplan, { ...BASE, screenTitle: title("Título novo") });
    assert.notEqual(v2, v3);
    assert.equal(pickXmlVersion([{ version: 2, hash: v2.slice(0, 8) }], v3), 3);
  });

  it("título do corte conta na sequência do corte", () => {
    const corte: SequenceSpec = { ...VSPEC, corte: "c2" };
    const cplan = { ...vplan, spec: corte };
    const a = xmlVersionHashOf(INPUTS, cplan, { ...BASE, screenTitle: title("Geral"), screenTitleByCorte: { c2: title("Corte A") } });
    const b = xmlVersionHashOf(INPUTS, cplan, { ...BASE, screenTitle: title("Geral"), screenTitleByCorte: { c2: title("Corte B") } });
    assert.notEqual(a, b);
  });

  it("o horizontal não leva título: trocar o título não muda a versão dele", () => {
    assert.equal(
      xmlVersionHashOf(INPUTS, hplan, { ...BASE, screenTitle: title("A") }),
      xmlVersionHashOf(INPUTS, hplan, { ...BASE, screenTitle: title("B") }),
    );
  });

  it("mediaPath e ganho calculado mudam a versão", () => {
    const h = xmlVersionHashOf(INPUTS, hplan, BASE);
    assert.notEqual(xmlVersionHashOf(INPUTS, hplan, { ...BASE, mediaPath: "D:/outro/bruto.mp4" }), h);
    assert.notEqual(xmlVersionHashOf(INPUTS, hplan, { ...BASE, gainDb: -4 }), h);
  });

  it("sem os campos novos o hash fica o de antes (compatível com quem não os passa)", () => {
    const old: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    assert.equal(xmlVersionHashOf(INPUTS, hplan, old), xmlVersionHashOf(INPUTS, hplan, { ...old, gainDb: null, screenTitle: null }));
  });

  it("effectiveScreenTitleOf segue a regra do buildXmeml (título vazio = sem título)", () => {
    assert.equal(effectiveScreenTitleOf(HSPEC, title("X"), undefined), null);
    assert.equal(effectiveScreenTitleOf(VSPEC, title("  "), undefined), null);
    assert.equal(effectiveScreenTitleOf({ ...VSPEC, corte: "c2" }, title("G"), { c2: null }), null);
    assert.equal(effectiveScreenTitleOf({ ...VSPEC, corte: "c3" }, title("G"), { c2: null })?.text, "G");
  });
});
