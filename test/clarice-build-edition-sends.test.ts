import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apportion, stratify, outRow, buildSends, mergeSummaryAcrossBlocks, assertCohortConsistent } from "../scripts/clarice-build-edition-sends.ts";
import type { SendsSummaryEntry } from "../scripts/lib/send-plan.ts";
import type { SendPlanEntry } from "../scripts/lib/send-plan.ts";
import type { StoreRow } from "../scripts/lib/clarice-segment.ts";
import { CLARICE_SEED_EMAIL } from "../scripts/lib/clarice-seed.ts";
import { cohortFromTier } from "../scripts/lib/cohorts.ts";

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

describe("stratify (espalha cada balde pela faixa de prioridade — genérico #2775)", () => {
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

  it("é genérica: funciona sobre StoreRow (não só Row de CSV)", () => {
    const storeRows: Pick<StoreRow, "email">[] = [{ email: "a@x.com" }, { email: "b@x.com" }];
    const out = stratify(storeRows, [1, 1]);
    assert.equal(out[0].length, 1);
    assert.equal(out[1].length, 1);
  });
});

// ---------------------------------------------------------------------------
// outRow (#2775 — StoreRow -> CSV row, substitui o outRow tier-string legado)
// ---------------------------------------------------------------------------

// #2857 fase B: cohort default derivado de tier (mesma regra do store real).
function srow(p: Partial<StoreRow> & { email: string }): StoreRow {
  const tier = p.tier ?? null;
  return {
    tier,
    cohort: cohortFromTier(tier),
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    ...p,
  };
}

describe("outRow (#2775 — deriva TIER do store, marca IS_SEED naturalmente)", () => {
  it("tier numérico vira TIER padded (T02)", () => {
    const row = outRow(srow({ email: "a@x.com", tier: 2 }), "Ana");
    assert.deepEqual(row, { email: "a@x.com", NOME: "Ana", TIER: "T02", IS_SEED: "" });
  });

  it("tier nulo -> TIER vazio (lead sem proveniência Stripe)", () => {
    const row = outRow(srow({ email: "a@x.com", tier: null }), "Ana");
    assert.equal(row.TIER, "");
  });

  it("email == CLARICE_SEED_EMAIL (case-insensitive) -> IS_SEED=true", () => {
    const row = outRow(srow({ email: CLARICE_SEED_EMAIL.toUpperCase() }), "Pixel");
    assert.equal(row.IS_SEED, "true");
  });

  it("email normal -> IS_SEED vazio (não força injeção; só marca se natural na fila)", () => {
    const row = outRow(srow({ email: "leitor@x.com" }), "Leitor");
    assert.equal(row.IS_SEED, "");
  });

  it("tier T10 pad correto (2 dígitos)", () => {
    assert.equal(outRow(srow({ email: "a@x.com", tier: 10 }), "").TIER, "T10");
  });
});

// ---------------------------------------------------------------------------
// buildSends (#2775 — núcleo puro do cutover: fila store-driven fatiada por
// bloco consecutivamente, estratificada por dia dentro do bloco)
// ---------------------------------------------------------------------------

function plan(entries: Array<Partial<SendPlanEntry> & { n: number; block: number; volume: number }>): SendPlanEntry[] {
  return entries.map((e) => ({
    date: `d${e.n}`,
    day: "qua",
    scheduledAt: "2026-06-10T09:00:00.000Z",
    ...e,
  }));
}

function queueOf(n: number, prefix = "u"): StoreRow[] {
  return Array.from({ length: n }, (_, i) => srow({ email: `${prefix}${i}@x.com` }));
}

