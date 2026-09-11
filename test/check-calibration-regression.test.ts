/**
 * test/check-calibration-regression.test.ts (#7978)
 *
 * Cobre scripts/check-calibration-regression.ts::evaluateCalibrationRegression
 * e loadCtrRows — a parte determinística, sem rodar a suíte de testes real
 * nem depender do data/link-ctr-table.csv real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCalibrationRegression, loadCtrRows } from "../scripts/check-calibration-regression.ts";

describe("evaluateCalibrationRegression (#7978)", () => {
  it("testes falharam: resultado sinaliza regressão mesmo sem dado de CTR", () => {
    const result = evaluateCalibrationRegression([], "2026-09-05", { ran: true, passed: false, summary: "1 falha" });
    assert.equal(result.tests.passed, false);
    assert.equal(result.reader_signal, null);
  });

  it("testes verdes + CTR estável: sem regressão de leitor", () => {
    const rows = [
      { date: "2026-09-01", unique_opens: 100, unique_verified_clicks: 5 },
      { date: "2026-09-10", unique_opens: 100, unique_verified_clicks: 5 },
    ];
    const result = evaluateCalibrationRegression(rows, "2026-09-05", { ran: true, passed: true, summary: "ok" });
    assert.equal(result.reader_regression, false);
  });

  it("testes verdes + CTR caiu forte: regressão de leitor detectada", () => {
    const rows = [
      { date: "2026-09-01", unique_opens: 100, unique_verified_clicks: 20 },
      { date: "2026-09-10", unique_opens: 100, unique_verified_clicks: 2 },
    ];
    const result = evaluateCalibrationRegression(rows, "2026-09-05", { ran: true, passed: true, summary: "ok" });
    assert.equal(result.reader_regression, true);
  });

  it("nenhuma linha de CTR: reader_signal null, reader_regression false (nunca fabricado)", () => {
    const result = evaluateCalibrationRegression([], "2026-09-05", { ran: true, passed: true, summary: "ok" });
    assert.equal(result.reader_signal, null);
    assert.equal(result.reader_regression, false);
  });
});

describe("loadCtrRows (#7978)", () => {
  it("parseia o CSV real e extrai date/opens/clicks", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctr-csv-"));
    try {
      const csvPath = join(dir, "link-ctr-table.csv");
      writeFileSync(
        csvPath,
        "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,section,origin,enrichment_state\n" +
          "2026-09-01,Título,Seção,Leia,https://x.com,x.com,50,3,3,6.00,Outro,,BR,enriched_n\n",
        "utf8",
      );
      const rows = loadCtrRows(csvPath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].date, "2026-09-01");
      assert.equal(rows[0].unique_opens, 50);
      assert.equal(rows[0].unique_verified_clicks, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo ausente: retorna array vazio, não lança (fail-soft)", () => {
    assert.deepEqual(loadCtrRows("/caminho/que/nao/existe.csv"), []);
  });
});
