/**
 * #11968: limiar da banda alta relativo ao piso do bruto (o -51 fixo zerava o
 * silences.json num bruto quente/com chiado) + aviso de perda na interseção +
 * a expansão de sibilante limitada pelas palavras da retranscrição da borda.
 * #11969: `build --seq X` só muda no plan.json a sequência reconstruída.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  highBandSilences,
  highBandThresholdDb,
  intersectSilences,
  intersectionLossWarning,
  preserveSibilants,
  trimEdgeExtras,
  edgeWindowsFor,
  SIBILANTS,
  type Envelope,
} from "../scripts/lib/diaria/video-cut-refine.ts";
import { mergeBuildPlan, sequenceBuiltAt } from "../scripts/video-montagem.ts";

/** Envelope de 10 ms por quadro: `floor` no silêncio, `speech` nos trechos de fala. */
const env = (sounds: Array<[number, number]>, durationS: number, floor: number, speech: number): Envelope => ({
  hopS: 0.01,
  db: Float64Array.from({ length: Math.round(durationS * 100) }, (_, i) => (sounds.some(([a, b]) => i / 100 >= a && i / 100 < b) ? speech : floor)),
});

describe("#11968: limiar relativo da banda alta", () => {
  it("bruto quente (chiado a -42 dBFS acima de 3 kHz): as pausas continuam sendo achadas", () => {
    // Fala em 0-2, 3-5, 6-8 s; pausas de 1 s com chiado a -42 dBFS.
    const hot = env([[0, 2], [3, 5], [6, 8]], 9, -42, -20);
    // Antes do #11968: o -51 fixo não acha pausa nenhuma.
    assert.deepEqual(highBandSilences(hot, SIBILANTS.thresholdDb), [], "pré-condição: o limiar fixo zera");
    const t = highBandThresholdDb(hot);
    assert.equal(t.how, "relative");
    assert.ok(t.thresholdDb > -42 && t.thresholdDb < -20, `limiar ${t.thresholdDb} entre o chiado e a fala`);
    const quiet = highBandSilences(hot);
    assert.equal(quiet.length, 3, "as 3 pausas (2-3, 5-6, 8-9 s)");
    // A interseção com o grave não zera mais o silences.json.
    const low = [{ start: 2, end: 3 }, { start: 5, end: 6 }, { start: 8, end: 9 }];
    assert.equal(intersectSilences(low, quiet).length, 3);
  });

  it("bruto limpo da 261103 (piso -63): o limiar segue o -51 do #11940", () => {
    const clean = env([[0.9, 2.34]], 3, -63, -48);
    assert.deepEqual(highBandThresholdDb(clean).thresholdDb, -51);
    assert.equal(highBandThresholdDb(clean).how, "fixed");
  });

  it("o limiar nunca alcança a fala, mesmo com poucas pausas", () => {
    // Fala quase contínua: o limiar não sobe até a mediana.
    const busy = env([[0, 1], [1.04, 3]], 3, -63, -48);
    assert.deepEqual(highBandSilences(busy), []);
    const hiss = env([[0, 6]], 10, -40, -36);
    const t = highBandThresholdDb(hiss);
    assert.ok(t.thresholdDb < -36, `limiar ${t.thresholdDb} abaixo da fala`);
  });

  it("envelope chapado (piso colado na fala) não vira tudo silêncio", () => {
    const flat = env([], 5, -40, -40);
    assert.equal(highBandThresholdDb(flat).thresholdDb, -51);
    assert.deepEqual(highBandSilences(flat), []);
  });

  it("silêncio digital (-120) não conta como piso", () => {
    const e = env([[0, 2], [3, 5]], 6, -42, -20);
    for (let i = 0; i < 20; i++) e.db[i] = -120;
    assert.equal(highBandThresholdDb(e).how, "relative");
  });

  it("aviso quando a interseção tira mais da metade das pausas do grave", () => {
    const low = [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 6 }, { start: 7, end: 8 }];
    const t = { thresholdDb: -51, how: "fixed" as const, floorDb: -45 };
    assert.match(intersectionLossWarning(low, [], 0.3, t) ?? "", /0 de 4 pausas.*#11968/);
    assert.match(intersectionLossWarning(low, [low[0]], 0.3, t) ?? "", /1 de 4/);
    assert.equal(intersectionLossWarning(low, low.slice(0, 2), 0.3, t), null);
    assert.equal(intersectionLossWarning([], [], 0.3, t), null);
  });
});

