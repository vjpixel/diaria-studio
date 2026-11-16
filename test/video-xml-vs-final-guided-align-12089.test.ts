/**
 * #12089: a comparação XML × final da 261116 saiu pulada com "alinhamento
 * fraco" (23% do horizontal, 35% da vertical) com o bruto e o final certos. O
 * XML da montagem tem clipes de ~3 s que pulam para frente e para trás no
 * bruto; o alinhamento por janela (10 s, deslocamento só crescente) não acha
 * par. O guiado pelos clipes do XML acha (99% e 95% na 261116).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labelRuns, alignEnvelopes } from "../scripts/lib/diaria/video-audio-align.ts";
import {
  alignFinalToBruto,
  alignGuidedByClips,
  alignWithReorder,
  clipGuidedOffsets,
  compareSequence,
  finalSpansFromRuns,
  type XmlClip,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";

const HOP = 0.01;
const OPTS = { windowS: 10, windowHopS: 5, stepS: 0.05, subWinS: 1 } as const;

/** Bruto sintético de 200 s: "sílabas" de 80–250 ms com nível aleatório, pausas curtas entre palavras e longas entre frases. */
function syntheticBruto(seed0: number): Float64Array {
  let seed = seed0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = new Float64Array(20000);
  let i = 0;
  while (i < out.length) {
    const syl = Math.round(8 + rnd() * 17);
    const level = -40 + rnd() * 28;
    for (let k = 0; k < syl && i < out.length; k++, i++) out[i] = level + 3 * (rnd() - 0.5);
    const gap = rnd() < 0.15 ? Math.round(30 + rnd() * 50) : Math.round(2 + rnd() * 6);
    for (let k = 0; k < gap && i < out.length; k++, i++) out[i] = -55 + 4 * rnd();
  }
  return out;
}

