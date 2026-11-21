/**
 * #13742: na 261119 a decupagem saiu com exit 5 por duas tomadas colapsadas
 * (segmentos 36 e 51) que a janela do #13587 e as subjanelas não separaram;
 * a tomada saiu à mão com uma retranscrição que começava depois da última
 * suspeita. Os dados abaixo são os do state da 261119
 * (`transcript.json`, `silences.json`, `retranscribe-*.json`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCollapsedListing,
  retranscribeKey,
  tailTake,
  tailWindowFor,
  collapsedSegmentJobs,
  type CollapsedListingIO,
} from "../scripts/lib/diaria/video-decupagem-collapsed.ts";
import { decupagemGate } from "../scripts/lib/diaria/video-decupagem-gate.ts";
import type { Segment, Transcript, Word } from "../scripts/lib/diaria/video-montage.ts";

type W3 = [number, number, string];
const words = (ws: W3[]): Word[] => ws.map(([start, end, text]) => ({ start, end, text }));
const seg = (start: number, end: number, ws: W3[]): Segment => {
  const w = words(ws);
  return { start, end, text: w.map((x) => x.text).join(" "), words: w };
};
const tr = (...segs: W3[][]): Transcript => ({ segments: segs.map((ws) => seg(ws[0][0], ws[ws.length - 1][1], ws)) });

// Segmento 36 do transcript longo: vão de 12,1 s entre "A" e "OpenAI", e "lançou"/"modelos" esticadas.
const S36: W3[] = [[235.32, 235.92, "A"], [248.36, 248.96, "OpenAI"], [248.96, 251.36, "lançou"], [251.36, 251.6, "dois"], [251.6, 257.04, "modelos"], [257.04, 257.42, "novos,"], [257.6, 257.8, "o"], [257.8, 258.34, "GPT"], [258.34, 258.64, "6"], [258.64, 259.14, ".2"], [259.14, 259.46, "SOL,"], [259.62, 259.82, "pro"], [259.82, 260.0, "dia"], [260.0, 260.16, "a"], [260.16, 260.34, "dia,"], [260.56, 261.12, "e"], [261.12, 261.22, "o"], [261.22, 261.64, "GPT"], [261.64, 261.9, "6"], [261.9, 262.36, ".2"], [262.36, 262.76, "Astra,"], [262.96, 263.26, "pra"], [263.26, 263.64, "trabalhos"], [263.64, 263.84, "mais"], [263.84, 264.46, "difíceis."]];
// A janela do #13587 (234,8–265,0 s): uma tomada só, com "o" esticado por 5,2 s.
const WIN36: W3[] = [[247.86, 248.5, "A"], [248.5, 248.96, "OpenAI"], [248.96, 251.36, "lançou"], [251.36, 251.6, "dois"], [251.6, 252, "modelos"], [252, 252.44, "novos,"], [252.62, 257.8, "o"], [257.8, 258.34, "GPT"], [258.34, 258.66, "6"], [258.66, 259.14, ".2"], [259.14, 259.46, "SOL,"], [259.62, 259.84, "para"], [259.84, 259.9, "o"], [259.9, 260.02, "dia"], [260.02, 260.18, "a"], [260.18, 260.36, "dia,"], [260.58, 261.14, "e"], [261.14, 261.2, "o"], [261.2, 261.66, "GPT"], [261.66, 261.92, "6"], [261.92, 262.38, ".2"], [262.38, 262.78, "Astra,"], [262.96, 263.28, "para"], [263.28, 263.66, "trabalhos"], [263.66, 263.84, "mais"], [263.84, 264.46, "difíceis."]];
// O que a retranscrição da cauda ouve (a de 251,5–266,0 s que resolveu à mão): só a última tomada.
const TAIL36: W3[] = [[254.52, 255.12, "A"], [255.12, 255.72, "OpenAI"], [255.72, 256.46, "lançou"], [256.46, 256.64, "dois"], [256.64, 257.06, "modelos"], [257.06, 257.46, "novos,"], [257.64, 257.82, "o"], [257.82, 258.34, "GPT"], [258.34, 258.66, "-6"], [258.66, 259.16, ".2"], [259.16, 259.46, "SOL,"], [259.62, 259.8, "para"], [259.8, 259.88, "o"], [259.88, 260, "dia"], [260, 260.16, "a"], [260.16, 260.36, "dia,"], [260.62, 261.14, "e"], [261.14, 261.2, "o"], [261.2, 261.66, "GPT"], [261.66, 261.94, "-6"], [261.94, 262.38, ".2"], [262.38, 262.76, "Astra,"], [262.96, 263.28, "para"], [263.28, 263.66, "trabalhos"], [263.66, 263.84, "mais"], [263.84, 264.48, "difíceis."]];

// Segmento 51: o Whisper longo juntou o fim da 1ª tomada ("Tanto no plano de empresa, os") com a 2ª.
const S51: W3[] = [[427.75, 428.23, "Tanto"], [428.23, 428.39, "no"], [428.39, 428.63, "plano"], [428.63, 428.81, "de"], [428.81, 429.45, "empresa,"], [429.61, 429.93, "os"], [436.36, 436.5, "dois"], [436.5, 436.66, "já"], [436.66, 436.78, "estão"], [436.78, 436.9, "no"], [436.9, 437.1, "chat"], [437.1, 437.5, "GPT"], [437.5, 437.62, "pra"], [437.62, 437.78, "quem"], [437.78, 438.2, "paga."]];
const WIN51: W3[] = [[427.87, 428.23, "Tanto"], [428.23, 428.39, "no"], [428.39, 428.63, "plano"], [428.63, 428.81, "de"], [428.81, 429.45, "empresa,"], [429.85, 436.33, "os"], [436.33, 436.49, "dois"], [436.49, 436.67, "já"], [436.67, 436.79, "estão"], [436.79, 436.93, "no"], [436.93, 437.11, "chat"], [437.11, 437.51, "GPT"], [437.51, 437.63, "para"], [437.63, 437.79, "quem"], [437.79, 438.21, "paga."]];
// A 2ª tomada, como a retranscrição de 425–441 s a ouviu (a que resolveu à mão), até a borda da cauda.
const TAIL51: W3[] = [[435.9, 436.34, "Os"], [436.34, 436.52, "dois"], [436.52, 436.68, "já"], [436.68, 436.8, "estão"], [436.8, 436.92, "no"], [436.92, 437.48, "ChatGPT"], [437.48, 437.62, "para"], [437.62, 437.78, "quem"], [437.78, 438.2, "paga."], [438.42, 438.74, "Tanto"]];

const SIL = [{ start: 235.35, end: 236.31 }, { start: 249.64, end: 250.27 }, { start: 253.71, end: 254.15 }, { start: 264.63, end: 265.18 }, { start: 427.33, end: 428.01 }];
const DUR = 1496.73;

const SEGMENTS: Segment[] = [
  seg(220.4, 225.18, [[224.5, 225.18, "vida."]]),
  seg(235.32, 264.46, S36),
  seg(264.46, 284.56, [[265.24, 265.84, "Obrigado."]]),
  seg(424.85, 427.21, [[426.76, 427.2, "paga."]]),
  seg(427.75, 438.2, S51),
  seg(438.36, 441.32, [[438.42, 438.74, "Tanto"]]),
];

function io(tails: Record<string, Transcript>): CollapsedListingIO & { asked: string[][] } {
  const files = new Map<string, Transcript>([
    ["234.8-265.0", tr(WIN36)],
    ["427.3-438.7", tr(WIN51)],
  ]);
  const asked: string[][] = [];
  return {
    asked,
    readWindow: (k) => files.get(k) ?? null,
    // Subjanelas: as da 261119 não acharam falso começo; aqui nenhuma gravada.
    readSub: () => null,
    transcribeWindows: (wins, kind) => {
      asked.push(wins.map((w) => `${kind}:${w.key}`));
      if (kind === "janela") for (const w of wins) if (tails[w.key]) files.set(w.key, tails[w.key]);
      return true;
    },
  };
}

describe("#13742 janela de cauda", () => {
  it("a janela da cauda começa na ÚLTIMA suspeita (no 36, a palavra esticada depois do vão de 12,1 s)", () => {
    const jobs = collapsedSegmentJobs(SEGMENTS, SIL, DUR);
    assert.deepEqual(jobs.map((j) => j.key), ["234.8-265.0", "427.3-438.7"]);
    assert.deepEqual(tailWindowFor(SEGMENTS[1], jobs[0], SIL, DUR), { start: 251.1, end: 264.96 });
    assert.deepEqual(tailWindowFor(SEGMENTS[4], jobs[1], SIL, DUR), { start: 434.86, end: 438.7 });
  });

  it("os segmentos 36 e 51 da 261119 saem resolvidos pela cauda, sem parada no Gate 1", () => {
    const k36 = retranscribeKey({ start: 251.1, end: 264.96 });
    const k51 = retranscribeKey({ start: 434.86, end: 438.7 });
    const x = io({ [k36]: tr(TAIL36), [k51]: tr(TAIL51) });
    const res = resolveCollapsedListing(SEGMENTS, SIL, DUR, x);
    // Uma chamada só do Whisper para as duas caudas.
    assert.deepEqual(x.asked.filter((a) => a[0].startsWith("janela:")).at(-1), [`janela:${k36}`, `janela:${k51}`]);
    assert.equal(res.transcribed.tails, 2);
    assert.equal(res.unresolved.length, 0);
    assert.equal(res.resolved, 2);
    const o36 = res.origin[1];
    assert.equal(o36.tail, true);
    assert.equal(o36.collapsed, undefined);
    assert.match(o36.note ?? "", /cauda: a última tomada do segmento 2/);
    assert.equal(res.segments[1].words![0].start, 254.52);
    assert.match(res.segments[1].text, /^A OpenAI lançou dois modelos novos/);
    assert.ok(res.segments[1].start <= 254.52 && res.segments[1].start > 251.36, `início ${res.segments[1].start}`);
    const s51 = res.segments[4];
    assert.match(s51.text, /^Os dois já estão no ChatGPT para quem paga\.$/);
    // A palavra do segmento seguinte ("Tanto", 438,42 s) fica de fora.
    assert.ok(s51.end < 438.36, `fim ${s51.end}`);

    const gate = decupagemGate({
      plan: { edition: "261119", blocks: [{ key: "resumo", rows: [{ segments: [2], suggestion: "usar" }, { segments: [5], suggestion: "usar" }] }] } as never,
      origin: res.origin,
      contraDirecao: [],
      mirror: { premise: "x", ambiguous: false, frameUnresolved: false },
      takes: [],
      durations: [],
      verticalMaxS: 60,
      loudness: null,
      alternativas: 0,
    });
    assert.equal(gate.decision, "segue");
    assert.equal(gate.premissas.filter((p) => /resolvida pela cauda/.test(p)).length, 2);
  });

  it("sem a cauda (máquina sem áudio), as duas seguem como parada, como antes", () => {
    const x = io({});
    const res = resolveCollapsedListing(SEGMENTS, SIL, DUR, { ...x, transcribeWindows: () => false });
    assert.equal(res.unresolved.length, 2);
    assert.equal(res.audioMissing, true);
    assert.deepEqual(res.origin.filter((o) => o.collapsed === "nao-separada").map((o) => o.original), [2, 5]);
  });

  it("pausa barulhenta da MESMA tomada (a cauda não repete nada do começo) não corta o começo da frase", () => {
    const s = seg(10, 20, [[10, 10.3, "eu"], [10.3, 10.6, "acho"], [10.6, 10.9, "que"], [14.5, 14.7, "a"], [14.7, 15, "IA"], [15, 15.3, "vai"], [15.3, 15.7, "mudar"], [15.7, 16.2, "tudo."]]);
    const tail = tr([[14.5, 14.7, "a"], [14.7, 15, "IA"], [15, 15.3, "vai"], [15.3, 15.7, "mudar"], [15.7, 16.2, "tudo."]]);
    assert.equal(tailTake(s, undefined, undefined, tail, []), null);
  });

  it("cauda que ouviu duas tomadas fica com a segunda; cauda com vão próprio não decide", () => {
    const s = seg(0, 12, [[0, 0.3, "a"], [0.3, 0.6, "OpenAI"], [4, 4.3, "lançou"], [4.3, 4.6, "dois"], [4.6, 5, "modelos"]]);
    const two = tr([[3.0, 3.2, "a"], [3.2, 3.5, "OpenAI"], [3.5, 3.8, "lançou"], [3.9, 4.1, "a"], [4.1, 4.4, "OpenAI"], [4.4, 4.7, "lançou"], [4.7, 4.9, "dois"], [4.9, 5.2, "modelos"]]);
    const t = tailTake(s, undefined, undefined, two, []);
    assert.equal(t?.words?.[0].start, 3.9);
    const gap = tr([[3.0, 3.2, "a"], [3.2, 3.5, "OpenAI"], [6, 6.3, "lançou"], [6.3, 6.6, "dois"], [6.6, 7, "modelos"]]);
    assert.equal(tailTake(s, undefined, undefined, gap, []), null);
  });

  it("#13784: artigo/conjunção sozinho não prova recomeço; palavra de conteúdo ou fim-da-tomada-abortada prova", () => {
    // "a" dita no meio da frase antes da pausa, cauda começa em "a" sem a 2ª palavra antes: não é recomeço.
    const s = seg(10, 20, [[10, 10.3, "eu"], [10.3, 10.6, "a"], [10.6, 10.9, "gente"], [14.5, 14.7, "a"], [14.7, 15, "IA"], [15, 15.3, "vai"], [15.3, 15.7, "mudar"], [15.7, 16.2, "tudo."]]);
    const tail = tr([[14.5, 14.7, "a"], [14.7, 15, "IA"], [15, 15.3, "vai"], [15.3, 15.7, "mudar"], [15.7, 16.2, "tudo."]]);
    assert.equal(tailTake(s, undefined, undefined, tail, []), null);
    // Palavra de conteúdo repetida segue valendo como prova de 1 palavra.
    const c = seg(10, 20, [[10, 10.3, "OpenAI"], [14.5, 14.9, "OpenAI"], [14.9, 15.3, "lançou"], [15.3, 15.7, "modelos."]]);
    const ct = tr([[14.5, 14.9, "OpenAI"], [14.9, 15.3, "lançou"], [15.3, 15.7, "modelos."]]);
    assert.ok(tailTake(c, undefined, undefined, ct, []));
  });

  it("#13800: cauda que repete a última palavra funcional do anterior com pequeno desvio de horário não prova recomeço", () => {
    // "dois" esticada (a última suspeita): a janela da cauda começa 0,5 s antes dela e pega de novo o "os",
    // que a retranscrição põe 0,03 s depois do fim dele na longa (desvio maior que a duração da palavra).
    const s = seg(10, 16, [[10, 10.4, "Tanto"], [10.4, 10.6, "no"], [10.6, 11, "plano"], [11, 11.32, "os"], [11.32, 14.5, "dois"], [14.5, 14.7, "já"], [14.7, 15, "estão"], [15, 15.4, "aqui."]]);
    const tail = tr([[11.35, 11.6, "os"], [11.6, 11.9, "dois"], [11.9, 12.1, "já"], [12.1, 12.4, "estão"], [12.4, 12.8, "aqui."]]);
    assert.equal(tailTake(s, undefined, undefined, tail, []), null);
    // A regravação de verdade começa depois do vão, segundos adiante: segue valendo.
    const late = tr([[13.6, 13.9, "os"], [13.9, 14.2, "dois"], [14.2, 14.5, "já"], [14.5, 14.8, "estão"], [14.8, 15.2, "aqui."]]);
    assert.equal(tailTake(s, undefined, undefined, late, [])?.words?.[0].start, 13.6);
  });

  it("#13800: contrações e conjunções (ao, pro, pelo, mas…) também são funcionais e sozinhas não provam recomeço", () => {
    for (const fw of ["ao", "pro", "nos", "dos", "pela", "mas", "ou"]) {
      const s = seg(10, 20, [[10, 10.3, "eu"], [10.3, 10.6, fw], [10.6, 10.9, "lado"], [14.5, 14.7, fw], [14.7, 15, "fim"], [15, 15.3, "tudo"], [15.3, 15.7, "muda."]]);
      const tail = tr([[14.5, 14.7, fw], [14.7, 15, "fim"], [15, 15.3, "tudo"], [15.3, 15.7, "muda."]]);
      assert.equal(tailTake(s, undefined, undefined, tail, []), null, fw);
    }
  });
});
