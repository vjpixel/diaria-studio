/**
 * test/video-montage-entrevista-11507.test.ts (#11507) — vídeo gravado como
 * entrevista (261029): a Bruna pergunta, o Pixel responde, sem título nem
 * resumo gravados. Dois ajustes manuais que a montagem passa a fazer:
 *   1. voz provável de cada segmento pela F0 mediana (Pixel ~160–167 Hz,
 *      Bruna ~205–232 Hz; o trecho 5:49–5:56 que parecia do Pixel era ~205 Hz);
 *   2. formato `entrevista`, com as sequências sem título/resumo (antes o
 *      `build` acusava bloco faltando e as `sequences` saíram à mão).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVoices, frameF0, medianF0, segmentF0s, voiceHint, VOICE } from "../scripts/lib/diaria/video-voice.ts";
import { segmentListing, decupagemPlanTemplate } from "../scripts/lib/diaria/video-montage-docs.ts";
import {
  buildSequencePlan,
  defaultSequences,
  effectiveFormat,
  parseBlocksFile,
  resolveBlocks,
  type BlocksFile,
  type Segment,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { parsePixelF0Arg } from "../scripts/video-montagem.ts";

const SR = 16000;

/** Voz sintética: F0 com 5 harmônicos decrescentes e um vibrato leve (±1%). */
function voice(f0: number, seconds: number, amp = 8000): Int16Array {
  const out = new Int16Array(Math.round(seconds * SR));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = f0 * (1 + 0.01 * Math.sin((2 * Math.PI * 5 * i) / SR));
    phase += (2 * Math.PI * f) / SR;
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(h * phase) / h;
    out[i] = Math.round(amp * 0.5 * s);
  }
  return out;
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("F0 por autocorrelação (#11507)", () => {
  for (const f0 of [110, 163, 205, 232]) {
    it(`mede ${f0} Hz a menos de 3% (sem erro de oitava)`, () => {
      const got = medianF0(voice(f0, 1), SR, 0, 1);
      assert.ok(got !== null && Math.abs(got - f0) / f0 < 0.03, `medido ${got}`);
    });
  }

  it("silêncio e ruído não têm F0", () => {
    assert.equal(medianF0(new Int16Array(SR), SR, 0, 1), null);
    let s = 1;
    const noise = Int16Array.from({ length: SR }, () => ((s = (s * 48271) % 2147483647) % 16000) - 8000);
    assert.equal(medianF0(noise, SR, 0, 1), null);
  });

  it("quadro curto demais para o menor lag devolve null", () => {
    assert.equal(frameF0(new Float64Array(50), 0, 50, 8000), null);
  });
});

describe("vozes por segmento (#11507)", () => {
  // A entrevista da 261029, comprimida: Bruna pergunta, Pixel responde (mais tempo), e o resumo dela a ~205 Hz.
  const parts: Array<[number, number]> = [
    [218, 2], // Bruna pergunta
    [163, 6], // Pixel
    [225, 1.5], // Bruna
    [160, 5], // Pixel
    [205, 1.5], // o "resumo" da Bruna que parecia do Pixel
    [166, 4], // Pixel
    [188, 1.5], // ambígua
  ];
  const audio = concat(parts.map(([f, s]) => voice(f, s)));
  let t = 0;
  const segments: Segment[] = parts.map(([, s], i) => {
    const seg = { start: t, end: t + s, text: ` fala ${i + 1}` };
    t += s;
    return seg;
  });
  const f0s = segmentF0s(audio, SR, segments);
  const v = classifyVoices(f0s, segments.map((s) => s.end - s.start));

  it("acha duas vozes, Pixel = a de mais tempo de fala", () => {
    assert.equal(v.twoVoices, true);
    assert.equal(v.pixelFrom, "maior-tempo");
    assert.ok(v.pixelHz! > 155 && v.pixelHz! < 172, `pixel ${v.pixelHz}`);
    assert.ok(v.otherHz! > 200 && v.otherHz! < 232, `outra ${v.otherHz}`);
  });

  it("regressão 261029: o trecho a ~205 Hz é da entrevistadora; o do meio é 'ouvir'", () => {
    assert.deepEqual(v.marks.map((m) => m?.label), ["outra", "pixel", "outra", "pixel", "outra", "pixel", "ouvir"]);
  });

  it("a listagem da decupagem e o molde trazem a voz e a sugestão de corte", () => {
    const listing = segmentListing(segments, v.marks);
    assert.match(listing, /^1\. .*voz: entrevistadora, 2\d\d Hz: cortar \(fala da entrevistadora\)/m);
    assert.match(listing, /^2\. .*voz: Pixel, 16\d Hz/m);
    assert.match(listing, /^7\. .*voz: ouvir, 1[89]\d Hz/m);
    const tpl = decupagemPlanTemplate("261029", segments, v.marks) as { _segmentos: string[] };
    assert.match(tpl._segmentos[4], /cortar \(fala da entrevistadora\)/);
    assert.doesNotMatch(segmentListing(segments), /voz:/, "sem medida, a listagem é a de antes");
  });

  it("monólogo (uma voz, 158–172 Hz): nada marcado", () => {
    const mono = classifyVoices([158, 165, 172, 161, null], [3, 4, 2, 5, 1]);
    assert.equal(mono.twoVoices, false);
    assert.ok(mono.marks.every((m) => m === null));
  });

  it("--pixel-f0 fixa a referência, mesmo se a outra voz falou mais", () => {
    const r = classifyVoices([215, 220, 163, 210], [10, 10, 2, 8], { pixelHz: 163 });
    assert.equal(r.pixelFrom, "referencia");
    assert.deepEqual(r.marks.map((m) => m?.label), ["outra", "outra", "pixel", "outra"]);
    const sem = classifyVoices([215, 220, 163, 210], [10, 10, 4, 8]);
    assert.equal(sem.marks[2]?.label, "outra", "sem a referência, a voz de mais tempo vira o Pixel (premissa)");
  });

  it("segmento sem F0 medida, com duas vozes, é 'ouvir'", () => {
    const r = classifyVoices([163, 220, null], [5, 4, 1]);
    assert.equal(r.marks[2]?.label, "ouvir");
    assert.equal(voiceHint(r.marks[2]), "voz: ouvir, F0 não medida");
  });

  it("outra voz com tempo desprezível não conta como entrevista", () => {
    const r = classifyVoices([163, 165, 230], [50, 50, 0.5]);
    assert.ok(VOICE.minShare > 0.5 / 100.5);
    assert.equal(r.twoVoices, false);
  });

  it("--pixel-f0 fora da faixa é erro", () => {
    assert.equal(parsePixelF0Arg("163"), 163);
    assert.equal(parsePixelF0Arg(undefined), undefined);
    assert.throws(() => parsePixelF0Arg("abc"), /--pixel-f0/);
    assert.throws(() => parsePixelF0Arg("1000"), /--pixel-f0/);
  });
});