const seg = (x: Float64Array, a: number, b: number) => x.slice(Math.round(a / HOP), Math.round(b / HOP));
function concat(parts: Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// XML no padrão da 261116: clipes de 2,5–3,5 s, com saltos para trás no bruto (150 → 40, 180 → 70).
const CLIPS: XmlClip[] = [
  [10, 13], [13.6, 16.5], [20, 22.8], [150, 153.2], [153.8, 156.5], [40, 43], [44, 46.7], [48, 51.4], [180, 183], [70, 72.6], [73, 76.2], [100, 103.4],
].map(([srcIn, srcOut], index) => ({ index, srcIn, srcOut }));

/**
 * O que o editor faz no Premiere: tira o clipe 4 inteiro, tira uma pausa de 0,6 s no meio do clipe 7
 * (49,0–49,6 s) e apara 0,2 s da entrada do clipe 9. A faixa do final é a tratada (nível +12 dB,
 * pausas ainda mais baixas pelo gate).
 */
function editorFinal(bruto: Float64Array): Float64Array {
  const parts: Float64Array[] = [];
  for (const c of CLIPS) {
    if (c.index === 4) continue;
    if (c.index === 7) {
      parts.push(seg(bruto, c.srcIn, 49.0), seg(bruto, 49.6, c.srcOut));
      continue;
    }
    parts.push(seg(bruto, c.index === 9 ? c.srcIn + 0.2 : c.srcIn, c.srcOut));
  }
  return Float64Array.from(concat(parts), (v) => (v < -50 ? v - 15 : v + 12));
}

describe("#12089: alinhamento XML × final guiado pelos clipes", () => {
  const bruto = syntheticBruto(7);
  const final = editorFinal(bruto);
  const durF = final.length * HOP;

  it("premissa: o alinhamento por janela não cobre o XML de clipes curtos com saltos", () => {
    const win = alignWithReorder(final, bruto, HOP, OPTS);
    assert.ok(win.coverage < 0.5, `cobertura por janela ${win.coverage}`);
  });

  it("guiado pelo XML: cobre o final e mede o que o editor mudou", () => {
    const al = alignGuidedByClips(final, bruto, HOP, CLIPS, OPTS);
    assert.ok(al.coverage > 0.9, `cobertura ${al.coverage}`);
    const r = compareSequence({ clips: CLIPS, spans: finalSpansFromRuns(al.runs), finalDurationS: durF });
    assert.deepEqual(r.clips.filter((c) => c.status === "removed").map((c) => c.index), [4]);
    const pause = r.clips[7].internalPauses.find((p) => Math.abs(p.start - 49.0) <= 0.15);
    assert.ok(pause && Math.abs(pause.ms - 600) <= 150, JSON.stringify({ c7: r.clips[7], runs: al.runs, offs: clipGuidedOffsets(final, bruto, HOP, CLIPS) }));
    assert.ok(r.clips[9].headMs !== null && Math.abs(r.clips[9].headMs + 200) <= 100, `entrada do clipe 9: ${r.clips[9].headMs}`);
    assert.equal(r.summary.orderInversions, 0);
  });

  it("alignFinalToBruto: os clipes do plan.json (#13197) já cobrem, e o guiado pelo XML (#12089) não entra", () => {
    const al = alignFinalToBruto(final, bruto, HOP, CLIPS, OPTS, 0.5);
    assert.equal(al.method, "janela");
    assert.equal(al.guide, "plan-clips");
    assert.ok(al.coverage > 0.9, `cobertura ${al.coverage}`);
  });

  it("alignFinalToBruto cai no guiado pelo XML quando nem a janela nem os clipes do plan.json cobrem", () => {
    // Ruído forte e periódico no final: o alignByPlanClips (r ≥ 0,8 no clipe inteiro) não acha par, os pedaços de 1 s acham.
    const noisy = Float64Array.from(final, (v, i) => v + ((i * 7919) % 13) * 6);
    const al = alignFinalToBruto(noisy, bruto, HOP, CLIPS, OPTS, 0.5);
    assert.equal(al.method, "guiado-xml");
    assert.ok(al.windowCoverage < 0.5, `1ª camada ${al.windowCoverage}`);
    assert.ok(al.coverage > 0.8, `cobertura ${al.coverage}`);
  });

  it("um par falso de clipe curto adiante não leva os clipes seguintes (escolha conjunta, não pedaço a pedaço)", () => {
    // Cópia do clipe 2 (20–22,8 s) colada 15 s depois no final, um pouco mais parecida que o par certo:
    // escolher pelo maior r, pedaço a pedaço, puxaria o resto para depois dela.
    const clip2 = seg(bruto, 20, 22.8);
    const at = Math.round(5.9 / HOP) + Math.round(15 / HOP);
    const noisy = Float64Array.from(final, (v, i) => v + ((i * 7919) % 13) * 0.4);
    noisy.set(clip2.map((v) => (v < -50 ? v - 15 : v + 12)), at);
    const al = alignGuidedByClips(noisy, bruto, HOP, CLIPS, OPTS);
    const r = compareSequence({ clips: CLIPS, spans: finalSpansFromRuns(al.runs), finalDurationS: noisy.length * HOP });
    const removed = r.clips.filter((c) => c.status === "removed").map((c) => c.index);
    assert.ok(!removed.includes(3) && !removed.includes(5) && !removed.includes(11), `removidos: ${removed}`);
  });

  it("clipGuidedOffsets segue a ordem do XML, inclusive para trás no bruto", () => {
    const offs = clipGuidedOffsets(final, bruto, HOP, CLIPS);
    const back = offs.findIndex((o, i) => i > 0 && o < offs[i - 1] - 50);
    assert.ok(back > 0, `deveria haver um salto para trás: ${offs}`);
  });

  it("alignFinalToBruto mantém o por janela quando ele já cobre (sem mudar edições que já funcionavam)", () => {
    const parts = [seg(bruto, 8, 30), seg(bruto, 32, 60)];
    const f = concat(parts);
    const al = alignFinalToBruto(f, bruto, HOP, [{ index: 0, srcIn: 8, srcOut: 30 }, { index: 1, srcIn: 32, srcOut: 60 }], OPTS, 0.5);
    assert.equal(al.method, "janela");
    assert.ok(al.coverage > 0.9);
  });

  it("labelRuns reproduz o alignEnvelopes com os mesmos deslocamentos (refator sem mudança de comportamento)", () => {
    const f = concat([seg(bruto, 8, 30), seg(bruto, 32, 60)]);
    const full = alignEnvelopes(f, bruto, HOP, OPTS);
    const again = labelRuns(f, bruto, HOP, full.offsets, OPTS);
    assert.deepEqual(again.runs, full.runs);
    assert.equal(again.coverage, full.coverage);
  });
});
