/**
 * test/calibration-reader-signal.test.ts (#7978)
 *
 * Cobre scripts/lib/calibration-reader-signal.ts — contra-sinal de CTR
 * real antes/depois de uma data de aplicação.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeReaderSignalDelta, isReaderRegression, READER_REGRESSION_THRESHOLD_PP, type CtrRow } from "../scripts/lib/calibration-reader-signal.ts";

function row(date: string, opens: number, clicks: number): CtrRow {
  return { date, unique_opens: opens, unique_verified_clicks: clicks };
}

describe("computeReaderSignalDelta (#7978)", () => {
  it("CTR estável antes/depois: delta perto de 0", () => {
    const rows = [row("2026-09-01", 100, 5), row("2026-09-10", 100, 5)];
    const delta = computeReaderSignalDelta(rows, "2026-09-05", 7);
    assert.equal(delta.before.avg_ctr_pct, 5);
    assert.equal(delta.after.avg_ctr_pct, 5);
    assert.equal(delta.delta_pp, 0);
  });

  it("CTR cai depois da data aplicada: delta negativo", () => {
    const rows = [row("2026-09-01", 100, 10), row("2026-09-10", 100, 2)];
    const delta = computeReaderSignalDelta(rows, "2026-09-05", 7);
    assert.equal(delta.before.avg_ctr_pct, 10);
    assert.equal(delta.after.avg_ctr_pct, 2);
    assert.equal(delta.delta_pp, -8);
  });

  it("linha no dia exato de appliedAt entra na janela DEPOIS", () => {
    const rows = [row("2026-09-05", 100, 3)];
    const delta = computeReaderSignalDelta(rows, "2026-09-05", 7);
    assert.equal(delta.after.avg_ctr_pct, 3);
    assert.equal(delta.before.avg_ctr_pct, null);
  });

  it("linha fora da janela (mais de windowDays de distância): ignorada", () => {
    const rows = [row("2026-08-01", 100, 50)]; // muito antes
    const delta = computeReaderSignalDelta(rows, "2026-09-05", 7);
    assert.equal(delta.before.avg_ctr_pct, null);
    assert.equal(delta.before.row_count, 0);
  });

  it("sem dado nenhum de um dos lados: delta_pp null, nunca fabricado", () => {
    const rows = [row("2026-09-10", 100, 5)]; // só depois
    const delta = computeReaderSignalDelta(rows, "2026-09-05", 7);
    assert.equal(delta.delta_pp, null);
  });

  it("agrega múltiplas linhas do mesmo dia (soma opens/clicks antes de dividir, não média de médias)", () => {
    const rows = [row("2026-09-10", 100, 10), row("2026-09-10", 100, 30)]; // 40/200 = 20%, não (10+30)/2%
    const delta = computeReaderSignalDelta(rows, "2026-09-05", 7);
    assert.equal(delta.after.avg_ctr_pct, 20);
  });

  it("linhas com unique_opens=0 não quebram o cálculo (0 clicks/0 opens tratado como sem dado, não NaN)", () => {
    const delta = computeReaderSignalDelta([], "2026-09-05", 7);
    assert.equal(delta.before.avg_ctr_pct, null);
    assert.equal(delta.after.avg_ctr_pct, null);
    assert.equal(delta.delta_pp, null);
  });
});

describe("isReaderRegression (#7978)", () => {
  it("delta abaixo do limiar (queda grande): true", () => {
    assert.equal(isReaderRegression({ before: { days: 7, avg_ctr_pct: 10, row_count: 1 }, after: { days: 7, avg_ctr_pct: 5, row_count: 1 }, delta_pp: -5 }), true);
  });

  it("delta exatamente no limiar: true (limiar inclusivo)", () => {
    assert.equal(
      isReaderRegression({ before: { days: 7, avg_ctr_pct: 10, row_count: 1 }, after: { days: 7, avg_ctr_pct: 10 - READER_REGRESSION_THRESHOLD_PP, row_count: 1 }, delta_pp: -READER_REGRESSION_THRESHOLD_PP }),
      true,
    );
  });

  it("delta positivo ou pequeno: false", () => {
    assert.equal(isReaderRegression({ before: { days: 7, avg_ctr_pct: 10, row_count: 1 }, after: { days: 7, avg_ctr_pct: 10.5, row_count: 1 }, delta_pp: 0.5 }), false);
  });

  it("delta_pp null (sem dado): false, nunca trata ausência como regressão", () => {
    assert.equal(isReaderRegression({ before: { days: 7, avg_ctr_pct: null, row_count: 0 }, after: { days: 7, avg_ctr_pct: null, row_count: 0 }, delta_pp: null }), false);
  });
});
