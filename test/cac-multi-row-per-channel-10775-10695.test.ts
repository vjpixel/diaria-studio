/**
 * test/cac-multi-row-per-channel-10775-10695.test.ts
 *
 * #10775 — desde #10679 um canal com gasto em meses diferentes tem VÁRIAS
 * linhas `measured` em `CacReport.rows` (uma por mês). Consumidores que
 * indexavam por canal com `map.set`/atribuição ficavam só com a última linha:
 * o Meta Ads (418 cadastros em 2026-09 + 2 em 2026-10) virava "2 cadastros"
 * no ads-test-watch, e o custo por ativo do Studio saía `null` porque a linha
 * de outubro tinha 0 ativos. Contrato: agregar por canal antes de derivar.
 *
 * #10695 — o início do mês de gasto era 00:00 UTC; os meses de `spend.csv`
 * seguem o fuso da conta (BRT). Um cadastro de 30/09 às 23:30 BRT
 * (= 01/10 02:30 UTC) caía na linha de outubro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aggregateMeasuredRowsByCanal,
  buildCacReport,
  partitionChannelSubsBySpendMonth,
  spendMonthStartEpoch,
  type CacMeasuredRow,
} from "../scripts/lib/cac.ts";
import { computeApuracaoArmStats, detectZeroCadastrosAcrossArms } from "../scripts/lib/ads-test-watch.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const META = "Meta Ads (teste 2608)";

function sub(i: number, createdIso: string, overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: `leitor${i}@example.com`,
    status: "active",
    created: Date.parse(createdIso) / 1000,
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

// Coorte de setembro grande, outubro sem cadastro próprio — a forma real de
// 21/10 (R$ 1435,51 em 2026-09, R$ 8,30 em 2026-10).
const SEPT_SUBS = [1, 2, 3, 4].map((i) => sub(i, `2026-09-1${i}T12:00:00Z`));

describe("aggregateMeasuredRowsByCanal (#10775)", () => {
  it("soma gasto, cadastros, ativos e leitores das linhas do mesmo canal", () => {
    const report = buildCacReport([spend("2026-09", 1435.51), spend("2026-10", 8.3)], SEPT_SUBS);
    const measured = report.rows.filter((r): r is CacMeasuredRow => r.kind === "measured" && r.canal === META);
    assert.equal(measured.length, 2, "pré-condição: o canal tem 2 linhas");
    const totals = aggregateMeasuredRowsByCanal(report.rows).get(META);
    assert.ok(totals);
    assert.equal(totals.linhas, 2);
    assert.equal(totals.cadastros, 4);
    assert.equal(totals.ativos, measured[0].ativos + measured[1].ativos);
    assert.equal(totals.leitores, measured[0].leitores + measured[1].leitores);
    assert.ok(Math.abs(totals.gasto - 1443.81) < 1e-9);
  });
});

describe("ads-test-watch com braço de 2 linhas (#10775)", () => {
  const report = buildCacReport([spend("2026-09", 1435.51), spend("2026-10", 8.3)], SEPT_SUBS);

  it("detectZeroCadastrosAcrossArms não acusa coorte perdida quando a última linha tem 0 cadastros", () => {
    // Antes: a linha de outubro (0 cadastros) sobrescrevia a de setembro.
    assert.deepEqual(detectZeroCadastrosAcrossArms(report.rows, [META]), []);
  });

  it("computeApuracaoArmStats conta os cadastros do braço inteiro", () => {
    const [stats] = computeApuracaoArmStats(SEPT_SUBS, report.rows, [META]);
    assert.equal(stats.cadastrosRelatorio, 4);
  });
});

describe("studio-metrics agrega por canal antes do custo por ativo (#10775)", () => {
  it("o bloco LTV÷CAC passa por aggregateMeasuredRowsByCanal, sem atribuição por linha", () => {
    const src = readFileSync(new URL("../scripts/studio-ui/studio-metrics.ts", import.meta.url), "utf8");
    assert.match(src, /aggregateMeasuredRowsByCanal\(adsSnapshot\.report\.rows\)/);
    assert.doesNotMatch(src, /custoPorCanal\[row\.canal\]\s*=/);
  });
});

describe("virada do mês de gasto em BRT (#10695)", () => {
  it("início do mês = dia 1 às 00:00 BRT (03:00 UTC)", () => {
    assert.equal(spendMonthStartEpoch("2026-10"), Date.parse("2026-10-01T03:00:00Z") / 1000);
    assert.equal(spendMonthStartEpoch("jul-ago"), null);
  });

  it("cadastro de 30/09 23:30 BRT fica em setembro; 01/10 00:30 BRT vai pra outubro", () => {
    const tardio = sub(1, "2026-09-30T23:30:00-03:00");
    const cedo = sub(2, "2026-10-01T00:30:00-03:00");
    const buckets = partitionChannelSubsBySpendMonth(["2026-09", "2026-10"], [tardio, cedo]);
    assert.ok(buckets);
    assert.deepEqual(buckets[0].map((s) => s.email), [tardio.email]);
    assert.deepEqual(buckets[1].map((s) => s.email), [cedo.email]);
  });
});
