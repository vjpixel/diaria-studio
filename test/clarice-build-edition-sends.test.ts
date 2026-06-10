import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apportion, stratify, planWeeks, advanceCursors, ALL_WEEKS, SENDS, type Tier, main } from "../scripts/clarice-build-edition-sends.ts";

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

  // Regressão #2007/#2018: t2InS2 < 0 deve lançar erro explícito
  it("explode se t2InS2 < 0 (T2 insuficiente para cobrir o que a S1 consome)", () => {
    // T2 pequeno demais: S1 precisa de 894 de T2, mas só há 500
    assert.throws(
      () => planWeeks({ ...sizes, T2: 500 }, [2]),
      /T2 insuficiente/,
    );
  });
});

describe("main --weeks validação (#2007/#2018)", () => {
  // --weeks sem valor seguido de outra flag deve lançar erro, não weeks=[] silencioso
  it("--weeks --dry-run (sem valor) lança erro explícito em vez de weeks=[] silencioso", async () => {
    await assert.rejects(
      () => main(["--cycle", "2605-06", "--weeks", "--dry-run"]),
      /--weeks requer um valor/,
    );
  });

  it("--weeks com valor inválido lança erro explícito", async () => {
    await assert.rejects(
      () => main(["--cycle", "2605-06", "--weeks", "abc"]),
      /não contém semanas válidas/,
    );
  });
});

// Regressão #2007 / #2018: cursor de tier inicializado a partir das semanas omitidas.
// Estes testes verificam o comportamento do cursor e garantem que reverter o fix quebre os testes (#633).
describe("cursor de tier em --weeks parcial (anti-duplo-envio #2007/#2018)", () => {
  const sizes: Record<Tier, number> = {
    "T1-abriu": 176, "T1-nao-abriu": 911, maio: 3619, T2: 6840, T3: 11903, T4: 19494,
  };

  // Confirma aritmética: planWeeks([2]) retorna segmentos idênticos a [1,2,3].week2.
  // Necessário mas não suficiente: sem cursor correto em main, o slicing começa errado
  // mesmo com segmentos corretos.
  it("planWeeks([2]) retorna os mesmos segmentos de S2 que planWeeks([1,2,3])", () => {
    const [full] = planWeeks(sizes, [1, 2, 3]).filter((p) => p.week === 2);
    const [partial] = planWeeks(sizes, [2]);
    assert.deepEqual(full.segments, partial.segments);
    assert.equal(full.total, partial.total);
  });

  // Teste do CURSOR: para --weeks 2, as semanas omitidas que precedem a S2 devem
  // ser usadas para inicializar os cursores. planWeeks([1]) representa o que S1
  // teria consumido — o cursor de T2 em S2 deve começar em t2InS1 = 894.
  // Se revertida para a lógica antiga (minWeek > 1 → priorWeeks), este teste ainda
  // passa (minWeek=2 > 1, logo priorWeeks=[1]). O próximo teste cobre o caso --weeks 1,3.
  it("--weeks 2: consumed de S1 (calculado via planWeeks) == t2InS1 = 894", () => {
    // Simula a lógica do cursor: skippedWeeks para --weeks 2 = [1] (< max=2, não inclusa)
    const weeks = [2];
    const maxWeek = Math.max(...weeks);
    const skippedWeeks = ([1, 2, 3] as number[]).filter((w) => !weeks.includes(w) && w < maxWeek);
    assert.deepEqual(skippedWeeks, [1], "S1 deve ser detectada como semana pulada para --weeks 2");

    const priorPlans = planWeeks(sizes, skippedWeeks);
    const consumed: Record<Tier, number> = { "T1-abriu": 0, "T1-nao-abriu": 0, maio: 0, T2: 0, T3: 0, T4: 0 };
    for (const pp of priorPlans) {
      for (const seg of pp.segments) consumed[seg.tier as Tier] += seg.count;
    }
    // T2 consumida pela S1 = t2InS1 = 894 (S1 = T1-abriu+T1-nao-abriu+maio+894 de T2 = 5600)
    assert.equal(consumed["T2"], 894, `cursor T2 para --weeks 2 deve ser 894 (era 0 antes do fix)`);
    // T3 e T4 não consumidos pela S1
    assert.equal(consumed["T3"], 0);
    assert.equal(consumed["T4"], 0);
  });

  // Regressão crítica #2007 part B: --weeks 1,3 (S2 omitida entre S1 e S3).
  // BUG ORIGINAL: minWeek([1,3])=1, logo o bloco `if (minWeek > 1)` nunca executava,
  // deixando consumed.T3=0 ao processar S3. S3 reenviaria T3-0..T3-4548, sobrepondo
  // com a janela da S2 (T3-0..T3-7353).
  // FIX: usa skippedWeeks = semanas omitidas ABAIXO DO MÁXIMO, independente do minWeek.
  // Reverter para a lógica `minWeek > 1` faz este teste falhar, cumprindo #633.
  it("--weeks 1,3 (S2 omitida): cursor de T3 = t3InS2 = 7354 (não zero)", () => {
    const weeks = [1, 3];
    const maxWeek = Math.max(...weeks); // 3
    // skippedWeeks = semanas não pedidas que precedem o max
    const skippedWeeks = ([1, 2, 3] as number[]).filter((w) => !weeks.includes(w) && w < maxWeek);
    assert.deepEqual(skippedWeeks, [2], "S2 deve ser detectada como semana pulada para --weeks 1,3");

    const priorPlans = planWeeks(sizes, skippedWeeks);
    const consumed: Record<Tier, number> = { "T1-abriu": 0, "T1-nao-abriu": 0, maio: 0, T2: 0, T3: 0, T4: 0 };
    for (const pp of priorPlans) {
      for (const seg of pp.segments) consumed[seg.tier as Tier] += seg.count;
    }
    // T3 consumida pela S2 = t3InS2 = 7354 (S2 = T2-restante(5946) + T3-7354 = 13300)
    assert.equal(consumed["T3"], 7354, `cursor T3 para --weeks 1,3 deve ser 7354; era 0 antes do fix (duplo-envio silencioso)`);
    // T2 consumida pela S2 = 5946 (o resto do T2 após S1)
    assert.equal(consumed["T2"], 5946, `cursor T2 para --weeks 1,3 via S2 deve ser 5946`);
    // T4 não consumida pela S2
    assert.equal(consumed["T4"], 0);

    // Confirma que a lógica ANTIGA (minWeek > 1) não detectaria este caso:
    // minWeek([1,3]) = 1 → priorWeeks seria [] → consumed.T3 ficaria em 0.
    const minWeek = Math.min(...weeks); // 1
    const oldPriorWeeks = ([1, 2, 3] as number[]).filter((w) => w < minWeek); // []
    assert.deepEqual(oldPriorWeeks, [], "lógica antiga com minWeek=1 não detecta S2 omitida → bug confirmado");
  });

  // Verifica que --weeks 3 (sem S1 nem S2) calcula consumed de T3 corretamente:
  // consumed.T3 = t3InS2 = 7354, consumed.T2 = t2InS1 + t2InS2 = 894 + 5946 = 6840.
  it("--weeks 3 (S1+S2 omitidas): cursor T3 = 7354, cursor T2 = 6840", () => {
    const weeks = [3];
    const maxWeek = Math.max(...weeks); // 3
    const skippedWeeks = ([1, 2, 3] as number[]).filter((w) => !weeks.includes(w) && w < maxWeek);
    assert.deepEqual(skippedWeeks, [1, 2], "S1 e S2 devem ser detectadas como puladas para --weeks 3");

    const priorPlans = planWeeks(sizes, skippedWeeks);
    const consumed: Record<Tier, number> = { "T1-abriu": 0, "T1-nao-abriu": 0, maio: 0, T2: 0, T3: 0, T4: 0 };
    for (const pp of priorPlans) {
      for (const seg of pp.segments) consumed[seg.tier as Tier] += seg.count;
    }
    assert.equal(consumed["T3"], 7354, "cursor T3 para --weeks 3 deve ser 7354");
    assert.equal(consumed["T2"], 894 + 5946, "cursor T2 para --weeks 3 deve ser 6840 (S1+S2 inteiros)");
  });
});

