/**
 * test/video-montagem-13241-13239-13240.test.ts — lote video-montagem:
 *  - #13241: clipe de menos de 0,3 s nunca sai sozinho no XML (funde ao
 *    vizinho contíguo no bruto, ou sai sem palavra dentro), com os casos da
 *    261116 (os tempos do bruto do plan.json daquele build);
 *  - #13239: a pausa da vinheta (`filler`) atravessa o refino com a duração
 *    pedida e conta no respiro; boxes de tela sem sobreposição; `<duration>`
 *    do PNG de tela; silêncio da pausa fora do pré-roll; troca de zoom na pausa;
 *  - #13240: o áudio do bruto abaixa sob a vinheta, no XML e na prévia.
 * Tudo sintético: nenhum áudio/vídeo real, só tempos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { absorbShortClips, SHORT_CLIP_ABSORB, speechJoinWarnings } from "../scripts/lib/diaria/video-cut-refine.ts";
import { clampTelaOverlaps, telaTrack, type TelaOverlay } from "../scripts/lib/diaria/video-tela.ts";
import {
  VINHETA_DUCK_DB,
  assembleClips,
  buildSequencePlan,
  buildXmeml,
  previewVinhetaFilter,
  titleBreathS,
  vinhetaBreathFor,
  vinhetaDuckSpan,
  vinhetaSpan,
  type RawClip,
  type ResolvedItem,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type VinhetaAsset,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { absorbShortClipsOfPlans, rawClipOf, restoreFillerEdges } from "../scripts/video-montagem.ts";

const FPS = 30;
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V13", width: 1920, height: 1080, order: ["titulo", "abertura", "comentario"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V12", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const SOURCE: SourceInfo = { path: "/m/bruto.mp4", fps: FPS, durationS: 2000, width: 3840, height: 2160, mirrored: false };
const VIN: VinhetaAsset = { path: "/m/_marca/vinheta-logo-diaria.mov", durationS: 1.3, width: 1920, height: 1080, hasAudio: false, fps: 30 };

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const raw = (srcIn: number, srcOut: number, extra: Partial<RawClip> = {}): RawClip => ({ block: "comentario", srcIn, srcOut, ...extra });
const item = (start: number, end: number, text: string, words: Word[], holdLimit: number): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit,
  how: "explicit",
});
function planOf(spec: SequenceSpec, raws: RawClip[], extra: Partial<SequencePlan> = {}): SequencePlan {
  const a = assembleClips(spec, raws, FPS);
  return { spec, clips: a.clips, durationFrames: a.durationFrames, script: "", missingBlocks: [], dropped: [], ...extra };
}

// 261116: palavras do transcript em volta do clipe de 1 quadro.
const WORDS_261116 = [w("pergunta", 917.25, 917.59), w("básica,", 917.59, 918.09), w("se", 918.31, 919.93), w("você", 919.93, 920.13)];

describe("#13241: clipe curto nunca sai sozinho no XML", () => {
  it("261116: o clipe de 1 quadro (918,17–918,185 s) sem vizinho contíguo e sem palavra dentro sai", () => {
    const raws = [raw(704.34, 709.69), raw(918.17, 918.185, { file: 2 }), raw(919.695, 923.445, { file: 2 })];
    raws[0].file = 2;
    const r = absorbShortClips(raws, WORDS_261116);
    assert.deepEqual(r.clips.map((c) => [c.srcIn, c.srcOut]), [[704.34, 709.69], [919.695, 923.445]]);
    assert.equal(r.adjustments.length, 1);
    assert.match(r.adjustments[0].reason, /descartado: sem palavra do transcript dentro/);
  });

  it("261116: o clipe de 0,245 s (1718–1718,245 s) emenda no seguinte, 0,41 s depois no bruto, com o corte de antes dele", () => {
    const raws = [raw(1704.69, 1708.45), raw(1718, 1718.245), raw(1718.655, 1722.32, { keepScale: true })];
    const r = absorbShortClips(raws, []);
    assert.deepEqual(r.clips.map((c) => [c.srcIn, c.srcOut]), [[1704.69, 1708.45], [1718, 1722.32]]);
    // O corte antes do clipe fundido é o de 1708,45 → 1718: troca o zoom (o curto não tinha keepScale).
    assert.equal(r.clips[1].keepScale, undefined);
    assert.match(r.adjustments[0].reason, /fundido ao seguinte, pausa de 0\.41 s/);
  });

  it("contíguo com o anterior (pausa curta): funde ao anterior; com os dois vizinhos, vale a pausa menor", () => {
    const r = absorbShortClips([raw(10, 12), raw(12.1, 12.2), raw(12.6, 15)], []);
    assert.deepEqual(r.clips.map((c) => [c.srcIn, c.srcOut]), [[10, 12.2], [12.6, 15]]);
    const r2 = absorbShortClips([raw(10, 12), raw(12.3, 12.4), raw(12.45, 15)], []);
    assert.deepEqual(r2.clips.map((c) => [c.srcIn, c.srcOut]), [[10, 12], [12.3, 15]]);
  });

  it("nunca funde com outro arquivo, outro encaixe, a pausa da vinheta ou um trecho que volta no bruto", () => {
    const words = [w("x", 12.1, 12.2)];
    for (const raws of [
      [raw(10, 12, { file: 0 }), raw(12.1, 12.2, { file: 1 })],
      [raw(10, 12, { fit: "fit" }), raw(12.1, 12.2)],
      [raw(10, 12, { filler: true }), raw(12.1, 12.2)],
      [raw(12.3, 14), raw(12.1, 12.2)],
    ]) {
      const r = absorbShortClips(raws, words);
      assert.equal(r.clips.length, 2, JSON.stringify(raws));
      assert.match(r.notes[0], /com palavra dentro e sem vizinho contíguo/);
    }
  });

  it("a pausa da vinheta (filler) curta nunca some", () => {
    const r = absorbShortClips([raw(10, 12), raw(50, 50.2, { filler: true }), raw(20, 22)], []);
    assert.equal(r.clips.length, 3);
  });

  it("plano final (refino ou não): o aviso de pulo de imagem some e a sequência é remontada", () => {
    const p = planOf(SPEC_H, [raw(704.34, 709.69), raw(918.17, 918.185), raw(919.695, 923.445)]);
    const islands = [{ start: 704.3, end: 709.6 }, { start: 919.7, end: 923.4 }];
    assert.ok(speechJoinWarnings(p.clips, islands, FPS).some((x) => /pulo de imagem/.test(x)), "o caso de antes avisava");
    const { plans } = absorbShortClipsOfPlans([p], WORDS_261116, FPS);
    const q = plans[0];
    assert.equal(q.clips.length, 2);
    assert.ok(!speechJoinWarnings(q.clips, islands, FPS).some((x) => /pulo de imagem/.test(x)));
    assert.equal(q.durationFrames, q.clips[q.clips.length - 1].seqEnd);
    assert.deepEqual(q.clips.map((c) => c.scale), [60, 85], "a escala alterna nos cortes que sobraram");
    assert.ok(q.cutAdjustments?.some((a) => /#13241/.test(a.reason)));
    // Plano sem clipe curto passa intacto.
    const intact = planOf(SPEC_H, [raw(1, 3), raw(5, 8)]);
    assert.equal(absorbShortClipsOfPlans([intact], [], FPS).plans[0], intact);
    assert.equal(SHORT_CLIP_ABSORB.minS, 0.3);
  });
});

describe("#13239 item 2: a pausa da vinheta atravessa o refino e conta no respiro", () => {
  it("rawClipOf guarda a marca filler; restoreFillerEdges devolve as bordas de antes do refino", () => {
    const p = planOf(SPEC_V, [{ block: "titulo", srcIn: 27.23, srcOut: 34.6 }, { block: "titulo", srcIn: 42.295, srcOut: 43.995, filler: true }, { block: "abertura", srcIn: 174.13, srcOut: 177.4 }]);
    const raws = p.clips.map(rawClipOf);
    assert.equal(raws[1].filler, true);
    // O refino (vale de energia, sibilantes) encolheu a pausa e mexeu no resto.
    const refined = raws.map((r) => ({ ...r, srcIn: r.srcIn + 0.1, srcOut: r.srcOut - 0.1 }));
    const back = restoreFillerEdges(refined, p.clips);
    assert.deepEqual([back[1].srcIn, back[1].srcOut], [42.295, 43.995]);
    assert.deepEqual([back[0].srcIn, back[2].srcOut].map((x) => Math.round(x * 1000) / 1000), [27.33, 177.3], "os outros clipes seguem refinados");
  });

  it("titleBreathS soma a pausa filler logo depois do clipe da última palavra", () => {
    const p = planOf(SPEC_V, [{ block: "titulo", srcIn: 27.23, srcOut: 34.6 }, { block: "titulo", srcIn: 42.3, srcOut: 44, filler: true }, { block: "abertura", srcIn: 174.1, srcOut: 177.4 }], { titleSpeechEndS: 34.44 });
    // 0,16 s de cauda (34,44 → 34,60) + 1,70 s de pausa.
    assert.equal(titleBreathS(p, FPS), 1.86);
    const sem = planOf(SPEC_V, [{ block: "titulo", srcIn: 27.23, srcOut: 34.6 }, { block: "abertura", srcIn: 174.1, srcOut: 177.4 }], { titleSpeechEndS: 34.44 });
    assert.equal(titleBreathS(sem, FPS), 0.16);
  });
});

describe("#13239 item 3: o silêncio da pausa sai do pré-roll e prefere o de depois da fala", () => {
  const src = { fps: FPS, durationS: 600 };
  const resolved = {
    titulo: [item(20, 23, "a vinheta", [w("a", 20, 21.5), w("vinheta", 21.6, 22.9)], 23.2)],
    abertura: [item(23.2, 30, "olá eu sou", [w("olá", 23.2, 24), w("sou", 24.1, 30)], 30)],
  };
  it("pré-roll mais perto (0–5 s) perde para o silêncio depois da fala (40–42 s)", () => {
    const p = buildSequencePlan(SPEC_V, resolved, [{ start: 0, end: 5 }, { start: 22.95, end: 23.2 }, { start: 40, end: 42 }], src, { breathAfter: vinhetaBreathFor(SPEC_V) });
    const filler = p.clips.find((c) => c.filler);
    assert.ok(filler);
    assert.equal(filler.srcIn, 40.05);
  });
  it("só o pré-roll cabe: usa ele (com aviso do trecho), em vez de deixar a vinheta sobre a fala", () => {
    const p = buildSequencePlan(SPEC_V, resolved, [{ start: 0, end: 5 }, { start: 22.95, end: 23.2 }], src, { breathAfter: vinhetaBreathFor(SPEC_V) });
    assert.equal(p.clips.find((c) => c.filler)?.srcIn, 0.05);
    assert.match(p.premises![0], /pausa completada com .* em 0\.05–.*no pré-roll/);
  });
});

describe("#13239 item 4 (registro): a pausa filler troca o zoom na entrada e na saída", () => {
  it("é corte de verdade: sem keepScale, a escala alterna e a paridade do resto muda", () => {
    const p = planOf(SPEC_V, [{ block: "titulo", srcIn: 27.23, srcOut: 34.6 }, { block: "titulo", srcIn: 42.3, srcOut: 44, filler: true }, { block: "abertura", srcIn: 174.1, srcOut: 177.4 }]);
    assert.deepEqual(p.clips.map((c) => c.scale), [115, 130, 115]);
    assert.equal(p.clips[1].keepScale, undefined);
  });
});

describe("#13239 itens 1 e 6: boxes de tela", () => {
  it("o out de um box para no in do seguinte; box sem duração sai com aviso", () => {
    const r = clampTelaOverlaps([{ id: "H6", in: 100, out: 400 }, { id: "H9", in: 300, out: 500 }, { id: "H4", in: 600, out: 700 }]);
    assert.deepEqual(r.items.map((x) => [x.id, x.in, x.out]), [["H6", 100, 300], ["H9", 300, 500], ["H4", 600, 700]]);
    assert.match(r.warnings[0], /H6 invadia H9/);
    const same = clampTelaOverlaps([{ id: "A", in: 100, out: 200 }, { id: "B", in: 100, out: 300 }]);
    assert.deepEqual(same.items.map((x) => x.id), ["B"]);
    assert.equal(clampTelaOverlaps([{ id: "A", in: 1, out: 5 }, { id: "B", in: 5, out: 9 }]).warnings.length, 0);
  });

  it("<duration> do PNG é a do clipe mais longo que o usa, não a do 1º", () => {
    const ov = (id: string, i: number, o: number): TelaOverlay => ({ id, tela: "x", path: "/l/a.png", xmlPath: "/m/a.png", width: 1920, height: 1080, in: i, out: o });
    const seen = new Set<string>();
    const xml = telaTrack({ overlays: [ov("H1", 0, 30), ov("H1", 100, 220)], rate: "<rate><timebase>30</timebase></rate>", idPrefix: "t", url: (p) => p, fileIdOf: (xp) => (seen.has(xp) ? { id: "f", defined: true } : (seen.add(xp), { id: "f", defined: false })) });
    assert.match(xml, /<pathurl>\/m\/a\.png<\/pathurl>\n<rate><timebase>30<\/timebase><\/rate><duration>120<\/duration>/);
  });
});

describe("#13240: o áudio do bruto abaixa sob a vinheta", () => {
  // vertical da 261116: título até 34,44 s, pausa completada com 42,30–44,00 s do bruto, depois a abertura.
  const p = planOf(SPEC_V, [{ block: "titulo", srcIn: 27.23, srcOut: 34.6 }, { block: "titulo", srcIn: 42.3, srcOut: 44, filler: true }, { block: "abertura", srcIn: 174.1, srcOut: 177.4 }], { titleSpeechEndS: 34.44 });

  it("o trecho abaixado é o da vinheta, cortado no fim do bloco de abertura (nunca na fala seguinte)", () => {
    const vs = vinhetaSpan(p, FPS, VIN);
    const ds = vinhetaDuckSpan(p, FPS, VIN);
    assert.ok(vs && ds);
    assert.equal(ds.start, vs.start);
    const runEnd = p.clips[1].seqEnd;
    assert.equal(ds.end, Math.min(vs.end, runEnd));
    assert.ok(ds.end <= p.clips[2].seqStart, "a abertura não abaixa");
    // Vinheta longa demais: o abaixamento para no fim da pausa.
    const longa = vinhetaDuckSpan(p, FPS, { durationS: 10 });
    assert.equal(longa?.end, runEnd);
    // Sem bloco de abertura (vinheta aos 2 s, sobre a fala): nada abaixa.
    assert.equal(vinhetaDuckSpan(planOf({ ...SPEC_V, order: ["abertura"] }, [{ block: "abertura", srcIn: 1, srcOut: 20 }]), FPS, VIN), null);
  });

  it("XML: o clipe de áudio sob a vinheta parte em pedaços, o do meio com o Audio Levels abaixado, só o 1º linkado", () => {
    const xml = buildXmeml([p], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { vinheta: VIN, audioGain: { db: 0, linear: 1, limitedBy: "target" } });
    const ds = vinhetaDuckSpan(p, FPS, VIN)!;
    const audio = xml.slice(xml.indexOf("<audio><numOutputChannels>"));
    const items = [...audio.matchAll(/<clipitem id="(a[^"]+)">[\s\S]*?<\/clipitem>/g)];
    // 3 clipes: o 1º inteiro (antes da vinheta), a pausa partida em 2 ou 3, a abertura inteira.
    const duck = items.find((m) => m[0].includes(`<start>${ds.start}</start><end>${ds.end}</end>`));
    assert.ok(duck, "há um pedaço exatamente no trecho da vinheta");
    const linear = Math.round(10 ** (VINHETA_DUCK_DB / 20) * 1e6) / 1e6;
    assert.match(duck[0], new RegExp(`<value>${linear}</value>`));
    assert.ok(!duck[0].includes("<link>"), "o pedaço abaixado não é linkado ao vídeo");
    // in/out do pedaço no bruto: deslocados do mesmo tanto que o start na sequência.
    const c = p.clips.find((x) => x.seqStart <= ds.start && x.seqEnd >= ds.end)!;
    assert.match(duck[0], new RegExp(`<in>${c.frameIn + (ds.start - c.seqStart)}</in><out>${c.frameIn + (ds.end - c.seqStart)}</out>`));
    // O clipindex do link de cada vídeo aponta para o clipe de áudio certo (a abertura vem depois dos pedaços).
    const ids = items.map((m) => m[1]);
    const lastVideo = xml.match(/<clipitem id="v3">[\s\S]*?<\/clipitem>/)![0];
    const idx = Number(lastVideo.match(/<linkclipref>a3<\/linkclipref><mediatype>audio<\/mediatype><trackindex>1<\/trackindex><clipindex>(\d+)<\/clipindex>/)![1]);
    assert.equal(ids[idx - 1], "a3");
    // A duração da faixa de áudio somada continua igual à da sequência.
    const total = items.reduce((n, m) => n + Number(m[0].match(/<end>(\d+)<\/end>/)![1]) - Number(m[0].match(/<start>(\d+)<\/start>/)![1]), 0);
    assert.equal(total, p.durationFrames);
  });

  it("XML sem vinheta: nenhum clipe de áudio partido", () => {
    const xml = buildXmeml([p], SOURCE, { faceX: 0.5, eyeY: 0.5 }, {});
    assert.ok(!/<clipitem id="a\d+-\d+">/.test(xml));
  });

  it("prévia: o mesmo trecho abaixado no ffmpeg, com e sem som na vinheta", () => {
    const duck = { startS: 9.37, endS: 10.67, db: VINHETA_DUCK_DB };
    const semSom = previewVinhetaFilter({ startS: 9.37, scale: 0.5, hasAudio: false, loudnorm: "loudnorm", duck });
    assert.match(semSom, /\[0:a\]volume=-20dB:enable='between\(t,9\.370,10\.670\)',loudnorm\[aout\]/);
    const comSom = previewVinhetaFilter({ startS: 9.37, scale: 0.5, hasAudio: true, loudnorm: "loudnorm", duck });
    assert.match(comSom, /\[0:a\]volume=-20dB:enable='between\(t,9\.370,10\.670\)'\[bru\];.*\[bru\]\[va\]amix/);
    // Sem duck, o filtro de antes.
    assert.equal(previewVinhetaFilter({ startS: 1, scale: 1, hasAudio: false, loudnorm: "L" }).endsWith("[0:a]L[aout]"), true);
  });

  it("encadeado com buildSequencePlan: o abaixamento cai na pausa do bruto, sem fala", () => {
    const src = { fps: FPS, durationS: 600 };
    const resolved = {
      titulo: [item(1, 3, "a vinheta", [w("a", 1, 1.5), w("vinheta", 1.6, 2.9)], 4.9)],
      abertura: [item(5, 7, "olá eu sou", [w("olá", 5, 5.5), w("sou", 6.1, 7)], 7)],
    };
    const q = buildSequencePlan(SPEC_V, resolved, [{ start: 2.95, end: 5 }], src, { breathAfter: vinhetaBreathFor(SPEC_V) });
    const ds = vinhetaDuckSpan(q, FPS, VIN)!;
    const firstSpeech = q.clips.find((c) => c.block === "abertura")!.seqStart;
    assert.ok(ds.end <= firstSpeech);
    assert.ok(ds.start >= Math.round((2.9 - 1) * FPS), "começa depois da última palavra do título");
  });
});

