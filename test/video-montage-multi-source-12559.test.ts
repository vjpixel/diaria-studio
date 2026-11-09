/**
 * #12559 — bruto em vários arquivos (vertical e horizontal, mais de uma edição).
 *
 * Fixtures: a gravação real de 09/11/2026 em miniatura. Grupo Nubank (261110):
 * parte 1 do horizontal, depois a vertical de automação, depois o trecho final
 * do horizontal. O bloco `comentario` mistura os três arquivos, e a vertical
 * entra no meio (antes do trecho final) apesar de ter sido gravada antes dele.
 *
 * Regressão: o bruto único sai byte a byte igual ao master de antes do #12559
 * (`fixtures/video-montage-12559/single-bruto-golden.json`, gerado com o
 * código do master em 09/11/2026).
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildSequencePlan,
  buildXmeml,
  clipGeometry,
  defaultSequences,
  effectiveSource,
  fitWarnings,
  parseBlocksFile,
  parseProbe,
  previewClipArgs,
  resolveBlocks,
  type BlocksFile,
  type ResolvedItem,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import {
  combineSourceFiles,
  contentTokens,
  displaySize,
  effectiveFit,
  fileBounds,
  fileIndexAtTime,
  fitAreaWarning,
  locateTime,
  normalizeSourceFiles,
  probeExtras,
  proposeRoles,
  sortByRecording,
  sourceFiles,
} from "../scripts/lib/diaria/video-multi-source.ts";
import { concatListText, multiAudioPartArgs, nextWeekdayEdition, parseFileOrderArg, resolveSourceList, sourceIdentity } from "../scripts/video-montagem.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (interval: { start: number; end: number }, text: string, words: Word[], extra: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ interval, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: interval.end + 2, how: "explicit", ...extra }) as ResolvedItem;

// ── Regressão: bruto único idêntico ───────────────────────────────────────

describe("#12559 regressão: bruto único", () => {
  it("plano e XML das 3 sequências saem idênticos ao master de antes do #12559", () => {
    const golden = JSON.parse(readFileSync(new URL("./fixtures/video-montage-12559/single-bruto-golden.json", import.meta.url), "utf8")) as { plans: unknown[]; xml: string[] };
    const resolved = {
      titulo: [item({ start: 1, end: 3 }, "titulo aqui", [w("titulo", 1.1, 1.6), w("aqui", 1.7, 2.8)])],
      resumo: [item({ start: 4, end: 8 }, "resumo da noticia", [w("resumo", 4.1, 5), w("da", 5.1, 5.4), w("noticia", 5.5, 7.8)])],
      comentario: [
        item({ start: 10, end: 14 }, "comentario um", [w("comentario", 10.2, 11.5), w("um", 11.6, 13.8)]),
        item({ start: 15, end: 19 }, "comentario dois", [w("comentario", 15.2, 16.5), w("dois", 16.6, 18.8)], { framing: { faceX: 0.45, eyeY: 0.5 } }),
      ],
      cta_yt: [item({ start: 20, end: 22 }, "se inscreve", [w("se", 20.1, 20.4), w("inscreve", 20.5, 21.8)])],
      cta_vertical: [item({ start: 23, end: 25 }, "segue", [w("segue", 23.2, 24.8)])],
      fecho: [item({ start: 26, end: 28 }, "tchau", [w("tchau", 26.1, 27.2)])],
    };
    const silences = [{ start: 3.2, end: 3.9 }, { start: 8.1, end: 9.9 }, { start: 12.0, end: 12.3 }, { start: 14.1, end: 14.9 }, { start: 19.1, end: 19.9 }, { start: 22.1, end: 22.9 }, { start: 25.1, end: 25.9 }];
    const source: SourceInfo = { path: "G:/Meu Drive/YouTube/261109/bruto.mp4", fps: 30, durationS: 30, width: 3840, height: 2160, mirrored: true };
    const framing = { faceX: 0.48, eyeY: 0.54, mug: { left: 0.6, right: 0.7, top: 0.6, bottom: 0.8 } };
    const plans = defaultSequences("V1", "monologo").map((s) => buildSequencePlan(s, resolved, silences, source, {}));
    assert.deepEqual(JSON.parse(JSON.stringify(plans.map((p) => p.clips))), golden.plans);
    assert.deepEqual(plans.map((p) => buildXmeml([p], source, framing, { audioGain: { db: 3, linear: 1.412538, limitedBy: "target" } })), golden.xml);
  });

  it("sourceFiles do bruto único é um arquivo só, sem files no source", () => {
    const s: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false };
    assert.deepEqual(sourceFiles(s), [{ id: "bruto", path: "G:/x/bruto.mp4", offsetFrames: 0, frames: 300, width: 1920, height: 1080, mirrored: false }]);
    assert.equal(sourceIdentity(s), "G:/x/bruto.mp4");
  });
});

// ── Linha do tempo ────────────────────────────────────────────────────────

const H = { fps: 30, width: 1920, height: 1080 };
const V = { fps: 30, width: 1080, height: 1920 };
const nubank = [
  { path: "G:/YouTube/261109/C0003.MP4", durationS: 20, creationTime: "2026-11-09T14:20:00.000Z", ...H }, // trecho final
  { path: "G:/YouTube/261109/C0001.MP4", durationS: 30, creationTime: "2026-11-09T14:00:00.000Z", ...H }, // parte 1
  { path: "G:/YouTube/261109/IMG_0002.MOV", durationS: 10, creationTime: "2026-11-09T14:10:00.000Z", ...V }, // vertical automação
];

describe("#12559 combineSourceFiles", () => {
  it("ordena por creation_time (gravação), não pelo nome, e acumula offsets", () => {
    const c = combineSourceFiles(nubank);
    assert.ok(c.ok);
    assert.deepEqual(c.source.files.map((f) => [f.id, f.offsetFrames, f.frames, f.width]), [["C0001", 0, 900, 1920], ["IMG_0002", 900, 300, 1080], ["C0003", 1200, 600, 1920]]);
    assert.equal(c.source.durationS, 60);
    assert.match(c.warnings.join(" "), /tamanhos diferentes/);
  });

  it("--ordem dada mantém a lista; fps diferente é erro", () => {
    const c = combineSourceFiles(nubank, { order: "dada" });
    assert.ok(c.ok);
    assert.deepEqual(c.source.files.map((f) => f.id), ["C0003", "C0001", "IMG_0002"]);
    const bad = combineSourceFiles([nubank[0], { ...nubank[1], fps: 25 }]);
    assert.ok(!bad.ok);
    assert.match(bad.errors[0], /25 fps/);
  });

  it("sem creation_time vai para o fim, pelo nome; id repetido ganha sufixo", () => {
    const s = sortByRecording([{ path: "b.mp4" }, { path: "a.mp4" }, { path: "z.mp4", creationTime: "2026-01-01T00:00:00Z" }]);
    assert.deepEqual(s.map((x) => x.path), ["z.mp4", "a.mp4", "b.mp4"]);
    const c = combineSourceFiles([{ path: "x/A.mp4", durationS: 1, ...H }, { path: "y/A.mp4", durationS: 1, ...H }]);
    assert.ok(c.ok);
    assert.deepEqual(c.source.files.map((f) => f.id), ["A", "A-2"]);
    assert.match(c.warnings.join(" "), /sem creation_time/);
  });

  it("locateTime/fileIndexAtTime/fileBounds levam o tempo global ao arquivo", () => {
    const c = combineSourceFiles(nubank);
    assert.ok(c.ok);
    assert.equal(fileIndexAtTime(c.source, 29.99), 0);
    assert.equal(fileIndexAtTime(c.source, 30), 1);
    const loc = locateTime(c.source, 45);
    assert.equal(loc.file.id, "C0003");
    assert.equal(loc.localS, 5);
    assert.deepEqual(fileBounds(c.source), [{ start: 0, end: 30 }, { start: 30, end: 40 }, { start: 40, end: 60 }]);
  });
});

describe("#12559 source.json lido do disco (review da PR #12563)", () => {
  it("normalizeSourceFiles aceita o que combineSourceFiles grava e recusa ids repetidos, offsets fora de ordem e soma divergente", () => {
    const c = combineSourceFiles(nubank);
    assert.ok(c.ok);
    assert.deepEqual(normalizeSourceFiles(c.source).errors, []);
    const files = c.source.files;
    const dup = normalizeSourceFiles({ ...c.source, files: [files[0], { ...files[1], id: files[0].id }, files[2]] });
    assert.match(dup.errors.join(" "), /repetido/);
    const gap = normalizeSourceFiles({ ...c.source, files: [files[0], { ...files[1], offsetFrames: 950 }, files[2]] });
    assert.match(gap.errors.join(" "), /esperado 900/);
    const dur = normalizeSourceFiles({ ...c.source, durationS: 70 });
    assert.match(dur.errors.join(" "), /diverge de durationS/);
  });
  it("files com um arquivo só vira bruto único (uma definição de vários arquivos)", () => {
    const one = normalizeSourceFiles({ path: "a.mp4", fps: 30, durationS: 1, width: 2, height: 2, files: [{ id: "a", path: "a.mp4", offsetFrames: 0, frames: 30, width: 2, height: 2 }] });
    assert.deepEqual(one.errors, []);
    assert.equal(one.source.files, undefined);
  });
  it("clipGeometry recusa índice de arquivo fora do bruto (plan.json de outro source.json)", () => {
    const c = combineSourceFiles(nubank);
    assert.ok(c.ok);
    assert.throws(() => clipGeometry({ source: { ...c.source, mirrored: false }, spec: { width: 1920, height: 1080 }, framing: { faceX: 0.5, eyeY: 0.5 }, clip: { scale: 100, file: 3 } }), /aponta o arquivo 3, mas o bruto tem 3/);
  });
});

describe("#12559 probe: rotação e creation_time", () => {
  it("celular em pé (rotação 90) vira o tamanho exibido 1080x1920", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1", side_data_list: [{ rotation: -90 }] }],
      format: { duration: "10.0", tags: { creation_time: "2026-11-09T14:10:00.000000Z" } },
    });
    const s = parseProbe(json, "G:/x/IMG.MOV");
    assert.equal(s.width, 1080);
    assert.equal(s.height, 1920);
    assert.deepEqual(probeExtras(json), { creationTime: "2026-11-09T14:10:00.000Z", rotation: 270 });
    assert.deepEqual(displaySize(1920, 1080, 0), { width: 1920, height: 1080 });
  });
});

// ── Encaixe ───────────────────────────────────────────────────────────────

describe("#12559 encaixe fit/fill/blur-fill", () => {
  const hSpec = { width: 1920, height: 1080 };
  const vSpec = { width: 1080, height: 1920 };
  it("default: vertical em horizontal = blur-fill; resto = fill; item > sequência", () => {
    assert.deepEqual(effectiveFit(V, hSpec), { fit: "blur-fill", how: "default" });
    assert.deepEqual(effectiveFit(V, vSpec), { fit: "fill", how: "default" });
    assert.deepEqual(effectiveFit(H, vSpec), { fit: "fill", how: "default" });
    assert.deepEqual(effectiveFit(V, { ...hSpec, fit: "fit" }), { fit: "fit", how: "sequencia" });
    assert.deepEqual(effectiveFit(V, { ...hSpec, fit: "fit" }, { fit: "fill" }), { fit: "fill", how: "item" });
  });
  it("aviso de área: 1080x1920 num 1920x1080 ocupa 608x1080", () => {
    const msg = fitAreaWarning({ id: "IMG", ...V }, { name: "H", ...hSpec }, "blur-fill");
    assert.match(msg ?? "", /608x1080/);
    assert.match(msg ?? "", /32% da área/);
    assert.equal(fitAreaWarning({ id: "IMG", ...V }, { name: "H", ...hSpec }, "fill"), null);
  });
  it("prévia: fit com pad, blur-fill com boxblur + overlay, áudio em tempo global", () => {
    const args = previewClipArgs({ src: "v.mov", start: 2, end: 4, crop: { x: 0, y: 0, w: 1080, h: 1920 }, mirrored: true, fps: 30, out: "c.mp4", width: 960, height: 540, audioSrc: "a.wav", audioStart: 32, fit: "blur-fill" });
    const vf = args[args.indexOf("-vf") + 1];
    assert.match(vf, /^hflip,split=2/);
    assert.match(vf, /boxblur/);
    assert.match(vf, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
    // vídeo local 2–4 s; áudio global 32–34 s
    assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4), ["-ss", "2.000", "-to", "4.000"]);
    assert.deepEqual(args.slice(args.lastIndexOf("-ss"), args.lastIndexOf("-ss") + 4), ["-ss", "32.000", "-to", "34.000"]);
    const fit = previewClipArgs({ src: "v.mov", start: 0, end: 1, crop: { x: 0, y: 0, w: 2, h: 2 }, mirrored: false, fps: 30, out: "c.mp4", fit: "fit" });
    assert.match(fit[fit.indexOf("-vf") + 1], /pad=720:1280/);
  });
});

// ── blocks.json ───────────────────────────────────────────────────────────

describe("#12559 blocks.json: source, fit e files", () => {
  const base = { edition: "261110", blocks: { titulo: [{ text: "oi" }] } };
  it("aceita source/fit em item e sequência e files por arquivo", () => {
    const r = parseBlocksFile({
      ...base,
      blocks: { comentario: [{ text: "a", source: "IMG_0002", fit: "blur-fill" }] },
      files: { IMG_0002: { mirrored: false, framing: { faceX: 0.5, eyeY: 0.35 } } },
      sequences: [{ target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [50, 62], fit: "fill" }],
    });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  });
  it("recusa fit desconhecido, source vazio e campo estranho em files", () => {
    const r = parseBlocksFile({ ...base, blocks: { titulo: [{ text: "oi", fit: "stretch", source: "" }] }, files: { X: { zoom: 2 } } });
    assert.ok(!r.ok);
    const all = r.ok ? "" : r.errors.join(" | ");
    assert.match(all, /fit precisa ser fill, fit ou blur-fill/);
    assert.match(all, /source precisa ser o id/);
    assert.match(all, /files\.X: campo\(s\) desconhecido\(s\) zoom/);
  });
  it("effectiveSource: espelho por arquivo (files.{id} > geral > medido) e id inexistente é erro", () => {
    const c = combineSourceFiles(nubank.map((f) => ({ ...f, mirrored: true })));
    assert.ok(c.ok);
    const measured: SourceInfo = { ...c.source, mirrored: true };
    const { source, errors } = effectiveSource(measured, { mirrored: false, files: { IMG_0002: { mirrored: true }, NOPE: {} } });
    assert.deepEqual(source.files?.map((f) => [f.id, f.mirrored]), [["C0001", false], ["IMG_0002", true], ["C0003", false]]);
    assert.match(errors.join(" "), /files\.NOPE: arquivo inexistente/);
    const single = effectiveSource({ path: "b.mp4", fps: 30, durationS: 1, width: 2, height: 2, mirrored: true }, { files: { b: {} } });
    assert.match(single.errors.join(" "), /bruto é um arquivo só/);
  });
});

// ── Plano e XML com vários arquivos ───────────────────────────────────────

function nubankSource(): SourceInfo {
  const c = combineSourceFiles(nubank);
  assert.ok(c.ok);
  return { ...c.source, mirrored: false };
}

/** Comentário do Nubank: parte 1 (C0001), a vertical de automação no meio (IMG_0002), o fecho do comentário (C0003). */
function nubankResolved() {
  return {
    titulo: [item({ start: 1, end: 3 }, "nubank", [w("nubank", 1.2, 2.6)])],
    comentario: [
      item({ start: 10, end: 14 }, "parte um", [w("parte", 10.2, 11), w("um", 11.1, 13.6)]),
      // a vertical gravada ANTES do trecho final entra antes dele (ordem da edição = ordem dos itens)
      item({ start: 31, end: 36 }, "automacao", [w("automacao", 31.2, 35.6)], { source: "IMG_0002" }),
      item({ start: 41, end: 44 }, "fecho do comentario", [w("fecho", 41.2, 42), w("do", 42.1, 42.3), w("comentario", 42.4, 43.6)]),
    ],
    fecho: [item({ start: 50, end: 52 }, "tchau", [w("tchau", 50.2, 51.2)])],
  };
}