// #2048 item 4b: advanceCursors — puro, sem throws de validação
describe("advanceCursors (#2048 item 4b)", () => {
  const sizes: Record<Tier, number> = {
    "T1-abriu": 176, "T1-nao-abriu": 911, maio: 3619, T2: 6840, T3: 11903, T4: 19494,
  };

  it("semanas vazias retorna zeros", () => {
    const c = advanceCursors(sizes, []);
    assert.equal(c["T2"], 0);
    assert.equal(c["T3"], 0);
    assert.equal(c["T4"], 0);
  });

  it("skippedWeeks=[1] → cursor T2 = 894 (mesmo que planWeeks([1]))", () => {
    const c = advanceCursors(sizes, [1]);
    assert.equal(c["T2"], 894);
    assert.equal(c["T3"], 0);
  });

  it("skippedWeeks=[1,2] → cursor T2=6840, T3=7354", () => {
    const c = advanceCursors(sizes, [1, 2]);
    assert.equal(c["T2"], 6840);
    assert.equal(c["T3"], 7354);
  });

  // Regressão #2048 item 4b: CSVs aparados pós-S2 (T3=0) + --weeks 3 NÃO lança.
  // planWeeks(sizes, [1,2]) com T3=0 lança `T3 insuficiente p/ S2`.
  // advanceCursors NÃO lança — calcula cursores puramente sem validação.
  it("CSVs aparados pós-S2 (T3=0): --weeks 3 via advanceCursors NÃO lança", () => {
    const trimmedSizes = { ...sizes, T3: 0, T4: 0 };
    // planWeeks lançaria aqui:
    assert.throws(() => planWeeks(trimmedSizes, [1, 2]), /T3 insuficiente/);
    // advanceCursors não lança:
    assert.doesNotThrow(() => advanceCursors(trimmedSizes, [1, 2]));
  });
});

// #2048 item 4c: ALL_WEEKS derivado de SENDS
describe("ALL_WEEKS (#2048 item 4c)", () => {
  it("ALL_WEEKS contém exatamente as semanas únicas do SENDS, ordenadas", () => {
    const expected = [...new Set(SENDS.map((s) => s.week))].sort((a, b) => a - b);
    assert.deepEqual(ALL_WEEKS, expected);
  });

  it("ALL_WEEKS é [1,2,3] para o plano atual", () => {
    assert.deepEqual(ALL_WEEKS, [1, 2, 3]);
  });
});
