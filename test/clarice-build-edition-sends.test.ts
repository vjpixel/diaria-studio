import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Papa from "papaparse";
import {
  apportion,
  stratify,
  outRow,
  buildSends,
  mergeSummaryAcrossBlocks,
  assertCohortConsistent,
  scopedSendFileNames,
  collectPriorCycleEmails,
  excludeAlreadySentEmails,
} from "../scripts/clarice-build-edition-sends.ts";
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

// ---------------------------------------------------------------------------
// Guard anti-duplo-envio POR CICLO (#2883) — dedup por CONTEÚDO, não posição
// ---------------------------------------------------------------------------

function writeSendCsv(sendsDir: string, file: string, emails: string[]): void {
  mkdirSync(sendsDir, { recursive: true });
  const data = emails.map((email) => ({ email, NOME: "", TIER: "", IS_SEED: "" }));
  writeFileSync(resolve(sendsDir, file), Papa.unparse({ fields: ["email", "NOME", "TIER", "IS_SEED"], data }));
}

describe("scopedSendFileNames (#2883)", () => {
  it("deriva os nomes de arquivo só dos blocos em escopo, puro sobre o plano", () => {
    const p = plan([
      { n: 1, block: 1, volume: 2, date: "10jun" },
      { n: 2, block: 2, volume: 2, date: "11jun" },
      { n: 3, block: 3, volume: 2, date: "12jun" },
    ]);
    const files = scopedSendFileNames(p, [1, 3]);
    assert.deepEqual([...files].sort(), ["d01-10jun.csv", "d03-12jun.csv"]);
  });
});

describe("collectPriorCycleEmails (#2883)", () => {
  it("sendsDir inexistente -> conjunto vazio (1ª invocação do ciclo)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ces-noexist-"));
    const emails = collectPriorCycleEmails(resolve(dir, "sends"), new Set());
    assert.equal(emails.size, 0);
  });

  it("coleta emails de CSVs já escritos (waves anteriores), ignora os em escopo", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ces-collect-"));
    const sendsDir = resolve(dir, "sends");
    writeSendCsv(sendsDir, "d01-10jun.csv", ["a@x.com", "b@x.com"]);
    writeSendCsv(sendsDir, "d02-11jun.csv", ["c@x.com"]);
    // d03 está em escopo desta invocação — não deve contar como "prévio"
    // mesmo que já exista no disco (rebuild do mesmo bloco).
    writeSendCsv(sendsDir, "d03-12jun.csv", ["d@x.com"]);

    const emails = collectPriorCycleEmails(sendsDir, new Set(["d03-12jun.csv"]));
    assert.deepEqual([...emails].sort(), ["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("normaliza case (trim + lowercase) na coleta", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ces-case-"));
    const sendsDir = resolve(dir, "sends");
    writeSendCsv(sendsDir, "d01-10jun.csv", [" Fulano@X.COM "]);
    const emails = collectPriorCycleEmails(sendsDir, new Set());
    assert.ok(emails.has("fulano@x.com"));
  });

  it("ignora arquivos que não batem o padrão d{NN}-*.csv", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ces-ignore-"));
    const sendsDir = resolve(dir, "sends");
    mkdirSync(sendsDir, { recursive: true });
    writeFileSync(resolve(sendsDir, "sends-summary.json"), "{}");
    const emails = collectPriorCycleEmails(sendsDir, new Set());
    assert.equal(emails.size, 0);
  });
});

describe("excludeAlreadySentEmails (#2883)", () => {
  it("remove só os emails presentes no conjunto prévio, preserva ordem dos remanescentes", () => {
    const queue = queueOf(4); // u0..u3
    const filtered = excludeAlreadySentEmails(queue, new Set(["u1@x.com"]));
    assert.deepEqual(filtered.map((r) => r.email), ["u0@x.com", "u2@x.com", "u3@x.com"]);
  });

  it("conjunto prévio vazio -> devolve a MESMA fila (sem filtrar)", () => {
    const queue = queueOf(3);
    assert.equal(excludeAlreadySentEmails(queue, new Set()), queue);
  });
});

