/**
 * test/video-montagem-12093-12089-12096-12111.test.ts — pedidos do editor na
 * montagem da 261104:
 *   - #12093: o gancho (1ª frase do resumo) abre o horizontal; zooms 60/85 com
 *     o rosto centrado e os olhos a 1/3; a legenda não devolve palavra que o
 *     editor tirou do roteiro;
 *   - #12089: corte de pausas pelo detector de fala (energia + 1ª diferença),
 *     com 150/120 ms de folga, estalo < 60 ms descartado e avisos de emenda;
 *   - #12096: prévia do horizontal com o mesmo recorte do XML;
 *   - #12111: XML versionado (nome e `<sequence id>` por versão).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPTIONAL_BLOCKS,
  YOUTUBE_EYE_FRACTION,
  YOUTUBE_SCALES,
  buildSequencePlan,
  buildXmeml,
  defaultSequences,
  faceCenterWarnings,
  framingFor,
  ganchoWarning,
  minCenteredScalePct,
  parseBlocksFile,
  parseSequenceIdVersion,
  pickXmlVersion,
  previewCropFor,
  previewSize,
  sequenceNameVersion,
  versionedSequenceId,
  versionedSequenceName,
  type ResolvedItem,
  type Segment,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { blocksFromDecupagem, proposeGancho, type DecupagemDoc } from "../scripts/lib/diaria/video-montage-docs.ts";
import {
  SPEECH_DETECT,
  SPEECH_DETECT_PLAN,
  frameEnergies,
  protectTranscribedWords,
  speechIslands,
  speechJoinWarnings,
  speechPauseSilences,
  type FrameEnergy,
} from "../scripts/lib/diaria/video-cut-refine.ts";

const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: true };
const FACE_261104 = { faceX: 0.47, eyeY: 0.4 };

const item = (start: number, end: number, text: string, words: Word[] = []): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit: end,
  how: "explicit",
});

describe("#12093: gancho antes do 'Olá' e zooms centrados", () => {
  const [YT, VERT] = defaultSequences();

  it("o horizontal abre no gancho, com 60/85 e olhos a 1/3; a vertical não muda", () => {
    assert.deepEqual(YT.order.slice(0, 4), ["gancho", "titulo", "abertura", "resumo"]);
    assert.deepEqual(YT.scales, [60, 85]);
    assert.deepEqual([...YOUTUBE_SCALES], [60, 85]);
    assert.equal(YT.eyeFraction, 1 / 3);
    assert.equal(YOUTUBE_EYE_FRACTION, 1 / 3);
    assert.ok(!VERT.order.includes("gancho"));
    assert.equal(VERT.eyeFraction, undefined);
    assert.deepEqual(defaultSequences("V1", "entrevista")[0].scales, [60, 85]);
  });

  it("a escala mínima que centra o rosto: faceX 0,47 num 4K → 54% (a conta da issue)", () => {
    assert.equal(minCenteredScalePct(3840, 1920, 0.47), 54);
    assert.equal(minCenteredScalePct(3840, 1920, 0.5), 50);
    assert.equal(minCenteredScalePct(3840, 1920, 0), Number.POSITIVE_INFINITY);
  });

  it("a 50% o rosto fica fora do centro e o build avisa; a 60/85 os dois zooms centram", () => {
    const at = (scales: [number, number]) =>
      faceCenterWarnings([{ spec: YT, clips: [{ scale: scales[0] }, { scale: scales[1] }] }], SOURCE, FACE_261104);
    const old = at([50, 62]);
    assert.equal(old.length, 1);
    assert.match(old[0], /\(50%\): rosto a 3,0% do centro horizontal.*menor escala que centra é 54%/);
    assert.deepEqual(at([60, 85]), []);
    for (const scalePct of [60, 85]) {
      const fr = framingFor({ srcW: 3840, srcH: 2160, seqW: 1920, seqH: 1080, scalePct, framing: FACE_261104, eyeFraction: YT.eyeFraction });
      assert.ok(Math.abs((0.47 * 3840 - fr.crop.x) / fr.crop.w - 0.5) < 0.01, `${scalePct}%: rosto centrado`);
      // Olhos na mesma altura (1/3) nos dois zooms.
      assert.ok(Math.abs((0.4 * 2160 - fr.crop.y) / fr.crop.h - 1 / 3) < 0.005, `${scalePct}%: olhos a 1/3`);
    }
  });

  it("o XML repassa o eyeFraction da sequência ao framingFor (antes ia o padrão 0,4)", () => {
    const plan = buildSequencePlan({ ...YT, order: ["comentario"] }, { comentario: [item(10, 14, "Uma frase.")] }, [], SOURCE);
    const xml = buildXmeml([plan], SOURCE, FACE_261104);
    const fr = framingFor({ srcW: 3840, srcH: 2160, seqW: 1920, seqH: 1080, scalePct: 60, framing: FACE_261104, eyeFraction: 1 / 3 });
    const wrong = framingFor({ srcW: 3840, srcH: 2160, seqW: 1920, seqH: 1080, scalePct: 60, framing: FACE_261104 });
    assert.notEqual(fr.center.vert, wrong.center.vert);
    assert.ok(xml.includes(`<vert>${fr.center.vert}</vert>`));
  });

  it("eyeFraction fora de (0,1) é erro no blocks.json", () => {
    const r = parseBlocksFile({ edition: "261104", blocks: { comentario: [{ text: "x" }] }, sequences: [{ ...YT, eyeFraction: 1.5 }] });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.errors.some((e) => e.includes("eyeFraction")));
  });

  it("decupagem: a 1ª frase do resumo vira o gancho, partida no meio da pausa entre as frases", () => {
    const words: Word[] = [
      { start: 30.0, end: 30.5, text: "Criminosos" },
      { start: 30.5, end: 31.2, text: "usam" },
      { start: 31.2, end: 32.0, text: "IA." },
      { start: 32.4, end: 32.9, text: "Eles" },
      { start: 32.9, end: 33.6, text: "pegam" },
      { start: 33.6, end: 34.2, text: "selfies." },
    ];
    const segments: Segment[] = [{ start: 29.8, end: 34.3, text: "Criminosos usam IA. Eles pegam selfies.", words }];
    const row = (key: string) => ({ start: 29.8, end: 34.3, fala: "Criminosos usam IA. Eles pegam selfies.", sugestao: "usar", bastidor: false, suggestion: "usar" as const, segments: [1] });
    const doc: DecupagemDoc = { blocks: [{ key: "abertura", rows: [] }, { key: "resumo", rows: [row("resumo")] }] };
    const { doc: out, note } = proposeGancho(doc, segments);
    assert.match(note ?? "", /gancho proposto/);
    assert.equal(out.blocks[0].key, "gancho");
    const blocks = blocksFromDecupagem(out);
    assert.deepEqual(blocks.gancho, [{ start: 29.8, end: 32.2, text: "Criminosos usam IA." }]);
    assert.deepEqual(blocks.resumo, [{ start: 32.2, end: 34.3, text: "Eles pegam selfies." }]);
    // Já com gancho: não mexe.
    assert.equal(proposeGancho(out, segments).doc, out);
  });

  it("resumo de uma frase vira gancho inteiro; sem resumo, nada", () => {
    const words: Word[] = [{ start: 1, end: 1.5, text: "Só" }, { start: 1.5, end: 2, text: "isso." }];
    const doc: DecupagemDoc = { blocks: [{ key: "resumo", rows: [{ start: 1, end: 2, fala: "Só isso.", sugestao: "usar", bastidor: false, suggestion: "usar", segments: [1] }] }] };
    const out = proposeGancho(doc, [{ start: 1, end: 2, text: "Só isso.", words }]).doc;
    assert.deepEqual(blocksFromDecupagem(out).gancho, [{ start: 1, end: 2, text: "Só isso." }]);
    assert.deepEqual(blocksFromDecupagem(out).resumo, []);
    assert.match(proposeGancho({ blocks: [] }, []).note ?? "", /sem linha "usar" no resumo/);
  });

  it("o roteiro (e por ele a legenda) segue a ordem com o gancho primeiro; gancho ausente não é falta", () => {
    const resolved = {
      gancho: [item(30, 32.2, "Criminosos usam IA.")],
      abertura: [item(5, 7, "Olá, eu sou o Pixel.")],
      resumo: [item(32.2, 34.3, "Eles pegam selfies.")],
    };
    const spec: SequenceSpec = { ...YT, order: ["gancho", "abertura", "resumo"] };
    const plan = buildSequencePlan(spec, resolved, [], SOURCE);
    assert.equal(plan.script, "Criminosos usam IA. Olá, eu sou o Pixel. Eles pegam selfies.");
    assert.equal(plan.clips[0].block, "gancho");
    assert.equal(ganchoWarning(plan), null);
    const sem = buildSequencePlan(spec, { abertura: resolved.abertura, resumo: resolved.resumo }, [], SOURCE);
    assert.ok(OPTIONAL_BLOCKS.includes("gancho"));
    assert.deepEqual(sem.missingBlocks, []);
    assert.match(ganchoWarning(sem) ?? "", /sem gancho/);
  });
});

/** Envelope sintético de 5 ms: `segs` = [início, fim, dB do sinal cheio, dB da 1ª diferença], resto no piso. */
function envelope(durationS: number, segs: Array<[number, number, number, number?]>, floorDb = -39): FrameEnergy {
  const hopS = 0.005;
  const n = Math.round(durationS / hopS);
  const fullDb = new Float64Array(n).fill(floorDb);
  const diffDb = new Float64Array(n).fill(floorDb - 15);
  for (const [a, b, full, diff] of segs) {
    for (let i = Math.round(a / hopS); i < Math.round(b / hopS); i++) {
      fullDb[i] = full;
      diffDb[i] = diff ?? full - 10;
    }
  }
  return { hopS, fullDb, diffDb };
}

