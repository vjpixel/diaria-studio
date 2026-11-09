/**
 * #11900 + #12559 — o mesmo trecho vertical NATIVO alimenta três saídas
 * (decisão do editor, 09/11/2026): a inserção no horizontal (blur-fill), a
 * vertical derivada (quadro cheio) e o Short avulso (corte com `source` = o
 * arquivo vertical, montado só dele, sem passar pelo horizontal).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSequencePlan, buildXmeml, clipGeometry, parseBlocksFile, sequenceKey, type ResolvedItem, type SequenceSpec, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { combineSourceFiles } from "../scripts/lib/diaria/video-multi-source.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (interval: { start: number; end: number }, text: string, words: Word[], extra: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ interval, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: interval.end + 2, how: "explicit", ...extra }) as ResolvedItem;

// Nvidia (261109): a vertical nativa (IMG_1) gravada antes do horizontal (C0002).
const c = combineSourceFiles([
  { path: "G:/YouTube/261109/IMG_1.MOV", durationS: 20, fps: 30, width: 1080, height: 1920, creationTime: "2026-11-09T13:00:00Z" },
  { path: "G:/YouTube/261109/C0002.MP4", durationS: 40, fps: 30, width: 1920, height: 1080, creationTime: "2026-11-09T13:30:00Z" },
]);
assert.ok(c.ok);
const source: SourceInfo = { ...c.source, mirrored: false };

const resolved = {
  titulo: [item({ start: 21, end: 23 }, "nvidia blackwell", [w("nvidia", 21.2, 21.8), w("blackwell", 21.9, 22.8)])],
  comentario: [
    item({ start: 25, end: 30 }, "comentario no horizontal", [w("comentario", 25.2, 26), w("no", 26.1, 26.3), w("horizontal", 26.4, 29.6)]),
    // a vertical nativa, no meio do comentário, antes do fecho/CTA
    item({ start: 2, end: 15 }, "a nvidia mostrou o chip", [w("a", 2.1, 2.2), w("nvidia", 2.3, 3), w("mostrou", 3.1, 4), w("o", 4.1, 4.2), w("chip", 4.3, 14.6)], { source: "IMG_1" }),
  ],
  cta_vertical: [item({ start: 16, end: 18 }, "segue o perfil", [w("segue", 16.2, 16.8), w("o", 16.9, 17), w("perfil", 17.1, 17.8)], { source: "IMG_1" })],
  fecho: [item({ start: 55, end: 57 }, "tchau", [w("tchau", 55.2, 56.2)])],
};

const horizontal: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario", "fecho"], scales: [100, 115] };
const vertical: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario", "fecho"], scales: [115, 130] };
const short: SequenceSpec = {
  target: "outras-redes", name: "Diaria comentada_Vertical_V1-nvidia", width: 1080, height: 1920,
  order: ["titulo", "comentario", "cta_vertical", "fecho"], scales: [100, 112], corte: "nvidia", source: "IMG_1", screenTitle: "Nvidia Blackwell",
};

describe("#11900 Short avulso do bruto vertical nativo", () => {
  it("blocks.json aceita o corte com source e o valida como vertical", () => {
    const r = parseBlocksFile({
      edition: "261109",
      blocks: { comentario: [{ text: "a nvidia mostrou o chip", source: "IMG_1" }] },
      sequences: [
        { target: "youtube", name: horizontal.name, width: 1920, height: 1080, order: ["comentario"], scales: [100, 115] },
        { target: "outras-redes", name: short.name, width: 1080, height: 1920, order: ["comentario"], scales: [100, 112], corte: "nvidia", source: "IMG_1" },
      ],
    });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  });

  it("o Short só leva os itens do arquivo vertical, na ordem do blocks.json", () => {
    const p = buildSequencePlan(short, resolved, [], source, {});
    assert.equal(sequenceKey(p.spec), "nvidia");
    assert.ok(p.clips.length > 0);
    assert.ok(p.clips.every((x) => x.file === 0), "todos do IMG_1");
    assert.deepEqual([...new Set(p.clips.map((x) => x.block))], ["comentario", "cta_vertical"]);
    // os blocos que só existem no horizontal não contam como faltando no Short (tirados pelo filtro, como targets/skip)
    assert.ok(!p.dropped.length);
  });

  it("o mesmo trecho nativo: blur-fill no horizontal, quadro cheio na vertical derivada e no Short", () => {
    const fr = { faceX: 0.5, eyeY: 0.45 };
    const geo = (spec: SequenceSpec) => {
      const p = buildSequencePlan(spec, resolved, [], source, {});
      const clip = p.clips.find((x) => x.file === 0 && x.block === "comentario")!;
      return clipGeometry({ source, spec, framing: fr, clip });
    };
    assert.equal(geo(horizontal).fit, "blur-fill");
    assert.equal(geo(vertical).fit, "fill");
    assert.equal(geo(short).fit, "fill");
    const xmlH = buildXmeml([buildSequencePlan(horizontal, resolved, [], source, {})], source, fr);
    const xmlS = buildXmeml([buildSequencePlan(short, resolved, [], source, {})], source, fr);
    assert.match(xmlH, /-fundo<\/name>/);
    assert.ok(!xmlS.includes("-fundo</name>"));
    // o Short referencia só o arquivo vertical
    assert.ok(!/<file id="file-2"><name>/.test(xmlS));
  });

  it("source da sequência que não é arquivo do bruto: erro que barra o build, nunca o Short com o horizontal misturado", () => {
    const p = buildSequencePlan({ ...short, source: "NOPE" }, resolved, [], source, {});
    assert.equal(p.clips.length, 0);
    assert.match(p.dropped.join(" "), /source "NOPE" não é arquivo do bruto/);
  });
});
