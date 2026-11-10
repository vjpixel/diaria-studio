/**
 * #12561 — verificação independente do XML (áudio montado só pelo XML).
 * Fixture: o XML que o próprio `buildXmeml` gera (bruto único e o de vários
 * arquivos do #12559), lido de volta como o Premiere lê.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSequencePlan, buildXmeml, reviewPreview, type ResolvedItem, type SequenceSpec, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { combineSourceFiles, sourceFiles } from "../scripts/lib/diaria/video-multi-source.ts";
import { assemblySegments, edgeFindings, longPauses, parseXmlAudio, sequenceCutsS, toTimeline, xmlStructureIssues } from "../scripts/lib/diaria/video-xml-verify.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (interval: { start: number; end: number }, text: string, words: Word[], extra: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ interval, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: interval.end + 2, how: "explicit", ...extra }) as ResolvedItem;
const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [100, 115] };
const single: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 30, width: 3840, height: 2160, mirrored: false };
const resolved = {
  titulo: [item({ start: 1, end: 3 }, "titulo", [w("titulo", 1.2, 2.6)])],
  comentario: [item({ start: 10, end: 14 }, "um dois", [w("um", 10.2, 11), w("dois", 11.1, 13.6)])],
};

describe("#12561 parseXmlAudio + toTimeline", () => {
  it("bruto único: lê timebase, os clipitem de áudio e os mesmos quadros do plano", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    const parsed = parseXmlAudio(buildXmeml([plan], single, { faceX: 0.5, eyeY: 0.5 }));
    assert.equal(parsed.timebase, 30);
    assert.equal(parsed.ntsc, false);
    assert.equal(parsed.clips.length, plan.clips.length);
    const { clips, errors } = toTimeline(parsed, sourceFiles(single).map((f) => f.offsetFrames));
    assert.deepEqual(errors, []);
    assert.deepEqual(clips.map((c) => [c.gIn, c.gOut]), plan.clips.map((c) => [c.frameIn, c.frameOut]));
    assert.deepEqual(xmlStructureIssues(parsed.clips), []);
  });

  it("vários arquivos: in/out locais do file-{k} voltam ao tempo global pelo offset", () => {
    const c = combineSourceFiles([
      { path: "A.MP4", durationS: 30, fps: 30, width: 1920, height: 1080, creationTime: "2026-11-09T10:00:00Z" },
      { path: "B.MOV", durationS: 10, fps: 30, width: 1080, height: 1920, creationTime: "2026-11-09T10:10:00Z" },
    ]);
    assert.ok(c.ok);
    const source: SourceInfo = { ...c.source, mirrored: false };
    const r = { comentario: [item({ start: 10, end: 14 }, "um", [w("um", 10.2, 13.6)]), item({ start: 31, end: 35 }, "vertical", [w("vertical", 31.2, 34.6)], { source: "B" })] };
    const plan = buildSequencePlan({ ...spec, order: ["comentario"] }, r, [], source, {});
    const parsed = parseXmlAudio(buildXmeml([plan], source, { faceX: 0.5, eyeY: 0.5 }));
    assert.deepEqual(parsed.clips.map((x) => x.fileId), ["file-1", "file-2"]);
    assert.ok(parsed.clips[1].in < 900, "in local do 2º arquivo");
    const { clips } = toTimeline(parsed, sourceFiles(source).map((f) => f.offsetFrames));
    assert.deepEqual(clips.map((x) => [x.gIn, x.gOut]), plan.clips.map((x) => [x.frameIn, x.frameOut]));
    // file-{k} inexistente = o XML aponta outro bruto
    assert.match(toTimeline(parsed, [0]).errors[0], /file-2, que não existe no bruto/);
  });

  it("faixa tratada (file-audio) já é global; NTSC lê 1000/1001; a vinheta fica fora", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    const xml = buildXmeml([plan], single, { faceX: 0.5, eyeY: 0.5 }, { audioPath: "G:/x/tratado.wav" }).replace("<ntsc>FALSE</ntsc>", "<ntsc>TRUE</ntsc>");
    const parsed = parseXmlAudio(xml);
    assert.ok(parsed.clips.every((x) => x.fileId === "file-audio"));
    assert.ok(Math.abs(parsed.rate - 29.97) < 0.01);
    assert.deepEqual(toTimeline(parsed, [500]).clips.map((x) => x.gIn), plan.clips.map((x) => x.frameIn));
  });
});

describe("#12561 estrutura e bordas", () => {
  const clip = (start: number, end: number, inn: number, out: number) => ({ start, end, in: inn, out, fileId: "file-1", gIn: inn, gOut: out });
  it("duração divergente, buraco e sobreposição são acusados", () => {
    const issues = xmlStructureIssues([clip(0, 30, 0, 31), clip(32, 60, 100, 128), clip(59, 90, 200, 231)]);
    assert.match(issues.join(" | "), /duração na sequência \(30\) ≠ na mídia \(31\)/);
    assert.match(issues.join(" | "), /buraco/);
    assert.match(issues.join(" | "), /sobreposição/);
  });
  it("borda que come fala = SOM CORTADO; XML íntegro passa; borda contígua no bruto não conta", () => {
    // fala de 3,0 a 5,0 s no bruto; o resto silêncio
    const level = (a: number, b: number) => (b > 3.0 && a < 5.0 ? -20 : -70);
    const cutting = edgeFindings([clip(0, 45, 105, 150)], 30, level, -45); // 3,5–5,0 s: entrada corta a fala
    assert.equal(cutting[0].cutIn, true);
    assert.equal(cutting[0].cutOut, false);
    const ok = edgeFindings([clip(0, 75, 80, 155)], 30, level, -45); // 2,67–5,17 s: abraça a fala
    assert.deepEqual(ok.map((e) => [e.cutIn, e.cutOut]), [[false, false]]);
    // dois clipes contíguos no bruto (fala que segue no clipe seguinte): a emenda não é corte
    const joined = edgeFindings([clip(0, 30, 80, 120), clip(30, 65, 120, 155)], 30, level, -45);
    assert.deepEqual(joined.map((e) => [e.cutIn, e.cutOut]), [[false, false], [false, false]]);
  });
  it("trechos da remontagem e cortes na sequência", () => {
    const cs = [clip(0, 30, 90, 120), clip(30, 60, 300, 330)];
    assert.deepEqual(assemblySegments(cs, 30), [{ start: 3, end: 4 }, { start: 10, end: 11 }]);
    assert.deepEqual(sequenceCutsS(cs, 30), [1]);
  });
});

describe("#12561 transcrição do áudio do XML × roteiro", () => {
  it("palavra que falta no áudio montado = fala-faltando; palavra a mais = fala-extra", () => {
    const script = "o nubank lançou hoje uma conta nova";
    const heard = ["o", "nubank", "lançou", "uma", "conta", "nova", "ahn", "tipo"].map((t, i) => w(t, i * 0.5, i * 0.5 + 0.4));
    const kinds = reviewPreview({ words: heard, script, cuts: [], durationS: 5 }).map((x) => x.kind);
    assert.ok(kinds.includes("fala-faltando"));
    assert.ok(kinds.includes("fala-extra"));
    const clean = reviewPreview({ words: script.split(" ").map((t, i) => w(t, i * 0.5, i * 0.5 + 0.4)), script, cuts: [], durationS: 5 }).filter((x) => x.kind === "fala-faltando" || x.kind === "fala-extra");
    assert.deepEqual(clean, []);
  });
});

describe("#12561 ritmo da prévia (pausas longas)", () => {
  it("acima de 0,3 s fora do fim, marcando se cai num corte", () => {
    const ps = longPauses([{ start: 0.01, end: 1 }, { start: 2, end: 2.2 }, { start: 3, end: 3.5 }, { start: 6, end: 6.6 }, { start: 9.85, end: 10 }], [6.3], 10);
    assert.deepEqual(ps, [{ at: 3, durationS: 0.5, atCut: false }, { at: 6, durationS: 0.6, atCut: true }]);
  });
});
