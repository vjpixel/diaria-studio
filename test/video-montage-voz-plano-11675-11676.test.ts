/**
 * test/video-montage-voz-plano-11675-11676.test.ts
 *
 * #11675 — na 261030, um monólogo, a 1ª passada da decupagem viu duas vozes
 * (Pixel ~152 Hz, "outra" ~106 Hz) e sugeriu "cortar (fala da entrevistadora)"
 * em 7 falas do roteiro. Quase todas eram segmentos longos do Whisper (20–30 s
 * para uma frase de 3 s): a F0 do trecho sem fala puxava a mediana. Agora a F0
 * é medida só nas palavras, o peso de cada segmento é o tempo de fala, e duas
 * vozes exigem a outra com fala relevante e um vão entre os grupos.
 *
 * #11676 — o `decupagem-plan.json` recusava o mesmo segmento em `resumo` e
 * `resumo_curto` (e nos CTAs de versões diferentes); agora aceita, mantendo a
 * recusa dentro do mesmo bloco e entre blocos que uma sequência leva juntos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVoices, clusterSeparation, medianF0, segmentF0s, speechSeconds, speechSpans, VOICE } from "../scripts/lib/diaria/video-voice.ts";
import {
  blocksFromDecupagem,
  blocksMayShareSegment,
  buildDecupagemDoc,
  checkDecupagemCriteria,
  parseDecupagemPlan,
  SHARED_SEGMENT_GROUPS,
  type DecupagemPlan,
} from "../scripts/lib/diaria/video-montage-docs.ts";
import { defaultSequences, type Segment, type Word } from "../scripts/lib/diaria/video-montage.ts";

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

/** Palavras de 0,3 s a cada 0,35 s cobrindo `[from, to]`. */
function wordsIn(from: number, to: number): Word[] {
  const out: Word[] = [];
  for (let t = from; t + 0.3 <= to + 1e-9; t += 0.35) out.push({ start: t, end: t + 0.3, text: "fala" });
  return out;
}

/**
 * 261030 (monólogo), por segmento: [F0 medida antes do #11675, duração do
 * segmento, segundos de fala pelas palavras]. Fonte: `voices.json` e
 * `transcript.json` da edição. Os 7 marcados "outra" (12, 13, 16, 24, 35, 49,
 * 64) eram falas do roteiro.
 */
const E261030: Array<[number | null, number, number]> = [
  [124.7, 3.3, 3.3], [143.1, 11.6, 10.5], [150.0, 10.8, 10.3], [145.2, 16.3, 16.0], [146.8, 4.8, 4.8], [160.7, 0.5, 0.5],
  [155.1, 2.1, 2.1], [202.7, 1.6, 1.6], [195.3, 1.9, 1.8], [155.0, 2.5, 2.5], [153.6, 9.3, 9.1], [114.6, 23.9, 3.9],
  [114.6, 1.4, 1.4], [147.1, 8.6, 8.6], [158.0, 2.5, 2.5], [87.4, 21.3, 2.6], [156.9, 1.1, 1.1], [199.6, 9.5, 3.1],
  [147.0, 2.6, 2.6], [123.1, 3.3, 3.3], [144.8, 2.2, 2.2], [153.1, 1.8, 1.8], [165.7, 4.3, 4.3], [105.3, 18.8, 1.7],
  [143.0, 5.4, 5.4], [144.7, 7.2, 6.9], [141.6, 7.1, 6.8], [145.6, 20.7, 11.3], [165.0, 7.9, 7.9], [152.4, 7.9, 7.9],
  [177.6, 3.0, 3.0], [143.4, 11.2, 9.7], [148.8, 19.6, 18.0], [140.1, 23.6, 9.7], [119.3, 21.6, 7.4], [132.1, 5.1, 5.1],
  [154.1, 3.7, 3.7], [171.0, 6.2, 5.7], [209.2, 1.6, 1.6], [164.7, 4.6, 4.3], [151.3, 2.7, 2.7], [124.2, 2.6, 2.6],
  [160.6, 3.8, 3.6], [187.8, 1.9, 1.9], [183.7, 3.2, 3.2], [163.7, 3.0, 3.0], [176.3, 3.7, 3.7], [143.3, 32.3, 14.6],
  [117.8, 12.1, 2.3], [129.3, 5.4, 5.0], [159.8, 2.5, 2.5], [133.7, 3.2, 3.2], [138.0, 3.3, 3.2], [185.1, 2.3, 2.3],
  [171.3, 3.2, 3.1], [182.3, 2.6, 2.6], [162.9, 3.0, 3.0], [132.7, 2.7, 2.6], [173.4, 2.0, 2.0], [151.0, 2.0, 2.0],
  [144.1, 2.7, 2.7], [159.4, 5.9, 5.9], [134.9, 3.5, 2.6], [93.2, 27.6, 2.5], [142.5, 3.3, 3.3], [153.9, 0.8, 0.8],
  [139.6, 1.0, 1.0], [146.6, 2.4, 2.4], [207.0, 2.0, 1.8], [186.2, 1.2, 1.2], [141.5, 1.0, 1.0], [178.7, 1.2, 1.2],
  [144.5, 0.8, 0.8], [147.9, 2.2, 2.2], [null, 0.6, 0.6], [null, 0.3, 0.3],
];

