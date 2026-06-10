import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apportion, stratify, planWeeks, SENDS, type Tier } from "../scripts/clarice-build-edition-sends.ts";

describe("SENDS (plano dos 21 envios)", () => {
  it("21 envios, 7 por semana, totais por semana corretos", () => {
    assert.equal(SENDS.length, 21);
    const wk = (w: number) => SENDS.filter((s) => s.week === w);
    assert.equal(wk(1).length, 7);
    assert.equal(wk(2).length, 7);
    assert.equal(wk(3).length, 7);
    const sum = (w: number) => wk(w).reduce((a, s) => a + s.volume, 0);
    assert.equal(sum(1), 5600);
    assert.equal(sum(2), 13300);
    assert.equal(sum(3), 21100);
    assert.equal(SENDS.reduce((a, s) => a + s.volume, 0), 40000);
  });

  it("cada dia da semana cai exatamente 3x (1 por semana) — desenho de blocos", () => {
    const byDay: Record<string, number> = {};
    for (const s of SENDS) byDay[s.day] = (byDay[s.day] ?? 0) + 1;
    assert.deepEqual(
      Object.fromEntries(Object.entries(byDay).sort()),
      { dom: 3, qua: 3, qui: 3, sab: 3, seg: 3, sex: 3, ter: 3 },
    );
  });

  it("volume é monotônico crescente (warm-up sem pico)", () => {
    for (let i = 1; i < SENDS.length; i++) {
      assert.ok(SENDS[i].volume >= SENDS[i - 1].volume, `envio ${i + 1} < anterior`);
    }
  });
});

describe("apportion (maior-resto)", () => {
  it("soma sempre = total", () => {
    assert.equal(apportion(10, [0.5, 0.5]).reduce((a, b) => a + b, 0), 10);
    assert.equal(apportion(1149, [0.3, 0.3, 0.4]).reduce((a, b) => a + b, 0), 1149);
    assert.equal(apportion(7, [1 / 3, 1 / 3, 1 / 3]).reduce((a, b) => a + b, 0), 7);
  });
  it("proporção exata quando divide certinho", () => {
    assert.deepEqual(apportion(10, [0.7, 0.3]), [7, 3]);
    assert.deepEqual(apportion(100, [0.5, 0.25, 0.25]), [50, 25, 25]);
  });
  it("total 0 -> tudo 0", () => {
    assert.deepEqual(apportion(0, [0.5, 0.5]), [0, 0]);
  });
});

describe("stratify (espalha cada balde pela faixa de recência)", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));

  it("respeita as capacidades e não perde/duplica linha", () => {
    const out = stratify(rows, [3, 7]);
    assert.equal(out[0].length, 3);
    assert.equal(out[1].length, 7);
    const all = [...out[0], ...out[1]].map((r) => r.id).sort((a, b) => +a - +b);
    assert.deepEqual(all, rows.map((r) => r.id));
  });

  it("espalha (não pega bloco contíguo): caps [5,5] -> pares/ímpares", () => {
    const out = stratify(rows, [5, 5]);
    assert.deepEqual(out[0].map((r) => r.id), ["0", "2", "4", "6", "8"]);
    assert.deepEqual(out[1].map((r) => r.id), ["1", "3", "5", "7", "9"]);
  });

  it("rows vazio -> baldes vazios", () => {
    assert.deepEqual(stratify([], [0, 0]), [[], []]);
  });
});

describe("planWeeks (fill morno->frio data-driven)", () => {
  const sizes: Record<Tier, number> = {
    "T1-abriu": 176,
    "T1-nao-abriu": 911,
    maio: 3619,
    T2: 6840,
    T3: 11903,
    T4: 19494,
  };

  it("deriva os segmentos por semana a partir dos tamanhos reais", () => {
    const plans = planWeeks(sizes);
    const seg = (w: number, t: Tier) =>
      plans.find((p) => p.week === w)!.segments.find((s) => s.tier === t)?.count ?? 0;
    // S1: T1 inteiro + maio inteiro + topo T2 p/ fechar 5.600
    assert.equal(seg(1, "T1-abriu"), 176);
    assert.equal(seg(1, "T1-nao-abriu"), 911);
    assert.equal(seg(1, "maio"), 3619);
    assert.equal(seg(1, "T2"), 894);
    // S2: resto T2 + topo T3
    assert.equal(seg(2, "T2"), 5946);
    assert.equal(seg(2, "T3"), 7354);
    // S3: resto T3 + topo T4
    assert.equal(seg(3, "T3"), 4549);
    assert.equal(seg(3, "T4"), 16551);
  });

  it("cada semana soma o volume planejado", () => {
    for (const p of planWeeks(sizes)) {
      assert.equal(
        p.segments.reduce((a, s) => a + s.count, 0),
        p.total,
        `semana ${p.week}`,
      );
    }
  });

  it("soma global = 40.000", () => {
    const total = planWeeks(sizes)
      .flatMap((p) => p.segments)
      .reduce((a, s) => a + s.count, 0);
    assert.equal(total, 40000);
  });

  it("explode se um tier não tem volume suficiente p/ a semana pedida", () => {
    assert.throws(() => planWeeks({ ...sizes, T4: 100 }, [3]), /T4 insuficiente/);
    assert.throws(() => planWeeks({ ...sizes, T3: 5000 }, [2]), /T3 insuficiente/);
  });

  it("--weeks parcial valida só as semanas pedidas (S1 antes do MV de T3/T4)", () => {
    // T3/T4 = 0 (não verificados ainda) não deve impedir a semana 1.
    const plans = planWeeks({ ...sizes, T3: 0, T4: 0 }, [1]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].week, 1);
  });
});