describe("#12089: corte de pausas pelo detector de fala", () => {
  it("parâmetros validados pelo editor (261104, import do V3)", () => {
    assert.deepEqual(
      [SPEECH_DETECT.fullDb, SPEECH_DETECT.diffDb, SPEECH_DETECT.minGapS, SPEECH_DETECT.padBeforeS, SPEECH_DETECT.padAfterS, SPEECH_DETECT.minIslandS],
      [-33, -46, 0.32, 0.15, 0.12, 0.06],
    );
  });

  it("piso -39 dB e respiração a -36 dB antes do ataque: a entrada fica 150 ms antes da fala, não no ar", () => {
    // Respiração a 0,4 s do ataque (2,0 s), fala a -8 dB de 2,0 a 3,0 s.
    const e = envelope(5, [[1.5, 1.7, -36], [2.0, 3.0, -8]]);
    const islands = speechIslands(e);
    assert.deepEqual(islands, [{ start: 2, end: 3 }]);
    const sil = speechPauseSilences(islands, 5);
    assert.deepEqual(sil, [{ start: 0, end: 1.85 }, { start: 3.12, end: 5 }]);
    // O item nasce no start do segmento do Whisper (1,2 s, 0,8 s antes da fala): a entrada encolhe até o ataque − 150 ms.
    const plan = buildSequencePlan(
      { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] },
      { comentario: [item(1.2, 3.4, "Fala.", [{ start: 2, end: 3, text: "Fala." }])] },
      sil,
      SOURCE,
      SPEECH_DETECT_PLAN,
    );
    assert.equal(plan.clips.length, 1);
    assert.ok(Math.abs(plan.clips[0].srcIn - 1.85) <= 1 / 30, `entrada ${plan.clips[0].srcIn}`);
    assert.ok(2.0 - plan.clips[0].srcIn <= 0.15 + 1 / 30);
    assert.ok(Math.abs(plan.clips[0].srcOut - 3.12) <= 1 / 30);
  });

  it("sibilante só na banda alta conta como fala (o 's' final de 'aplicativos')", () => {
    const e = envelope(3, [[1.0, 1.4, -10], [1.4, 1.5, -37, -44]]);
    assert.deepEqual(speechIslands(e), [{ start: 1, end: 1.5 }]);
  });

  it("estalo de 10 ms isolado sai; vogal curta colada na palavra seguinte fica", () => {
    const e = envelope(6, [[1.0, 1.6, -10], [2.3, 2.31, -30], [3.0, 3.04, -26], [3.2, 3.8, -10]]);
    const islands = speechIslands(e);
    // O estalo (2,30 s) some; o "A" (40 ms a -26 dB) a 0,16 s de "empresa" junta-se a ela.
    assert.deepEqual(islands, [{ start: 1, end: 1.6 }, { start: 3, end: 3.8 }]);
  });

  it("pausa interna de 0,5 s sai; de 0,25 s fica dentro da ilha", () => {
    const islands = speechIslands(envelope(4, [[0.5, 1.0, -10], [1.25, 1.5, -10], [2.0, 2.5, -10]]));
    assert.deepEqual(islands, [{ start: 0.5, end: 1.5 }, { start: 2, end: 2.5 }]);
    assert.deepEqual(speechPauseSilences(islands, 4).map((s) => [s.start, s.end]), [[0, 0.35], [1.62, 1.85], [2.62, 4]]);
  });

  it("frameEnergies: sinal real em Int16, a 1ª diferença pega o agudo que o cheio quase não vê", () => {
    const sr = 48000;
    const samples = new Int16Array(sr); // 1 s
    // 0,2–0,4 s: grave alto (200 Hz); 0,8–0,9 s: agudo baixinho (alternância de ±100).
    for (let i = Math.round(0.2 * sr); i < Math.round(0.4 * sr); i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / sr));
    for (let i = Math.round(0.8 * sr); i < Math.round(0.9 * sr); i++) samples[i] = i % 2 ? 100 : -100;
    const e = frameEnergies(samples, sr);
    assert.equal(e.hopS, 0.005);
    assert.equal(e.fullDb.length, 200);
    const i = (t: number) => Math.round(t / 0.005);
    assert.ok(e.fullDb[i(0.3)] > -33);
    assert.ok(e.fullDb[i(0.85)] < -33, "o agudo fica abaixo do limiar no sinal cheio");
    assert.ok(e.diffDb[i(0.85)] > -46, "e acima na 1ª diferença");
    assert.deepEqual(speechIslands(e).map((r) => [r.start, r.end]), [[0.2, 0.4], [0.8, 0.9]]);
  });

  it("palavra sussurrada abaixo dos limiares não cai na pausa cortada (regressão da review da PR #12142)", () => {
    // "Fala" e "depois" viram ilha; o "e" de 2,8–3,0 s, dito baixo, não.
    const islands = [{ start: 1, end: 2 }, { start: 4, end: 5 }];
    const pauses = speechPauseSilences(islands, 6);
    const words: Word[] = [{ start: 1, end: 2, text: "Fala" }, { start: 2.8, end: 3.0, text: "e" }, { start: 4, end: 5, text: "depois." }];
    const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
    const resolved = { comentario: [item(1.0, 5.0, "Fala e depois.", words)] };
    // Sem a proteção, o build barrava: o "e" fica inteiro dentro da pausa [2,12; 3,85].
    const bare = buildSequencePlan(spec, resolved, pauses, SOURCE, SPEECH_DETECT_PLAN);
    assert.ok(bare.dropped.some((d) => /palavra\(s\) fora dos clipes: "e"/.test(d)), bare.dropped.join("\n"));
    const guard = protectTranscribedWords(pauses, words);
    assert.deepEqual(guard.protectedWords.map((w) => w.text), ["e"]);
    assert.deepEqual(guard.silences.map((s) => [s.start, s.end]), [[0, 0.85], [2.12, 2.65], [3.12, 3.85], [5.12, 6]]);
    const plan = buildSequencePlan(spec, resolved, guard.silences, SOURCE, SPEECH_DETECT_PLAN);
    assert.deepEqual(plan.dropped, []);
    assert.ok(plan.clips.some((c) => c.srcIn <= 2.8 && c.srcOut >= 3.0), "o 'e' está num clipe");
  });

  it("#12270: palavra esticada sobre pausa do detector tolera só o arredondamento de meio quadro", () => {
    const spec: SequenceSpec = { target: "youtube", name: "regressao", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] };
    const words: Word[] = [{ start: 1138.21, end: 1138.83, text: "no" }];
    const pauses = [{ start: 1138.214, end: 1139 }];
    const guard = protectTranscribedWords(pauses, words);
    assert.deepEqual(guard.protectedWords, [], "o começo audível já está fora da pausa");
    const source = { ...SOURCE, durationS: 1200 };
    const resolved = { comentario: [item(1137, 1140, "no", words)] };
    const plan = buildSequencePlan(spec, resolved, guard.silences, source, SPEECH_DETECT_PLAN);
    assert.ok(plan.clips.some((c) => c.srcOut === 1138.214 && c.frameOut / source.fps === 1138.2));
    assert.deepEqual(plan.dropped, []);
    // Uma palavra realmente fora dos clipes continua barrada, mesmo perto da borda.
    const missing = { comentario: [item(1137, 1140, "fora", [{ start: 1138.24, end: 1138.3, text: "fora" }])] };
    assert.match(buildSequencePlan(spec, missing, pauses, source, SPEECH_DETECT_PLAN).dropped.join("\n"), /palavra\(s\) fora dos clipes/);
  });

  it("protectTranscribedWords: palavra que já é fala (ou só encosta na pausa) não muda nada", () => {
    const pauses = speechPauseSilences([{ start: 1, end: 2 }], 3);
    const words: Word[] = [{ start: 1, end: 2, text: "Fala" }, { start: 1.9, end: 2.3, text: "esticada" }];
    const guard = protectTranscribedWords(pauses, words);
    assert.deepEqual(guard.protectedWords, []);
    assert.deepEqual(guard.silences, pauses);
  });

  it("avisos: emenda com pausa > 0,45 s, clipe < 0,3 s, entrada dentro da fala", () => {
    const islands = [{ start: 1, end: 2 }, { start: 5.3, end: 6 }, { start: 8, end: 8.1 }];
    const clips = [
      { block: "comentario", frameIn: 30, frameOut: 75, seqStart: 0 }, // 1,0–2,5: 0,5 s de cauda
      { block: "comentario", frameIn: 150, frameOut: 180, seqStart: 45 }, // 5,0–6,0: 0,3 s de entrada
      { block: "fecho", frameIn: 241, frameOut: 246, seqStart: 75 }, // 8,03–8,2: 0,17 s, entra dentro da fala
    ];
    const w = speechJoinWarnings(clips, islands, 30);
    assert.ok(w.some((x) => /emenda em 1\.50 s da sequência com 0\.80 s de pausa/.test(x)), w.join("\n"));
    assert.ok(w.some((x) => /clipe de 0\.17 s/.test(x)));
    assert.ok(w.some((x) => /entrada em 8\.03 s do bruto .* cai dentro da fala/.test(x)));
    assert.deepEqual(speechJoinWarnings([{ block: "x", frameIn: 25, frameOut: 66, seqStart: 0 }], [{ start: 1, end: 2 }], 30), []);
  });
});