describe("voz: F0 só nas palavras do segmento (#11675)", () => {
  // Segmento longo do Whisper: 12 s de zumbido grave (ruído/respiro, ~95 Hz) e a frase de 3 s do Pixel a 152 Hz.
  const audio = concat([voice(95, 12, 1500), voice(152, 3)]);
  const seg: Segment = { start: 0, end: 15, text: " O remédio que ela tomava era…", words: wordsIn(12, 15) };

  it("reproduz o bug: a mediana do intervalo inteiro sai do trecho sem fala", () => {
    const whole = medianF0(audio, SR, 0, 15);
    assert.ok(whole !== null && whole < 110, `medido ${whole}`);
  });

  it("medida só nas palavras: a voz do Pixel", () => {
    const [f] = segmentF0s(audio, SR, [seg]);
    assert.ok(f !== null && Math.abs(f - 152) / 152 < 0.03, `medido ${f}`);
  });

  it("sem palavras com tempo, mede o segmento inteiro (como antes)", () => {
    const [f] = segmentF0s(audio, SR, [{ start: 12, end: 15 }]);
    assert.ok(f !== null && Math.abs(f - 152) / 152 < 0.03, `medido ${f}`);
  });

  it("fala de menos (abaixo de minVoicedFrames) não é medida", () => {
    const [f] = segmentF0s(audio, SR, [{ start: 12, end: 15, words: [{ start: 12, end: 12.2, text: "x" }] }]);
    assert.equal(f, null);
    assert.ok(VOICE.minVoicedFrames * VOICE.hopS >= 0.3, "mínimo de ~0,4 s de voz para comparar");
  });

  it("monólogo com segmentos longos: uma voz só, nada marcado", () => {
    // 4 falas normais do Pixel e 2 segmentos longos com zumbido antes da frase.
    const parts: Array<[Int16Array, number, number]> = [];
    let t = 0;
    const segs: Segment[] = [];
    for (const f0 of [150, 155, 148, 153]) {
      parts.push([voice(f0, 4), t, t + 4]);
      segs.push({ start: t, end: t + 4, text: " fala", words: wordsIn(t, t + 4) });
      t += 4;
    }
    for (let k = 0; k < 2; k++) {
      parts.push([concat([voice(95, 10, 1500), voice(152, 3)]), t, t + 13]);
      segs.push({ start: t, end: t + 13, text: " fala longa", words: wordsIn(t + 10, t + 13) });
      t += 13;
    }
    const a = concat(parts.map((p) => p[0]));
    // Antes: intervalo inteiro, pesado pela duração.
    const old = classifyVoices(
      segmentF0s(a, SR, segs.map(({ start, end }) => ({ start, end }))),
      segs.map((s) => s.end - s.start),
    );
    assert.equal(old.twoVoices, true, "o cenário reproduz a 261030 no método antigo");
    // Agora.
    const v = classifyVoices(segmentF0s(a, SR, segs), segs.map((s) => speechSeconds(s)));
    assert.equal(v.twoVoices, false);
    assert.ok(v.marks.every((m) => m === null));
  });
});

