/**
 * test/video-xml-vs-final-plan-guided-13197.test.ts
 *
 * Regressão do backfill da #13197: na 261104 (42 clipes em 127 s, ordem do
 * bruto trocada desde o 2º clipe) e na 261105 (65 clipes) o alinhamento
 * monótono + busca dos vãos achava 0% e 43% do final com par, e as duas
 * edições saíam do backfill como "alinhamento fraco". Com os clipes do
 * plan.json guiando os deslocamentos (`alignByPlanClips`), as duas passaram a
 * 98% e 96%. Aqui, o mesmo formato em envelope sintético.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alignByPlanClips,
  alignWithReorder,
  compareSequence,
  finalSpansFromRuns,
  REORDER_MIN_GAP_S,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";

const hop = 0.01;
const opts = { windowS: 10, windowHopS: 5, stepS: 0.05, subWinS: 1 };

/** Bruto de 90 s com "sílabas" (blocos de 0,2–0,4 s com som ou silêncio) e ruído por quadro. */
function brutoEnvelope(seed0: number): Float64Array {
  let seed = seed0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const b = new Float64Array(9000);
  let i = 0;
  while (i < b.length) {
    const len = 20 + Math.floor(rnd() * 20);
    const loud = rnd() < 0.7;
    for (let j = 0; j < len && i < b.length; j++, i++) b[i] = loud ? -35 + 25 * rnd() : -80 + 5 * rnd();
  }
  return b;
}

/** Final = os trechos do bruto colados na ordem dada. */
function montage(bruto: Float64Array, pieces: Array<[number, number]>): Float64Array {
  const segs = pieces.map(([a, b]) => bruto.slice(Math.round(a / hop), Math.round(b / hop)));
  const out = new Float64Array(segs.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of segs) {
    out.set(s, o);
    o += s.length;
  }
  return out;
}

// Montagem picotada: 14 clipes de 1,2–3 s, a ordem do bruto embaralhada (como o XML da 261104).
const CLIPS: Array<[number, number]> = [
  [48.2, 50.4], [18.3, 19.5], [19.6, 22.1], [60.7, 63.4], [5.1, 6.6], [70.9, 73.0], [33.4, 35.2],
  [80.1, 82.9], [12.0, 13.4], [40.5, 43.1], [25.0, 26.3], [86.0, 88.2], [55.5, 57.9], [1.0, 2.8],
];
const xmlClips = CLIPS.map(([srcIn, srcOut], index) => ({ index, srcIn, srcOut }));

describe("#13197: alinhamento guiado pelos clipes do plan.json", () => {
  it("montagem picotada sem mudança do editor: a passada sem clipes não alinha, a guiada cobre tudo", () => {
    const bruto = brutoEnvelope(7);
    const final = montage(bruto, CLIPS);
    const blind = alignWithReorder(final, bruto, hop, opts);
    assert.ok(blind.coverage < 0.5, `premissa: sem os clipes a cobertura fica abaixo do mínimo (${blind.coverage})`);
    const al = alignWithReorder(final, bruto, hop, opts, REORDER_MIN_GAP_S, xmlClips);
    assert.equal(al.guide, "plan-clips");
    assert.ok(al.coverage > 0.9, `cobertura ${al.coverage}`);
    const r = compareSequence({ clips: xmlClips, spans: finalSpansFromRuns(al.runs), finalDurationS: final.length * hop });
    assert.equal(r.summary.clipsRemoved, 0);
  });

  it("clipe que o editor tirou sai como removido; o resto segue com par", () => {
    const bruto = brutoEnvelope(11);
    const final = montage(bruto, CLIPS.filter((_, i) => i !== 5));
    const al = alignWithReorder(final, bruto, hop, opts, REORDER_MIN_GAP_S, xmlClips);
    assert.ok(al.coverage > 0.9, `cobertura ${al.coverage}`);
    const r = compareSequence({ clips: xmlClips, spans: finalSpansFromRuns(al.runs), finalDurationS: final.length * hop });
    assert.equal(r.summary.clipsRemoved, 1);
    assert.equal(r.clips[5].status, "removed");
  });

  it("ponta da saída estendida pelo editor fica no deslocamento do clipe (o bruto continua)", () => {
    const bruto = brutoEnvelope(23);
    const edited = CLIPS.map(([a, b], i): [number, number] => (i === 3 ? [a, b + 0.6] : [a, b]));
    const final = montage(bruto, edited);
    const al = alignWithReorder(final, bruto, hop, opts, REORDER_MIN_GAP_S, xmlClips);
    const r = compareSequence({ clips: xmlClips, spans: finalSpansFromRuns(al.runs), finalDurationS: final.length * hop });
    const tail = r.clips[3].tailMs;
    assert.ok(tail !== null && tail >= 450 && tail <= 750, `ponta da saída do clipe 3: ${tail} ms`);
  });

  it("sem clipes, ou com clipes que não casam, mantém a base monótona", () => {
    const bruto = brutoEnvelope(5);
    const final = bruto.slice(1000, 4000);
    const al = alignWithReorder(final, bruto, hop, opts, REORDER_MIN_GAP_S, []);
    assert.equal(al.guide, "monotonic");
    assert.ok(al.coverage > 0.9);
    const other = brutoEnvelope(99);
    const none = alignByPlanClips(final, other, hop, [{ srcIn: 3, srcOut: 6 }], opts);
    assert.equal(none.coverage, 0);
    assert.deepEqual(none.offsets, []);
  });

  it("clipe curto demais ou fora do bruto não gera candidato", () => {
    const bruto = brutoEnvelope(3);
    const final = bruto.slice(0, 2000);
    const r = alignByPlanClips(final, bruto, hop, [{ srcIn: 1, srcOut: 1.2 }, { srcIn: 89, srcOut: 95 }], opts);
    assert.deepEqual(r.offsets, []);
  });
});