describe("#12096: prévia do horizontal com a geometria do XML", () => {
  it("tamanho: 960x540 no horizontal, 720x1280 na vertical", () => {
    assert.deepEqual(previewSize({ width: 1920, height: 1080 }), { width: 960, height: 540 });
    assert.deepEqual(previewSize({ width: 1080, height: 1920 }), { width: 720, height: 1280 });
  });

  it("clipe a 54% e a 62%: o recorte da prévia é o do Center/Scale do XML", () => {
    const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [54, 62], eyeFraction: 1 / 3 };
    const plan = buildSequencePlan(spec, { comentario: [item(10, 12, "Um."), item(20, 22, "Dois.")] }, [], SOURCE);
    assert.deepEqual(plan.clips.map((c) => c.scale), [54, 62]);
    const xml = buildXmeml([plan], SOURCE, FACE_261104);
    const motions = [...xml.matchAll(/<value>([\d.]+)<\/value><\/parameter>\n<parameter><parameterid>center<\/parameterid><name>Center<\/name><value><horiz>(-?[\d.]+)<\/horiz><vert>(-?[\d.]+)<\/vert>/g)];
    assert.equal(motions.length, 2);
    plan.clips.forEach((c, i) => {
      const [, scale, horiz, vert] = motions[i].map(Number);
      const crop = previewCropFor(SOURCE, spec, FACE_261104, c.scale);
      const s = scale / 100;
      // Center = (centro do bruto − centro do recorte) · escala / lado do bruto (#12091).
      const cx = SOURCE.width / 2 - (horiz * SOURCE.width) / s;
      const cy = SOURCE.height / 2 - (vert * SOURCE.height) / s;
      assert.ok(Math.abs(cx - (crop.x + crop.w / 2)) <= 1.5, `clipe ${i}: x ${cx} × ${crop.x + crop.w / 2}`);
      assert.ok(Math.abs(cy - (crop.y + crop.h / 2)) <= 1.5, `clipe ${i}: y ${cy} × ${crop.y + crop.h / 2}`);
      assert.ok(Math.abs(crop.w - 1920 / s) <= 2, `clipe ${i}: largura ${crop.w}`);
    });
  });
});