describe("voz: duas vozes só com a outra falando de verdade (#11675)", () => {
  const f0s = E261030.map((r) => r[0]);

  it("regressão 261030: as F0 medidas, pesadas pela fala, são uma voz só", () => {
    const v = classifyVoices(f0s, E261030.map((r) => r[2]));
    assert.equal(v.twoVoices, false);
    assert.ok(v.marks.every((m) => m === null), "nenhum 'cortar (fala da entrevistadora)' em fala do roteiro");
  });

  it("regressão 261030: nem pesadas pela duração do segmento (o peso antigo)", () => {
    assert.equal(classifyVoices(f0s, E261030.map((r) => r[1])).twoVoices, false);
  });

  it("entrevista com vão entre as vozes continua detectada (261029: Pixel ~160–167, Bruna ~205–232)", () => {
    const pixel = [158, 163, 166, 161, 167, 160, 164, 162];
    const bruna = [218, 225, 205, 232, 214];
    const v = classifyVoices([...pixel, ...bruna], [...pixel.map(() => 6), ...bruna.map(() => 3)]);
    assert.equal(v.twoVoices, true);
    assert.deepEqual(v.marks.map((m) => m?.label), [...pixel.map(() => "pixel"), ...bruna.map(() => "outra")]);
  });

  it("outra voz separada mas com poucos segundos de fala não é entrevista", () => {
    const v = classifyVoices([160, 162, 165, 161, 220], [30, 30, 30, 30, 2]);
    assert.ok(2 / 122 < 0.05 && 2 < VOICE.minOtherSpeechS);
    assert.equal(v.twoVoices, false);
  });

  it("separação: grupos com vão ficam acima do mínimo; a 261030 (uma voz só) fica abaixo", () => {
    const l = (f: number) => Math.log(f);
    const mono = E261030.filter((r) => r[0] !== null).map((r) => ({ l: l(r[0]!), w: r[2] }));
    // Os centros que o 2-means acha na 261030 pesada pela fala (~120 e ~154 Hz).
    assert.ok(clusterSeparation(mono, l(120.2), l(153.7)) < VOICE.minSeparation);
    const two = [160, 163, 166, 215, 220, 225].map((f) => ({ l: l(f), w: 1 }));
    assert.ok(clusterSeparation(two, l(163), l(220)) > VOICE.minSeparation);
  });

  it("speechSpans: palavras recortadas ao segmento e fundidas; sem palavras, o segmento", () => {
    const s = { start: 1, end: 5, words: [{ start: 0.5, end: 1.5, text: "a" }, { start: 1.4, end: 2, text: "b" }, { start: 3, end: 6, text: "c" }] };
    assert.deepEqual(speechSpans(s), [[1, 2], [3, 5]]);
    assert.equal(speechSeconds(s), 3);
    assert.deepEqual(speechSpans({ start: 2, end: 4 }), [[2, 4]]);
  });
});

// ── #11676 ──────────────────────────────────────────────────────────────────

function seg(text: string, start: number): Segment {
  const words: Word[] = text.split(" ").map((t, i) => ({ start: start + i * 0.35, end: start + i * 0.35 + 0.3, text: t }));
  return { start, end: words[words.length - 1].end, text, words };
}

// 1 título, 2 e 3 duas tomadas da mesma frase do resumo, 4 resumo, 5 comentário, 6 CTA, 7 fecho.
const SEGMENTS: Segment[] = [
  seg("O Gemini agora lê seu Gmail.", 0),
  seg("O Google liberou o acesso ao e-mail.", 4),
  seg("O Google liberou o acesso ao e-mail.", 8),
  seg("E isso vale para todos os usuários.", 12),
  seg("A questão é quem controla esses dados.", 16),
  seg("Siga a diária para receber conteúdos como esse.", 20),
  seg("Até amanhã!", 25),
];

function plan(extra: DecupagemPlan["blocks"], resumo: DecupagemPlan["blocks"][number]["rows"] = [
  { segments: [2], suggestion: "cortar", reason: "1ª tomada" },
  { segments: [3], suggestion: "usar" },
  { segments: [4], suggestion: "usar" },
]): DecupagemPlan {
  return {
    edition: "261030",
    blocks: [
      { key: "titulo", rows: [{ segments: [1], suggestion: "usar" }] },
      { key: "resumo", rows: resumo },
      { key: "comentario", rows: [{ segments: [5], suggestion: "usar" }] },
      { key: "fecho", rows: [{ segments: [7], suggestion: "usar" }] },
      ...extra,
    ],
  };
}

