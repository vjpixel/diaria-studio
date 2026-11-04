/**
 * #12160 — a versão `_V{n}` do XML (#12111) vinha de um fingerprint só das
 * entradas (blocks/source/silences/transcript). `build` e depois `build
 * --no-speech-detect` sobre as mesmas entradas mudam os cortes com o mesmo
 * hash, e `pickXmlVersion` reaproveitava a versão (mesmo nome e `<sequence id>`):
 * o Premiere reabria a sequência antiga. Agora a versão sai de
 * `xmlVersionHashOf`, que cobre as opções do build e o plano final.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSequencePlan, defaultSequences, pickXmlVersion, type ResolvedItem, type SequenceSpec, type SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { planHashOf, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: true };
const item = (start: number, end: number, text: string): ResolvedItem => ({ interval: { start, end }, text, words: [], lastWordEnd: null, holdLimit: end, how: "explicit" });
const SPEC: SequenceSpec = { ...defaultSequences()[0], name: "Diaria comentada_Youtube_V1", order: ["comentario"] };
const BASE: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
// Mesmas entradas nos dois builds: o planHashOf é o mesmo.
const INPUTS = planHashOf('{"comentario":[]}', '{"path":"bruto.mp4"}', "[]", "{}");

describe("#12160 versão do XML segue as flags e o plano do build", () => {
  const planA = buildSequencePlan(SPEC, { comentario: [item(10, 20, "Um.")] }, [{ start: 14, end: 15 }], SOURCE);
  // O que o --no-speech-detect faz: as mesmas entradas, pausas diferentes, cortes diferentes.
  const planB = buildSequencePlan(SPEC, { comentario: [item(10, 20, "Um.")] }, [], SOURCE);

  it("build e depois build --no-speech-detect sobre as mesmas entradas: versão nova", () => {
    assert.notDeepEqual(planA.clips, planB.clips, "o cenário precisa de cortes diferentes");
    // Só o plano muda (mesmas flags): versão nova também.
    assert.notEqual(xmlVersionHashOf(INPUTS, planA, BASE), xmlVersionHashOf(INPUTS, planB, BASE));
    const v2 = xmlVersionHashOf(INPUTS, planA, BASE);
    const fallback = xmlVersionHashOf(INPUTS, planB, { ...BASE, speechDetect: false });
    assert.notEqual(v2, fallback);
    // Na pasta está o V2 do 1º build; o 2º build abre o V3, não reaproveita o V2.
    assert.equal(pickXmlVersion([{ version: 2, hash: v2.slice(0, 8) }], fallback), 3);
  });

  it("só a flag muda (mesmo plano): versão nova", () => {
    const h = xmlVersionHashOf(INPUTS, planA, BASE);
    for (const opts of [{ ...BASE, speechDetect: false }, { ...BASE, audioRefine: false }, { ...BASE, audioGain: false }, { ...BASE, titleMode: "text" as const }]) {
      assert.notEqual(xmlVersionHashOf(INPUTS, planA, opts), h, JSON.stringify(opts));
    }
  });

  it("build repetido igual reaproveita a versão, e o nome _V{n} não entra no fingerprint", () => {
    const h = xmlVersionHashOf(INPUTS, planA, BASE);
    const renamed = { ...planA, spec: { ...planA.spec, name: "Diaria comentada_Youtube_V2" } };
    assert.equal(xmlVersionHashOf(INPUTS, renamed, BASE), h);
    assert.equal(pickXmlVersion([{ version: 2, hash: h.slice(0, 8) }], h), 2);
  });

  it("entradas diferentes seguem mudando a versão", () => {
    const other = planHashOf('{"comentario":[1]}', '{"path":"bruto.mp4"}', "[]", "{}");
    assert.notEqual(xmlVersionHashOf(other, planA, BASE), xmlVersionHashOf(INPUTS, planA, BASE));
  });
});