describe("#12111: XML versionado", () => {
  it("nome: lê e troca a versão, inclusive no corte", () => {
    assert.equal(sequenceNameVersion("Diaria comentada_Youtube_V3"), 3);
    assert.equal(sequenceNameVersion("Diaria comentada_Vertical_V1-soberana"), 1);
    assert.equal(sequenceNameVersion("Sem versão"), null);
    assert.equal(versionedSequenceName("Diaria comentada_Youtube_V1", 4), "Diaria comentada_Youtube_V4");
    assert.equal(versionedSequenceName("Diaria comentada_Vertical_V1-ia-soberana", 2), "Diaria comentada_Vertical_V2-ia-soberana");
  });

  it("versão: pasta vazia = a do nome; mesmo plano reaproveita; plano novo (ou XML sem id versionado) abre a seguinte", () => {
    const h = "cfed5a75aaaa0000";
    assert.equal(pickXmlVersion([], h), 1);
    assert.equal(pickXmlVersion([{ version: 1, hash: null }], h), 2);
    assert.equal(pickXmlVersion([{ version: 1, hash: null }, { version: 2, hash: "cfed5a75" }], h), 2);
    assert.equal(pickXmlVersion([{ version: 2, hash: "00000000" }], h), 3);
  });

  it("o <sequence id> leva destino, versão e hash, e se lê de volta do XML", () => {
    const spec: SequenceSpec = { ...defaultSequences()[0], name: "Diaria comentada_Youtube_V3", order: ["comentario"] };
    const plan = buildSequencePlan(spec, { comentario: [item(10, 12, "Um.")] }, [], SOURCE);
    const id = versionedSequenceId("youtube", 3, "cfed5a75aaaa0000");
    assert.equal(id, "seq-youtube-v3-cfed5a75");
    const xml = buildXmeml([plan], SOURCE, FACE_261104, { sequenceIds: { youtube: id } });
    assert.match(xml, /<sequence id="seq-youtube-v3-cfed5a75"><name>Diaria comentada_Youtube_V3<\/name>/);
    assert.deepEqual(parseSequenceIdVersion(xml), { version: 3, hash: "cfed5a75" });
    assert.equal(parseSequenceIdVersion(buildXmeml([plan], SOURCE, FACE_261104)), null);
  });
});