describe("buildSends", () => {
  it("fatia a fila CONSECUTIVAMENTE por bloco (bloco 1 = topo, bloco 2 = trecho seguinte)", () => {
    const p = plan([
      { n: 1, block: 1, volume: 2 },
      { n: 2, block: 2, volume: 3 },
    ]);
    const queue = queueOf(5);
    const built = buildSends(queue, p, new Map());
    const day1 = built.find((d) => d.n === 1)!;
    const day2 = built.find((d) => d.n === 2)!;
    assert.deepEqual(day1.rows.map((r) => r.email).sort(), ["u0@x.com", "u1@x.com"]);
    assert.deepEqual(day2.rows.map((r) => r.email).sort(), ["u2@x.com", "u3@x.com", "u4@x.com"]);
    // sem overlap entre blocos
    const allEmails = built.flatMap((d) => d.rows.map((r) => r.email));
    assert.equal(new Set(allEmails).size, allEmails.length, "nenhum contato duplicado entre blocos");
  });

  it("dentro de um bloco, estratifica pelos dias proporcional ao volume (não bloco contíguo)", () => {
    const p = plan([
      { n: 1, block: 1, volume: 5 },
      { n: 2, block: 1, volume: 5 },
    ]);
    const queue = queueOf(10);
    const built = buildSends(queue, p, new Map());
    const day1 = built.find((d) => d.n === 1)!;
    const day2 = built.find((d) => d.n === 2)!;
    assert.equal(day1.rows.length, 5);
    assert.equal(day2.rows.length, 5);
    // stratify intercala (pares/ímpares) — não é um corte contíguo dos 10.
    assert.deepEqual(day1.rows.map((r) => r.email), ["u0@x.com", "u2@x.com", "u4@x.com", "u6@x.com", "u8@x.com"]);
    assert.deepEqual(day2.rows.map((r) => r.email), ["u1@x.com", "u3@x.com", "u5@x.com", "u7@x.com", "u9@x.com"]);
  });

  it("blocos processados fora de ordem no plano ainda avançam o cursor corretamente", () => {
    // Bloco 3 antes do 2 no array de entrada — planByBlock reordena por bloco ascendente.
    const p = plan([
      { n: 1, block: 1, volume: 2 },
      { n: 3, block: 3, volume: 2 },
      { n: 2, block: 2, volume: 2 },
    ]);
    const queue = queueOf(6);
    const built = buildSends(queue, p, new Map());
    const byBlock = (b: number) => built.find((d) => d.block === b)!;
    assert.deepEqual(byBlock(1).rows.map((r) => r.email), ["u0@x.com", "u1@x.com"]);
    assert.deepEqual(byBlock(2).rows.map((r) => r.email), ["u2@x.com", "u3@x.com"]);
    assert.deepEqual(byBlock(3).rows.map((r) => r.email), ["u4@x.com", "u5@x.com"]);
  });

  it("lança erro claro quando a fila não tem contatos suficientes pro plano inteiro", () => {
    const p = plan([{ n: 1, block: 1, volume: 10 }]);
    const queue = queueOf(3);
    assert.throws(() => buildSends(queue, p, new Map()), /fila de prioridade insuficiente/);
  });

  it("NOME vem de nameByEmail; string vazia quando ausente do mapa", () => {
    const p = plan([{ n: 1, block: 1, volume: 2 }]);
    const queue = queueOf(2);
    const names = new Map([["u0@x.com", "Ursula"]]);
    const built = buildSends(queue, p, names);
    const rows = built[0].rows;
    assert.equal(rows.find((r) => r.email === "u0@x.com")!.NOME, "Ursula");
    assert.equal(rows.find((r) => r.email === "u1@x.com")!.NOME, "");
  });

  it("propaga TIER (padded) e IS_SEED por row a partir do StoreRow original", () => {
    const p = plan([{ n: 1, block: 1, volume: 2 }]);
    const queue: StoreRow[] = [
      srow({ email: CLARICE_SEED_EMAIL, tier: 1 }),
      srow({ email: "leitor@x.com", tier: 3 }),
    ];
    const built = buildSends(queue, p, new Map());
    const rows = built[0].rows;
    const seedRow = rows.find((r) => r.email === CLARICE_SEED_EMAIL)!;
    assert.equal(seedRow.IS_SEED, "true");
    assert.equal(seedRow.TIER, "T01");
    const other = rows.find((r) => r.email === "leitor@x.com")!;
    assert.equal(other.IS_SEED, "");
    assert.equal(other.TIER, "T03");
  });

  it("preserva n/date/day/block/scheduledAt/volume do plano em cada BuiltDay", () => {
    const p = plan([{ n: 1, block: 1, volume: 2, date: "10jun", day: "qua", scheduledAt: "2026-06-10T09:00:00.000Z" }]);
    const built = buildSends(queueOf(2), p, new Map());
    assert.deepEqual(
      { n: built[0].n, date: built[0].date, day: built[0].day, block: built[0].block, scheduledAt: built[0].scheduledAt, volume: built[0].volume },
      { n: 1, date: "10jun", day: "qua", block: 1, scheduledAt: "2026-06-10T09:00:00.000Z", volume: 2 },
    );
  });
});

// ---------------------------------------------------------------------------
// mergeSummaryAcrossBlocks (#495/#2775 — merge cirúrgico entre invocações parciais)
// ---------------------------------------------------------------------------

function summaryEntry(p: Partial<SendsSummaryEntry> & { n: number; block: number }): SendsSummaryEntry {
  return {
    date: `d${p.n}`,
    day: "qua",
    volume: 100,
    scheduledAt: "2026-06-10T09:00:00.000Z",
    file: `d${p.n}.csv`,
    planned: 100,
    actual: 100,
    comp: {},
    ...p,
  };
}