const hSeq: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario", "fecho"], scales: [100, 115] };
const vSeq: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario", "fecho"], scales: [115, 130] };

describe("#12559 plano com vários arquivos", () => {
  it("cada clipe leva o arquivo dele; a ordem da edição é a dos itens, não a de gravação", () => {
    const p = buildSequencePlan(hSeq, nubankResolved(), [], nubankSource(), {});
    assert.deepEqual(p.clips.map((c) => [c.block, c.file]), [["titulo", 0], ["comentario", 0], ["comentario", 1], ["comentario", 2], ["fecho", 2]]);
    for (const c of p.clips) {
      const b = fileBounds(nubankSource())[c.file ?? 0];
      assert.ok(c.srcIn >= b.start - 1e-9 && c.srcOut <= b.end + 1e-9, `${c.block} dentro de ${c.file}`);
    }
  });

  it("item que atravessa a emenda fica só com a parte do seu arquivo, com aviso", () => {
    const r = nubankResolved();
    r.comentario[0] = item({ start: 25, end: 33 }, "atravessa", [w("atravessa", 25.2, 29.5)]);
    const p = buildSequencePlan(hSeq, r, [], nubankSource(), {});
    const c = p.clips.find((x) => x.block === "comentario")!;
    assert.equal(c.file, 0);
    assert.ok(c.srcOut <= 30 + 1e-9);
    assert.match((p.warnings ?? []).join(" "), /atravessa a emenda entre arquivos/);
  });

  it("dois trechos contíguos em arquivos diferentes nunca se fundem", () => {
    const r = {
      comentario: [item({ start: 28, end: 30 }, "a", [w("a", 28.1, 29.9)]), item({ start: 30, end: 32 }, "b", [w("b", 30.1, 31.9)])],
    };
    const p = buildSequencePlan({ ...hSeq, order: ["comentario"] }, r, [], nubankSource(), {});
    assert.equal(p.clips.length, 2);
    assert.deepEqual(p.clips.map((c) => c.file), [0, 1]);
  });

  it("XML: um <file> por arquivo, in/out locais, tamanho de cada arquivo e fundo desfocado só na vertical em horizontal", () => {
    const source = nubankSource();
    const p = buildSequencePlan(hSeq, nubankResolved(), [], source, {});
    const xml = buildXmeml([p], source, { faceX: 0.5, eyeY: 0.45 }, { mediaPaths: ["N:/C0001.MP4", "N:/IMG_0002.MOV", "N:/C0003.MP4"] });
    assert.equal((xml.match(/<file id="file-\d+"><name>/g) ?? []).length, 3);
    assert.match(xml, /<file id="file-2"><name>IMG_0002\.MOV<\/name><pathurl>file:\/\/localhost\/N:\/IMG_0002\.MOV<\/pathurl>\n<rate><timebase>30<\/timebase><ntsc>FALSE<\/ntsc><\/rate><duration>300<\/duration>\n<media><video><samplecharacteristics><width>1080<\/width><height>1920<\/height>/);
    // o clipe da vertical: in/out locais (31 s global = 1 s no arquivo 2)
    const vert = p.clips.find((c) => c.file === 1)!;
    assert.match(xml, new RegExp(`<in>${vert.frameIn - 900}</in><out>${vert.frameOut - 900}</out>`));
    // blur-fill: faixa de baixo com Gaussian Blur e escala de cobrir; principal com escala de caber
    assert.equal((xml.match(/-fundo<\/name>/g) ?? []).length, 1);
    assert.match(xml, /<effectid>Gaussian Blur<\/effectid>/);
    assert.match(xml, /<value>177\.7778<\/value>/); // cobrir: 1920/1080
    assert.match(xml, /<value>56\.25<\/value>/); // caber: 1080/1920
    // a faixa de fundo vem ANTES (V1) da principal
    assert.ok(xml.indexOf("-fundo</name>") < xml.indexOf('<clipitem id="v1">'));
  });

  it("XML com faixa tratada: áudio em quadros GLOBAIS no file-audio, vídeo em quadros locais", () => {
    const source = nubankSource();
    const p = buildSequencePlan(hSeq, nubankResolved(), [], source, {});
    const xml = buildXmeml([p], source, { faceX: 0.5, eyeY: 0.45 }, { audioPath: "N:/tratado.wav" });
    const last = p.clips[p.clips.length - 1];
    const audioPart = xml.slice(xml.indexOf("<audio><numOutputChannels>"));
    assert.match(audioPart, new RegExp(`<in>${last.frameIn}</in><out>${last.frameOut}</out>\\n<file id="file-audio"/>`));
    assert.match(xml.slice(0, xml.indexOf("<audio><numOutputChannels>")), new RegExp(`<in>${last.frameIn - 1200}</in><out>${last.frameOut - 1200}</out>`));
  });

  it("vertical derivada: o trecho nativo vertical entra em fill (quadro cheio), sem fundo", () => {
    const source = nubankSource();
    const p = buildSequencePlan(vSeq, nubankResolved(), [], source, {});
    const g = clipGeometry({ source, spec: vSeq, framing: { faceX: 0.5, eyeY: 0.45 }, clip: p.clips.find((c) => c.file === 1)! });
    assert.equal(g.fit, "fill");
    assert.equal(g.background, undefined);
    assert.equal(g.file.width, 1080);
    const xml = buildXmeml([p], source, { faceX: 0.5, eyeY: 0.45 });
    assert.ok(!xml.includes("-fundo</name>"));
  });

  it("files.{id}.framing vale para os clipes daquele arquivo; o do item sobrepõe", () => {
    const source = nubankSource();
    const fo = { IMG_0002: { framing: { faceX: 0.3, eyeY: 0.3 } } };
    const g1 = clipGeometry({ source, spec: vSeq, framing: { faceX: 0.5, eyeY: 0.45 }, fileOverrides: fo, clip: { scale: 130, file: 1 } });
    const g2 = clipGeometry({ source, spec: vSeq, framing: { faceX: 0.5, eyeY: 0.45 }, fileOverrides: fo, clip: { scale: 130, file: 1, framing: { faceX: 0.7, eyeY: 0.3 } } });
    assert.notDeepEqual(g1.main.crop, g2.main.crop);
    assert.ok((g1.main.crop?.x ?? 0) < (g2.main.crop?.x ?? 0));
  });

  it("fitWarnings: um aviso de área por sequência e arquivo em blur-fill", () => {
    const source = nubankSource();
    const p = buildSequencePlan(hSeq, nubankResolved(), [], source, {});
    const ws = fitWarnings([p], source, {});
    assert.equal(ws.length, 1);
    assert.match(ws[0], /IMG_0002.*blur-fill/);
  });
});

