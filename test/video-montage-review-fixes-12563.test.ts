/**
 * Regressões dos achados do review da PR #12563 (#12559/#12561/#12560):
 * cada caso abaixo era um defeito real no código da 1ª versão da PR.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assembleClips,
  buildSequencePlan,
  buildXmeml,
  clipGeometry,
  hoistFileDefinitions,
  resolveBlocks,
  type BlocksFile,
  type ResolvedItem,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { clampRawsToFiles, combineSourceFiles } from "../scripts/lib/diaria/video-multi-source.ts";
import { edgeFindings, parseXmlAudio, xmlPlanIssues } from "../scripts/lib/diaria/video-xml-verify.ts";
import { audioDurationMatches, rawClipOf } from "../scripts/video-montagem.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (interval: { start: number; end: number }, text: string, words: Word[], extra: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ interval, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: interval.end + 2, how: "explicit", ...extra }) as ResolvedItem;

const c = combineSourceFiles([
  { path: "G:/x/H.MP4", durationS: 30, fps: 30, width: 1920, height: 1080, creationTime: "2026-11-09T10:00:00Z" },
  { path: "G:/x/V.MOV", durationS: 10, fps: 30, width: 1080, height: 1920, creationTime: "2026-11-09T10:10:00Z" },
]);
assert.ok(c.ok);
const multi: SourceInfo = { ...c.source, mirrored: false };
const hSpec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [100, 115] };
const resolved = { comentario: [item({ start: 10, end: 14 }, "um", [w("um", 10.2, 13.6)]), item({ start: 31, end: 35 }, "vertical", [w("vertical", 31.2, 34.6)], { source: "V", fit: "blur-fill" })] };

describe("review #12563: o refino preserva arquivo e encaixe", () => {
  it("rawClipOf leva file e fit; refeito pelo assembleClips, o clipe continua no 2º arquivo e não funde com o 1º", () => {
    const plan = buildSequencePlan(hSpec, resolved, [], multi, {});
    const raws = plan.clips.map(rawClipOf);
    assert.deepEqual(raws.map((r) => [r.file, r.fit]), [[0, undefined], [1, "blur-fill"]]);
    const again = assembleClips(hSpec, raws, 30).clips;
    assert.deepEqual(again.map((x) => x.file), [0, 1]);
  });
  it("clampRawsToFiles: o refino nunca empurra a borda para o arquivo vizinho", () => {
    const out = clampRawsToFiles([{ srcIn: 29.5, srcOut: 30.2, file: 0 }, { srcIn: 29.9, srcOut: 31, file: 1 }, { srcIn: 31, srcOut: 31.5, file: 0 }], multi);
    assert.deepEqual(out, [{ srcIn: 29.5, srcOut: 30, file: 0 }, { srcIn: 30, srcOut: 31, file: 1 }]);
    const single: SourceInfo = { path: "b.mp4", fps: 30, durationS: 10, width: 2, height: 2, mirrored: false };
    assert.deepEqual(clampRawsToFiles([{ srcIn: 1, srcOut: 2 }], single), [{ srcIn: 1, srcOut: 2 }]);
  });
});

describe("review #12563: XML define cada <file> na 1ª ocorrência", () => {
  it("a faixa do fundo (antes da principal) leva a definição; nenhuma referência curta antes dela", () => {
    const xml = buildXmeml([buildSequencePlan(hSpec, resolved, [], multi, {})], multi, { faceX: 0.5, eyeY: 0.5 });
    for (const id of ["file-1", "file-2"]) {
      const def = xml.indexOf(`<file id="${id}"><name>`);
      const ref = xml.indexOf(`<file id="${id}"/>`);
      assert.ok(def >= 0, id);
      assert.ok(ref < 0 || def < ref, `${id}: definição antes da referência`);
    }
    assert.ok(xml.indexOf('<file id="file-2"><name>') < xml.indexOf('<clipitem id="v1">'));
  });
  it("hoistFileDefinitions não mexe no XML que já define antes de referenciar", () => {
    const x = '<a><file id="f"><name>n</name></file><file id="f"/></a>';
    assert.equal(hoistFileDefinitions(x), x);
    assert.equal(hoistFileDefinitions('<a><file id="f"/><file id="f"><name>n</name></file></a>'), '<a><file id="f"><name>n</name></file><file id="f"/></a>');
  });
});

describe("review #12563: bruto único vertical em sequência horizontal segue o recorte de sempre", () => {
  it("default fill (sem fundo) no bruto único; blur-fill só com fit explícito", () => {
    const single: SourceInfo = { path: "G:/x/V.MOV", fps: 30, durationS: 10, width: 1080, height: 1920, mirrored: false };
    const r = { comentario: [item({ start: 1, end: 4 }, "um", [w("um", 1.2, 3.6)])] };
    const p = buildSequencePlan(hSpec, r, [], single, {});
    assert.equal(clipGeometry({ source: single, spec: hSpec, framing: { faceX: 0.5, eyeY: 0.5 }, clip: p.clips[0] }).fit, "fill");
    assert.ok(!buildXmeml([p], single, { faceX: 0.5, eyeY: 0.5 }).includes("-fundo</name>"));
    assert.equal(clipGeometry({ source: single, spec: { ...hSpec, fit: "blur-fill" }, framing: { faceX: 0.5, eyeY: 0.5 }, clip: p.clips[0] }).fit, "blur-fill");
  });
});

describe("review #12563: verify-xml mais estrito", () => {
  it("XML sem clipe de áudio, número de clipes diferente e in/out fora da mídia são erro", () => {
    const plan = buildSequencePlan(hSpec, resolved, [], multi, {});
    const xml = buildXmeml([plan], multi, { faceX: 0.5, eyeY: 0.5 });
    const parsed = parseXmlAudio(xml);
    assert.deepEqual(xmlPlanIssues(parsed, { clips: plan.clips.length, durationFrames: plan.durationFrames }), []);
    assert.match(xmlPlanIssues({ ...parsed, clips: [] }, { clips: 2, durationFrames: 10 })[0], /nenhum clipitem de áudio/);
    assert.match(xmlPlanIssues(parsed, { clips: 3, durationFrames: plan.durationFrames }).join(" "), /2 clipes de áudio no XML, 3 no plano/);
    // o defeito do refino: o clipe do 2º arquivo gravado no 1º com tempo global (in > duração de file-2 aqui)
    const broken = { ...parsed, clips: parsed.clips.map((x, i) => (i === 1 ? { ...x, in: x.in + 900, out: x.out + 900 } : x)) };
    assert.match(xmlPlanIssues(broken, { clips: plan.clips.length, durationFrames: plan.durationFrames }).join(" "), /fora da mídia file-2/);
  });
  it("borda na emenda entre arquivos não lê o arquivo vizinho", () => {
    // clipe que termina no fim do arquivo 1 (30 s); o 2º arquivo começa com fala (30–30,5 s)
    const level = (a: number, b: number) => (b > 30 && a < 30.5 ? -20 : -80);
    const clip = { start: 0, end: 60, in: 840, out: 900, fileId: "file-1", gIn: 840, gOut: 900 };
    assert.equal(edgeFindings([clip], 30, level, -45)[0].cutOut, true, "sem os limites: falso SOM CORTADO");
    assert.equal(edgeFindings([clip], 30, level, -45, undefined, [{ start: 0, end: 30 }, { start: 30, end: 40 }])[0].cutOut, false);
  });
});

describe("review #12563: limites do arquivo da fala", () => {
  it("holdLimit é o fim do arquivo do item, mesmo com o pre-roll caindo no arquivo anterior", () => {
    const words = [w("antes", 20, 21), w("vertical", 30.05, 30.6)];
    const file: BlocksFile = { edition: "261110", blocks: { fecho: [{ text: "vertical", source: "V" }] } };
    const r = resolveBlocks(file, words, { durationS: 40, files: [{ id: "H", start: 0, end: 30 }, { id: "V", start: 30, end: 40 }] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.blocks.fecho![0].holdLimit, 40);
  });
  it("borda coberta só por um clipe NÃO vizinho continua SOM CORTADO", () => {
    const level = (a: number, b: number) => (b > 3 && a < 5 ? -20 : -80);
    const mk = (start: number, end: number, gIn: number, gOut: number) => ({ start, end, in: gIn, out: gOut, fileId: "file-1", gIn, gOut });
    // clipe 1 corta a fala em 3,5 s; o clipe 3 (não vizinho) reusa o trecho 2,9–5 s
    const clips = [mk(0, 45, 105, 150), mk(45, 75, 300, 330), mk(75, 138, 87, 150)];
    assert.equal(edgeFindings(clips, 30, level, -45)[0].cutIn, true);
  });
});

describe("review #12563: tomada colada de dois arquivos é erro", () => {
  it("frase achada com o fim de um arquivo e o começo do outro pede source", () => {
    const words = [w("o", 29.2, 29.5), w("nubank", 29.6, 29.95), w("lancou", 30.1, 30.8)];
    const file: BlocksFile = { edition: "261110", blocks: { comentario: [{ text: "o nubank lancou" }] } };
    const r = resolveBlocks(file, words, { durationS: 40, files: [{ id: "H", start: 0, end: 30 }, { id: "V", start: 30, end: 40 }] });
    assert.match(r.errors.join(" "), /atravessa a emenda entre H e V/);
  });
});

describe("review #12563: áudio por arquivo pela metade não é reaproveitado", () => {
  it("audioDurationMatches tolera 1 quadro e recusa WAV curto", () => {
    assert.ok(audioDurationMatches(10.02, 10, 30));
    assert.ok(!audioDurationMatches(7.5, 10, 30));
    assert.ok(!audioDurationMatches(Number.NaN, 10, 30));
  });
  it("creation_time de relógio zerado ou repetido avisa", () => {
    const r = combineSourceFiles([
      { path: "a.mp4", durationS: 1, fps: 30, width: 2, height: 2, creationTime: "1970-01-01T00:00:00Z" },
      { path: "b.mp4", durationS: 1, fps: 30, width: 2, height: 2, creationTime: "2026-11-09T10:00:00Z" },
      { path: "c.mp4", durationS: 1, fps: 30, width: 2, height: 2, creationTime: "2026-11-09T10:00:00Z" },
    ]);
    assert.ok(r.ok);
    assert.match(r.warnings.join(" "), /implausível.*a\.mp4/);
    assert.match(r.warnings.join(" "), /repetido em c\.mp4/);
  });
});