describe("mergeSummaryAcrossBlocks", () => {
  it("sem summary prévio: usa a recomputação fresca inteira", () => {
    const fresh = [summaryEntry({ n: 1, block: 1 }), summaryEntry({ n: 2, block: 2 })];
    const merged = mergeSummaryAcrossBlocks(fresh, undefined, [1, 2]);
    assert.deepEqual(merged, fresh);
  });

  it("bloco fora de escopo preserva a entrada ANTERIOR (com listId já importado), não a fresca", () => {
    const fresh = [
      summaryEntry({ n: 1, block: 1, actual: 999 }), // recomputado (diferente do prévio) mas fora de escopo
      summaryEntry({ n: 2, block: 2, actual: 50 }),  // dentro de escopo — usa o fresco
    ];
    const prev = [
      summaryEntry({ n: 1, block: 1, actual: 100, listId: 4201 }),
      summaryEntry({ n: 2, block: 2, actual: 999, listId: 4202 }),
    ];
    const merged = mergeSummaryAcrossBlocks(fresh, prev, [2]); // só bloco 2 em escopo
    const d1 = merged.find((s) => s.n === 1)!;
    const d2 = merged.find((s) => s.n === 2)!;
    assert.equal(d1.actual, 100, "d1 (bloco 1, fora de escopo) preserva valor ANTERIOR");
    assert.equal(d1.listId, 4201, "d1 preserva listId já importado");
    assert.equal(d2.actual, 50, "d2 (bloco 2, em escopo) usa o valor FRESCO recomputado");
    assert.equal(d2.listId, undefined, "d2 fresco não tem listId (ainda não importado nesta invocação)");
  });

  it("bloco fora de escopo SEM entrada prévia correspondente cai no fresco (1ª execução daquele bloco)", () => {
    const fresh = [summaryEntry({ n: 5, block: 3, actual: 42 })];
    const merged = mergeSummaryAcrossBlocks(fresh, [], [1, 2]); // bloco 3 nunca foi processado antes
    assert.equal(merged[0].actual, 42, "sem prévio pra n=5, usa o fresco mesmo fora de --blocks");
  });
});

// ---------------------------------------------------------------------------
// assertCohortConsistent (#2851 — guard de invocações mistas do mesmo ciclo)
// ---------------------------------------------------------------------------

describe("assertCohortConsistent", () => {
  it("sem summary prévio (1ª invocação do ciclo, arquivo não existe): qualquer cohort passa, sem/com --cohort", () => {
    assert.doesNotThrow(() => assertCohortConsistent(false, undefined, null));
    assert.doesNotThrow(() => assertCohortConsistent(false, undefined, "2026-06"));
  });

  it("cohort consistente entre invocações (mesmo valor) -> ok", () => {
    assert.doesNotThrow(() => assertCohortConsistent(true, "2026-06", "2026-06"));
    assert.doesNotThrow(() => assertCohortConsistent(true, null, null));
  });

  it("cohort divergente (string != string) -> aborta com mensagem clara", () => {
    assert.throws(() => assertCohortConsistent(true, "2026-06", "2026-07"), /--cohort divergente/);
  });

  it("cohort divergente (gravado sem cohort explícito, invocação atual com --cohort) -> aborta", () => {
    // prevCohort=null (campo GRAVADO como "sem cohort", pós-#2851) != resolvedCohort="2026-06"
    assert.throws(() => assertCohortConsistent(true, null, "2026-06"), /--cohort divergente/);
  });

  it("cohort divergente (gravado com cohort, invocação atual sem --cohort) -> aborta", () => {
    assert.throws(() => assertCohortConsistent(true, "2026-06", null), /--cohort divergente/);
  });

  it("summary LEGADO (existe mas campo cohort ausente) + invocação atual SEM --cohort -> ok (retrocompat, grava null)", () => {
    assert.doesNotThrow(() => assertCohortConsistent(true, undefined, null));
  });

  it("summary LEGADO (existe mas campo cohort ausente) + invocação atual COM --cohort -> aborta (assimetria documentada)", () => {
    assert.throws(() => assertCohortConsistent(true, undefined, "2026-06"), /LEGADO/);
  });

  it("divergência esperada ao cruzar a migração #2857 (summary antigo com safra crua '2026-06' vs resolvido 'leads-2026-06') -> aborta com mensagem que explica o motivo", () => {
    // #2857 fase A trocou a coluna `cohort` de safra crua ('YYYY-MM') pro slug
    // nomeado ('leads-YYYY-MM') — resolveCohortArg() passou a devolver a forma
    // NOVA. Um sends-summary.json gravado ANTES da migração (blocos já
    // processados com a forma antiga) diverge do cohort resolvido agora, uma
    // única vez, nesse ciclo específico. O guard segue abortando (não relaxa
    // silenciosamente — o remédio continua sendo regenerar o ciclo do zero),
    // mas a mensagem precisa deixar claro que essa divergência específica é
    // conhecida/esperada, não um bug novo.
    assert.throws(
      () => assertCohortConsistent(true, "2026-06", "leads-2026-06"),
      /--cohort divergente/,
    );
    assert.throws(
      () => assertCohortConsistent(true, "2026-06", "leads-2026-06"),
      /#2857/,
      "mensagem deve citar #2857 pra explicar a divergência esperada na migração de taxonomia",
    );
  });
});