describe("formato entrevista (#11507)", () => {
  it("sem título nem resumo (e com comentário) é entrevista inferida; format explícito vence", () => {
    assert.deepEqual(effectiveFormat({ blocks: { abertura: [1], comentario: [1], titulo: [], resumo: [] } }), { format: "entrevista", inferred: true });
    assert.deepEqual(effectiveFormat({ blocks: { titulo: [1], comentario: [1] } }), { format: "monologo", inferred: false });
    assert.deepEqual(effectiveFormat({ blocks: { abertura: [1] } }), { format: "monologo", inferred: false }, "sem comentário não é entrevista");
    assert.deepEqual(effectiveFormat({ format: "monologo", blocks: { comentario: [1] } }), { format: "monologo", inferred: false });
  });

  it("as sequências default da entrevista: abertura → comentário → CTA → fecho, mesmos nomes/destinos", () => {
    const e = defaultSequences("V1", "entrevista");
    const m = defaultSequences("V1");
    assert.deepEqual(e.map((s) => s.order), [
      ["abertura", "comentario", "cta_yt", "fecho"],
      ["abertura", "comentario", "cta_ig", "fecho"],
      ["abertura", "comentario", "cta_out", "fecho"],
    ]);
    assert.deepEqual(e.map((s) => [s.target, s.name, s.width, s.height, s.scales]), m.map((s) => [s.target, s.name, s.width, s.height, s.scales]));
  });

  it("parseBlocksFile aceita format monologo/entrevista e recusa outro", () => {
    const ok = { edition: "261029", blocks: { comentario: [{ start: 1, end: 2 }] } };
    assert.equal(parseBlocksFile({ ...ok, format: "entrevista" }).ok, true);
    const bad = parseBlocksFile({ ...ok, format: "podcast" });
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.errors.join("\n"), /format precisa ser monologo ou entrevista/);
  });

  it("regressão 261029: com as sequências da entrevista, nenhum bloco falta no plano", () => {
    const say = (t0: number, txt: string): Word[] => txt.split(" ").map((w, i) => ({ start: t0 + i * 0.4, end: t0 + i * 0.4 + 0.3, text: w }));
    const words = [...say(1, "oi eu sou o Pixel"), ...say(10, "o comentário de hoje"), ...say(20, "assine o canal"), ...say(25, "siga no instagram"), ...say(30, "leia a diária"), ...say(35, "até amanhã")];
    const file: BlocksFile = {
      edition: "261029",
      blocks: {
        abertura: [{ start: 0.9, end: 3 }],
        comentario: [{ start: 9.9, end: 11.6 }],
        cta_yt: [{ start: 19.9, end: 21.2 }],
        cta_ig: [{ start: 24.9, end: 26.2 }],
        cta_out: [{ start: 29.9, end: 31.2 }],
        fecho: [{ start: 34.9, end: 35.8 }],
      },
    };
    const { blocks, errors } = resolveBlocks(file, words, { durationS: 40 });
    assert.deepEqual(errors, []);
    const { format } = effectiveFormat(file);
    for (const spec of defaultSequences("V1", format)) {
      assert.deepEqual(buildSequencePlan(spec, blocks, [], { fps: 30, durationS: 40 }).missingBlocks, [], spec.target);
    }
    // O default do monólogo acusaria o título (e o resumo) faltando: era o ajuste manual da 261029.
    assert.ok(buildSequencePlan(defaultSequences()[0], blocks, [], { fps: 30, durationS: 40 }).missingBlocks.includes("titulo"));
  });
});