describe("#11968: expansão de sibilante não desfaz o trim de som fora do roteiro", () => {
  it("hesitação ouvida só na retranscrição, cortada pela passada B, não reentra", () => {
    // Bruto: "é" (hesitação, 0,50-0,70 s) que o transcript principal omitiu,
    // 40 ms de silêncio (curto demais para a banda alta) e o roteiro
    // "modelo novo" a partir de 0,74 s. O ar seguro mais perto da entrada é
    // ANTES da hesitação (0-0,5 s).
    const high = env([[0.5, 0.7], [0.74, 2.5]], 3, -63, -40);
    const words = [{ start: 0.74, end: 1.4, text: "modelo" }, { start: 1.5, end: 2.4, text: "novo" }];
    const heard = [{ start: 0.5, end: 0.7, text: "é" }, ...words];
    const raw = [{ block: "comentario" as const, srcIn: 0.45, srcOut: 2.6, script: "modelo novo" }];
    const windows = edgeWindowsFor(raw[0], 3);
    const heardMap = new Map(windows.map((w) => [w.key, heard]));
    const trimmed = trimEdgeExtras(raw, heardMap, words, high, { thresholdDb: -51, durationS: 3 });
    assert.ok(trimmed.clips[0].srcIn >= 0.69, `pré-condição: o trim tirou a hesitação (entrada em ${trimmed.clips[0].srcIn})`);
    const clip = trimmed.clips;
    const heardPerClip = [windows.flatMap((w) => heardMap.get(w.key) ?? [])];
    const before = preserveSibilants(clip, high, words, 3);
    assert.ok(before.clips[0].srcIn < 0.7, "pré-condição: sem as palavras ouvidas, a expansão volta até a hesitação");
    const after = preserveSibilants(clip, high, words, 3, undefined, heardPerClip);
    assert.ok(after.clips[0].srcIn >= 0.69, `com as palavras ouvidas, a entrada fica depois da hesitação (${after.clips[0].srcIn})`);
  });
});

describe("#11969: build --seq só muda no plan.json a sequência reconstruída", () => {
  type P = Parameters<typeof mergeBuildPlan>[0]["next"]["plans"][number];
  const plan = (target: string, tag: string, height = 1080, width = 1920): P =>
    ({ spec: { name: `${target}-${tag}`, target, width, height }, clips: [], durationFrames: 0, missingBlocks: [], dropped: [], script: tag } as unknown as P);
  const base = { edition: "261103", source: {} as never, framing: {} as never, framingAssumed: false };

  it("mesmas entradas: a vertical fica como o build anterior a gravou, com o instante dele", () => {
    const prev = {
      ...base,
      hash: "H",
      plans: [plan("youtube", "v1"), plan("outras-redes", "v1", 1920, 1080)],
      builtAt: { youtube: 100, "outras-redes": 100 },
      cutRefine: { applied: true, highBandWarnings: { youtube: ["y-old"], "outras-redes": ["v-old"] } },
    };
    const next = { ...base, hash: "H", plans: [plan("youtube", "v2"), plan("outras-redes", "v2", 1920, 1080)], cutRefine: { applied: true, highBandWarnings: { youtube: ["y-new"], "outras-redes": ["v-new"] } } };
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 500 });
    assert.deepEqual(r.plan.plans.map((p) => p.spec.name), ["youtube-v2", "outras-redes-v1"]);
    assert.deepEqual(r.plan.builtAt, { youtube: 500, "outras-redes": 100 });
    assert.deepEqual(r.plan.cutRefine?.highBandWarnings, { youtube: ["y-new"], "outras-redes": ["v-old"] });
    assert.deepEqual(r.kept, ["outras-redes"]);
    assert.deepEqual(r.dropped, []);
  });

  it("cenário A: blocks.json mudou e build --seq youtube não grava a vertical nova (cujo XML é o antigo)", () => {
    const prev = { ...base, hash: "OLD", plans: [plan("youtube", "v1"), plan("outras-redes", "v1", 1920, 1080)], builtAt: { youtube: 100, "outras-redes": 100 } };
    const next = { ...base, hash: "NEW", plans: [plan("youtube", "v2"), plan("outras-redes", "v2", 1920, 1080)] };
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 500 });
    // #12968: a vertical fica com o plano antigo (o do XML dela), marcada como defasada; srt/preview dela recusam pelo loadPlan.
    assert.deepEqual(r.plan.plans.map((p) => p.spec.name), ["youtube-v2", "outras-redes-v1"], "a vertical sem XML novo não entra com o plano novo");
    assert.deepEqual(r.stale, ["outras-redes"]);
    assert.deepEqual(r.plan.stale, { "outras-redes": { hash: "OLD" } });
    assert.deepEqual(r.dropped, []);
    assert.equal(r.plan.hash, "NEW");
  });

  it("sem --seq (todas escolhidas) é o plano novo inteiro", () => {
    const next = { ...base, hash: "H", plans: [plan("youtube", "v2"), plan("outras-redes", "v2", 1920, 1080)] };
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube", "outras-redes"]), prev: null, now: 7 });
    assert.deepEqual(r.plan.plans.map((p) => p.spec.name), ["youtube-v2", "outras-redes-v2"]);
    assert.deepEqual(r.plan.builtAt, { youtube: 7, "outras-redes": 7 });
  });

  it("guarda de mtime confere contra o build da sequência, não o mtime do plan.json", () => {
    assert.equal(sequenceBuiltAt({ builtAt: { "outras-redes": 100 } }, "outras-redes", 999), 100);
    assert.equal(sequenceBuiltAt({}, "outras-redes", 999), 999, "plano anterior ao #11969: mtime do plan.json");
    assert.equal(sequenceBuiltAt({ builtAt: { "outras-redes": 0 } }, "outras-redes", 999), 999);
  });
});
