/**
 * test/cac-spend-period-partition-10679.test.ts (#10679)
 *
 * Regressão: com duas linhas de gasto do MESMO canal em meses diferentes
 * (Meta Ads (teste 2608): R$ 1435,51 em 2026-09 e R$ 8,30 em 2026-10), cada
 * linha recebia a coorte INTEIRA do canal. A linha de outubro herdava os
 * cadastros de setembro e mostrava custo por leitor de R$ 0,19 inexistente,
 * com o canal listado duas vezes com os mesmos leitores.
 *
 * Contrato: cada cadastro entra em exatamente uma linha (a do período que o
 * cobre), a soma das linhas é a coorte do canal (sem duplicar), e uma linha
 * sem cadastro próprio vai pra "sem dado", nunca pra custo quase zero.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCacReport,
  partitionChannelSubsBySpendMonth,
  type CacMeasuredRow,
} from "../scripts/lib/cac.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const META = "Meta Ads (teste 2608)";

function epoch(day: string): number {
  return Date.parse(`${day}T12:00:00Z`) / 1000;
}

function sub(i: number, created: number | undefined, overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: `leitor${i}@example.com`,
    status: "active",
    created: created as number,
    utm_source: "meta-ads",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 },
    ...overrides,
  };
}

function spend(mes: string, valor: number, canal = META): SpendRow {
  return { canal, mes, moeda: "BRL", valor, fonte: "teste" };
}

function measured(rows: readonly unknown[], mes: string, canal = META): CacMeasuredRow {
  const row = (rows as CacMeasuredRow[]).find((r) => r.kind === "measured" && r.canal === canal && r.spend.mes === mes);
  assert.ok(row, `linha ${canal} ${mes} ausente`);
  return row;
}

describe("buildCacReport — duas linhas de gasto do mesmo canal em meses diferentes (#10679)", () => {
  // 1 cadastro de agosto (antes da 1ª linha), 4 de setembro, 0 de outubro.
  const subs = [
    sub(0, epoch("2026-08-30")),
    sub(1, epoch("2026-09-05")),
    sub(2, epoch("2026-09-10")),
    sub(3, epoch("2026-09-20")),
    sub(4, epoch("2026-09-30")),
    sub(9, epoch("2026-09-15"), { utm_source: "google-ads" }),
  ];
  const report = buildCacReport([spend("2026-09", 1435.51), spend("2026-10", 8.3)], subs);

  it("a linha de outubro não herda a coorte de setembro — vai pra 'sem dado'", () => {
    const out = measured(report.rows, "2026-10");
    assert.equal(out.cadastros, 0);
    assert.equal(out.leitores, 0);
    assert.equal(out.custoPorLeitor, null);
    assert.ok(report.noDataRows.includes(out));
    assert.ok(!report.rankedRows.includes(out));
  });

  it("a linha de setembro mantém a coorte inteira (inclui o cadastro anterior ao 1º mês)", () => {
    const set = measured(report.rows, "2026-09");
    assert.equal(set.cadastros, 5);
    assert.equal(set.leitores, 5);
    assert.equal(set.custoPorLeitor, 1435.51 / 5);
  });

  it("a coorte não é duplicada — a soma das linhas do canal é a coorte do canal", () => {
    const linhas = (report.rows as CacMeasuredRow[]).filter((r) => r.kind === "measured" && r.canal === META);
    assert.equal(linhas.length, 2);
    assert.equal(
      linhas.reduce((s, r) => s + r.cadastros, 0),
      5,
    );
    assert.equal(report.rankedRows.filter((r) => r.canal === META).length, 1);
  });

  it("cadastro de outubro vai pra linha de outubro, não pra de setembro", () => {
    const r = buildCacReport(
      [spend("2026-09", 1435.51), spend("2026-10", 8.3)],
      [...subs, sub(5, epoch("2026-10-01")), sub(6, epoch("2026-11-03"))],
    );
    assert.equal(measured(r.rows, "2026-09").cadastros, 5);
    // 2026-11 não tem linha própria: fica com o período mais recente que já começou (outubro).
    assert.equal(measured(r.rows, "2026-10").cadastros, 2);
    assert.equal(measured(r.rows, "2026-10").custoPorLeitor, 8.3 / 2);
  });

  it("canal com UMA linha só continua recebendo a coorte inteira (comportamento anterior)", () => {
    const r = buildCacReport([spend("2026-09", 1435.51)], [...subs, sub(5, epoch("2026-10-01"))]);
    assert.equal(measured(r.rows, "2026-09").cadastros, 6);
  });
});

describe("partitionChannelSubsBySpendMonth (#10679)", () => {
  it("ordem das linhas no CSV não importa — atribui por cronologia", () => {
    const subs = [sub(1, epoch("2026-09-10")), sub(2, epoch("2026-10-02"))];
    const buckets = partitionChannelSubsBySpendMonth(["2026-10", "2026-09"], subs);
    assert.ok(buckets);
    assert.deepEqual(buckets[0].map((s) => s.email), ["leitor2@example.com"]);
    assert.deepEqual(buckets[1].map((s) => s.email), ["leitor1@example.com"]);
  });

  it("assinante sem `created` fica na 1ª linha cronológica (nunca descartado)", () => {
    const buckets = partitionChannelSubsBySpendMonth(["2026-10", "2026-09"], [sub(1, undefined)]);
    assert.ok(buckets);
    assert.equal(buckets[1].length, 1);
    assert.equal(buckets[0].length, 0);
  });

  it("devolve null quando o mês não é AAAA-MM ou se repete (não há período inequívoco)", () => {
    assert.equal(partitionChannelSubsBySpendMonth(["2026-09", "jul-ago"], [sub(1, epoch("2026-09-10"))]), null);
    assert.equal(partitionChannelSubsBySpendMonth(["2026-09", "2026-09"], [sub(1, epoch("2026-09-10"))]), null);
  });

  it("buildCacReport com mês não particionável mantém o comportamento antigo (coorte inteira por linha)", () => {
    const r = buildCacReport([spend("2026-09", 100), spend("acumulado", 50)], [sub(1, epoch("2026-09-10"))]);
    const linhas = (r.rows as CacMeasuredRow[]).filter((x) => x.kind === "measured" && x.canal === META);
    assert.deepEqual(
      linhas.map((x) => x.cadastros),
      [1, 1],
    );
  });
});