describe("regressão #2883 — build da wave N nunca reinclui quem já saiu em 1..N-1, mesmo com drift do store", () => {
  it("SEM o guard: drift do store causa overlap entre wave 1 (blocos 1-2) e wave 2 (blocos 3-4)", () => {
    // Universo de 20 contatos, plano de 4 blocos (2 por wave), volume 3/dia.
    const p = plan([
      { n: 1, block: 1, volume: 3 },
      { n: 2, block: 2, volume: 3 },
      { n: 3, block: 3, volume: 3 },
      { n: 4, block: 4, volume: 3 },
    ]);
    const universe = queueOf(20); // u0..u19, ordem canônica da wave 1

    // Wave 1 (blocos 1-2): consome u0-u2 (bloco1) e u3-u5 (bloco2).
    const built1 = buildSends(universe, p, new Map());
    const wave1Emails = new Set(
      built1.filter((d) => [1, 2].includes(d.block)).flatMap((d) => d.rows.map((r) => r.email)),
    );
    assert.deepEqual([...wave1Emails].sort(), ["u0@x.com", "u1@x.com", "u2@x.com", "u3@x.com", "u4@x.com", "u5@x.com"]);

    // Drift do store: sync do Brevo reordena a fila — os que ANTES estavam no
    // meio (u6..u11) agora vêm na frente (ex: viraram re-envio "engajado").
    // A fila fresca (mesmos 20 contatos, ORDEM diferente) é o que o build da
    // wave 2 leria do store sem o guard.
    const drifted = [...universe.slice(6, 12), ...universe.slice(0, 6), ...universe.slice(12)];

    // Wave 2 (blocos 3-4) SEM excluir quem já saiu — reproduz o bug #2883.
    const built2NoGuard = buildSends(drifted, p, new Map());
    const wave2EmailsNoGuard = new Set(
      built2NoGuard.filter((d) => [3, 4].includes(d.block)).flatMap((d) => d.rows.map((r) => r.email)),
    );
    const overlapNoGuard = [...wave2EmailsNoGuard].filter((e) => wave1Emails.has(e));
    assert.ok(
      overlapNoGuard.length > 0,
      "sem o guard, o drift deveria causar overlap (demonstra o bug que #2883 corrige)",
    );
  });

  it("COM o guard: build wave 1 -> mutate store (drift) -> build wave 2 -> interseção de emails é VAZIA", () => {
    const p = plan([
      { n: 1, block: 1, volume: 3 },
      { n: 2, block: 2, volume: 3 },
      { n: 3, block: 3, volume: 3 },
      { n: 4, block: 4, volume: 3 },
    ]);
    const universe = queueOf(20);
    const dir = mkdtempSync(resolve(tmpdir(), "ces-regression-"));
    const sendsDir = resolve(dir, "sends");

    // --- build wave 1 (blocos 1-2), mesma sequência de passos que main() ---
    const blocks1 = [1, 2];
    const scopeFiles1 = scopedSendFileNames(p, blocks1);
    const prior1 = collectPriorCycleEmails(sendsDir, scopeFiles1);
    assert.equal(prior1.size, 0, "1ª invocação do ciclo: nada pra deduplicar ainda");
    const dedupedQueue1 = excludeAlreadySentEmails(universe, prior1);
    const built1 = buildSends(dedupedQueue1, p, new Map());
    for (const day of built1.filter((d) => blocks1.includes(d.block))) {
      writeSendCsv(sendsDir, `d${String(day.n).padStart(2, "0")}-${day.date}.csv`, day.rows.map((r) => r.email));
    }
    const wave1Emails = new Set(
      built1.filter((d) => blocks1.includes(d.block)).flatMap((d) => d.rows.map((r) => r.email)),
    );
    assert.equal(wave1Emails.size, 6);

    // --- simula drift do store entre invocações (mesmos 20, ordem diferente) ---
    const drifted = [...universe.slice(6, 12), ...universe.slice(0, 6), ...universe.slice(12)];

    // --- build wave 2 (blocos 3-4), com o guard aplicado ---
    const blocks2 = [3, 4];
    const scopeFiles2 = scopedSendFileNames(p, blocks2);
    const prior2 = collectPriorCycleEmails(sendsDir, scopeFiles2);
    assert.deepEqual([...prior2].sort(), [...wave1Emails].sort(), "coleta exatamente os emails escritos pela wave 1");
    const dedupedQueue2 = excludeAlreadySentEmails(drifted, prior2);
    const built2 = buildSends(dedupedQueue2, p, new Map());
    const wave2Emails = new Set(
      built2.filter((d) => blocks2.includes(d.block)).flatMap((d) => d.rows.map((r) => r.email)),
    );

    const intersection = [...wave2Emails].filter((e) => wave1Emails.has(e));
    assert.deepEqual(intersection, [], "união das waves do ciclo deve ser disjunta por email, mesmo com drift");
    assert.equal(wave2Emails.size, 6, "wave 2 ainda entrega o volume completo (3+3), só que de gente NOVA");
  });
});