describe("#12559 resolveBlocks com source", () => {
  const words = [w("automacao", 5, 6), w("x", 7, 8), w("automacao", 33, 34), w("y", 35, 36)];
  const files = [{ id: "C0001", start: 0, end: 30 }, { id: "IMG_0002", start: 30, end: 40 }];
  const file = (it: object): BlocksFile => ({ edition: "261110", blocks: { comentario: [it as never] } });
  it("procura a tomada só no arquivo do item (a última tomada global seria a errada sem isso)", () => {
    const r1 = resolveBlocks(file({ text: "automacao", source: "C0001" }), words, { durationS: 40, files });
    assert.deepEqual(r1.errors, []);
    assert.ok(r1.blocks.comentario![0].interval.end <= 30);
    const r2 = resolveBlocks(file({ text: "automacao", source: "IMG_0002" }), words, { durationS: 40, files });
    assert.ok(r2.blocks.comentario![0].interval.start >= 30);
  });
  it("source inexistente, source com bruto único e intervalo fora do arquivo são erro", () => {
    assert.match(resolveBlocks(file({ text: "automacao", source: "NOPE" }), words, { durationS: 40, files }).errors[0], /não é arquivo do bruto/);
    assert.match(resolveBlocks(file({ text: "automacao", source: "C0001" }), words, { durationS: 40 }).errors[0], /só vale com bruto em vários arquivos/);
    assert.match(resolveBlocks(file({ start: 25, end: 35, source: "C0001" }), words, { durationS: 40, files }).errors[0], /fora do arquivo C0001/);
  });
});