describe("decupagem-plan: o mesmo segmento em resumo e resumo_curto, e nos CTAs (#11676)", () => {
  const shared = plan([
    { key: "resumo_curto", rows: [{ segments: [3], suggestion: "usar" }] },
    { key: "cta_yt", rows: [{ segments: [6], suggestion: "usar" }] },
    { key: "cta_ig", rows: [{ segments: [6], suggestion: "usar" }] },
    { key: "cta_out", rows: [{ segments: [6], suggestion: "usar" }] },
  ]);

  it("aceita, e os critérios não leem o segmento repetido como duas tomadas", () => {
    const r = parseDecupagemPlan(shared, SEGMENTS.length);
    assert.equal(r.ok, true, r.ok ? "" : r.errors.join(" | "));
    assert.deepEqual(checkDecupagemCriteria(shared, SEGMENTS).errors, []);
  });

  it("o molde do blocks.json sai com resumo_curto e os CTAs das verticais", () => {
    const b = blocksFromDecupagem(buildDecupagemDoc(shared, SEGMENTS));
    assert.equal(b.resumo_curto?.length, 1);
    assert.equal(b.resumo_curto![0].start, SEGMENTS[2].start);
    for (const k of ["cta_yt", "cta_ig", "cta_out"] as const) assert.equal(b[k]?.[0].start, SEGMENTS[5].start, k);
  });

  it("continua recusando: mesmo bloco, blocos fora do grupo, e repetição que não é 'usar' nas duas pontas", () => {
    const cases: Array<[string, DecupagemPlan["blocks"], RegExp]> = [
      ["mesmo bloco", [{ key: "resumo_curto", rows: [{ segments: [4], suggestion: "usar" }, { segments: [4], suggestion: "usar" }] }], /resumo_curto\.rows\[1\]: segmento 4 já está em resumo_curto\.rows\[0\]/],
      ["comentário e CTA", [{ key: "cta_ig", rows: [{ segments: [5], suggestion: "usar" }] }], /cta_ig\.rows\[0\]: segmento 5 já está em comentario/],
      ["resumo e CTA", [{ key: "cta_ig", rows: [{ segments: [4], suggestion: "usar" }] }], /segmento 4 já está em resumo/],
      ["cortar no resumo", [{ key: "resumo_curto", rows: [{ segments: [2], suggestion: "usar" }] }], /resumo_curto\.rows\[0\]: segmento 2 já está em resumo\.rows\[0\]/],
    ];
    for (const [name, extra, re] of cases) {
      const r = parseDecupagemPlan(plan(extra), SEGMENTS.length);
      assert.equal(r.ok, false, name);
      assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${name}: ${r.ok ? "" : r.errors.join(" | ")}`);
    }
  });

  it("outra tomada da mesma frase em resumo_curto continua erro de critério (uma tomada por frase)", () => {
    // 3 no resumo e 2 (outra tomada da mesma frase) no resumo_curto: segmentos diferentes, os dois "usar".
    const p = plan([{ key: "resumo_curto", rows: [{ segments: [2], suggestion: "usar" }] }], [
      { segments: [3], suggestion: "usar" },
      { segments: [4], suggestion: "usar" },
    ]);
    const parsed = parseDecupagemPlan(p, SEGMENTS.length);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join(" | "));
    const errs = checkDecupagemCriteria(p, SEGMENTS).errors;
    assert.ok(errs.some((e) => /segmentos (2|3) .* e (2|3) .*mesma frase/.test(e)), errs.join(" | "));
  });

  it("nenhuma sequência leva dois blocos do mesmo grupo compartilhável", () => {
    for (const format of ["monologo", "entrevista"] as const) {
      for (const spec of defaultSequences("V1", format)) {
        for (const g of SHARED_SEGMENT_GROUPS) {
          const inSeq = spec.order.filter((k) => g.includes(k));
          assert.ok(inSeq.length <= 1, `${spec.name} leva ${inSeq.join(" e ")}`);
        }
      }
    }
    assert.equal(blocksMayShareSegment("resumo", "resumo_curto"), true);
    assert.equal(blocksMayShareSegment("cta_ig", "cta_out"), true);
    assert.equal(blocksMayShareSegment("resumo", "resumo"), false);
    assert.equal(blocksMayShareSegment("titulo", "resumo"), false);
  });
});