// ── Inventário: papel de cada arquivo ─────────────────────────────────────

describe("#12559 inventário propõe papel e edição", () => {
  const f = (name: string, t: string, dims: { width: number; height: number }, heard?: string) => ({ name, path: `G:/YouTube/261109/${name}`, durationS: 10, fps: 30, creationTime: t, ...dims, ...(heard ? { heard } : {}) });
  it("Nubank: horizontal em 2 partes com a vertical gravada entre elas; Nvidia: vertical antes do horizontal", () => {
    const rows = proposeRoles(
      [
        f("C0010.MP4", "2026-11-09T15:00:00Z", H, "o nubank anunciou hoje uma conta com assistente de inteligencia"),
        f("IMG_1.MOV", "2026-11-09T13:00:00Z", V, "a nvidia mostrou o chip blackwell para datacenters"),
        f("C0002.MP4", "2026-11-09T13:30:00Z", H, "a nvidia apresentou o blackwell e os datacenters"),
        f("IMG_2.MOV", "2026-11-09T15:10:00Z", V, "automação no nubank com assistente"),
        f("C0011.MP4", "2026-11-09T15:20:00Z", H, "fechando o nubank e o assistente"),
      ],
      { "261109": "Nvidia apresenta Blackwell para datacenters", "261110": "Nubank lança conta com assistente de inteligência" },
      { minScore: 2 },
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.deepEqual(rows.map((r) => r.name), ["IMG_1.MOV", "C0002.MP4", "C0010.MP4", "IMG_2.MOV", "C0011.MP4"]);
    assert.equal(by["IMG_1.MOV"].role, "vertical-nativa");
    assert.equal(by["IMG_1.MOV"].edition, "261109");
    assert.match(by["IMG_1.MOV"].insertion ?? "", /antes do fecho/);
    assert.equal(by["C0002.MP4"].part, undefined);
    assert.deepEqual([by["C0010.MP4"].part, by["C0011.MP4"].part], [1, 2]);
    assert.equal(by["IMG_2.MOV"].edition, "261110");
    assert.match(by["IMG_2.MOV"].insertion ?? "", /entre a parte 1 e a parte 2/);
    assert.match(by["IMG_2.MOV"].note ?? "", /Short avulso/);
  });
  it("sem fala, só papel pela orientação; tokens ignoram acento e palavras vazias", () => {
    const rows = proposeRoles([f("A.MP4", "2026-11-09T10:00:00Z", H)], { "261109": "x" });
    assert.equal(rows[0].role, "mestre-horizontal");
    assert.equal(rows[0].edition, undefined);
    assert.ok(contentTokens("Inteligência e automação para todos").has("inteligencia"));
    assert.ok(!contentTokens("para que isso").has("para"));
  });
});

// ── CLI puro ──────────────────────────────────────────────────────────────

describe("#12559 CLI: lista de arquivos e áudio por arquivo", () => {
  it("resolveSourceList: caminho direto ou nome na pasta da edição; ausente é erro", () => {
    const exists = (p: string) => /G:[\\/]YouTube[\\/]261109[\\/]C0001\.MP4$/.test(p);
    assert.deepEqual(resolveSourceList(["C0001.MP4"], "G:/YouTube/261109", exists), ["G:/YouTube/261109/C0001.MP4"]);
    assert.throws(() => resolveSourceList(["X.MP4"], "G:/YouTube/261109", exists), /não encontrado: X\.MP4/);
  });
  it("áudio de cada arquivo com a duração exata (apad + -t) e lista do concat escapada", () => {
    const a = multiAudioPartArgs({ src: "v.mov", frames: 300, fps: 30, out: "p.wav" });
    assert.deepEqual(a.slice(a.indexOf("-af"), a.indexOf("-af") + 4), ["-af", "apad", "-t", "10.000000"]);
    assert.equal(concatListText(["C:\\a\\it's.wav"]), "file 'C:/a/it'\\''s.wav'\n");
  });
  it("--ordem e a edição do dia útil seguinte", () => {
    assert.equal(parseFileOrderArg(undefined), undefined);
    assert.equal(parseFileOrderArg("dada"), "dada");
    assert.throws(() => parseFileOrderArg("nome"), /gravacao ou dada/);
    assert.equal(nextWeekdayEdition("261106"), "261109"); // sexta → segunda
    assert.equal(nextWeekdayEdition("261109"), "261110");
  });
});
