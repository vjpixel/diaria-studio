#!/usr/bin/env npx tsx
/**
 * scripts/check-calibration-regression.ts (#7978, Camada 5 da #7972,
 * ponto 8: monitoramento pós-merge)
 *
 * Roda DEPOIS que uma calibração de verdade foi mergeada — nunca antes.
 * Dois sinais independentes, nenhum decide sozinho:
 *
 * 1. **Suíte de testes completa** (`npx tsx scripts/run-tests.ts`) — não
 *    só o teste da feature que disparou a calibração; uma calibração de
 *    peso pode ter efeito colateral em qualquer teste que dependa do
 *    rubrico do scorer (ex: fixtures de `test/calibration-power-report.test.ts`
 *    que hardcodam o valor antigo).
 * 2. **Contra-sinal de leitor** (`scripts/lib/calibration-reader-signal.ts`)
 *    — CTR real médio na janela antes/depois de `--applied-at`, via
 *    `data/link-ctr-table.csv`.
 *
 * **PENDÊNCIA NOMEADA (#7978):** o gatilho de auto-revert descrito no
 * design original ("se a issue P1 não for reconhecida em 3 edições,
 * revert-calibration.ts dispara automaticamente") precisa de estado
 * PERSISTIDO entre rodadas (contar "3 edições consecutivas sem
 * reconhecimento" exige lembrar rodadas anteriores) — este script hoje
 * roda STATELESS, uma leitura por invocação, e só REPORTA o veredito de
 * cada sinal; não conta rodadas nem decide sozinho quando acionar
 * `revert-calibration.ts`. Nenhuma calibração real passou por este
 * mecanismo ainda pra justificar desenhar o armazenamento de estado sem
 * dado real pra validar o formato — implementar quando a 1ª calibração
 * real (#7990 em diante) chegar a este ponto.
 *
 * Uso:
 *   npx tsx scripts/check-calibration-regression.ts --applied-at 2026-09-11 [--editions-dir DIR] [--skip-tests]
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import Papa from "papaparse";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { computeReaderSignalDelta, isReaderRegression, type CtrRow, type ReaderSignalDelta } from "./lib/calibration-reader-signal.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface RegressionCheckResult {
  tests: { ran: boolean; passed: boolean | null; summary: string };
  reader_signal: ReaderSignalDelta | null;
  reader_regression: boolean;
}

export function loadCtrRows(csvPath: string): CtrRow[] {
  if (!existsSync(csvPath)) return [];
  const csv = readFileSync(csvPath, "utf8");
  const { data } = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  return data.map((rec) => ({
    date: (rec.date ?? "").trim(),
    unique_opens: Number.parseInt(rec.unique_opens ?? "0", 10) || 0,
    unique_verified_clicks: Number.parseInt(rec.unique_verified_clicks ?? "0", 10) || 0,
  }));
}

export function runFullTestSuite(cwd: string): { ran: boolean; passed: boolean | null; summary: string } {
  const r = spawnSync("npx", ["tsx", "scripts/run-tests.ts"], { cwd, encoding: "utf8" });
  if (r.error) {
    return { ran: false, passed: null, summary: `INFRA: não foi possível rodar a suíte de testes: ${r.error.message}` };
  }
  return { ran: true, passed: r.status === 0, summary: r.status === 0 ? "suíte completa verde" : `suíte completa com falha(s), exit ${r.status}` };
}

export function evaluateCalibrationRegression(ctrRows: CtrRow[], appliedAtIso: string, testsResult: { ran: boolean; passed: boolean | null; summary: string }): RegressionCheckResult {
  const readerSignal = ctrRows.length > 0 ? computeReaderSignalDelta(ctrRows, appliedAtIso) : null;
  return {
    tests: testsResult,
    reader_signal: readerSignal,
    reader_regression: readerSignal !== null ? isReaderRegression(readerSignal) : false,
  };
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const appliedAt = values["applied-at"];
  if (!appliedAt) {
    console.error("Uso: check-calibration-regression.ts --applied-at YYYY-MM-DD [--editions-dir DIR] [--skip-tests]");
    process.exit(2);
  }

  const testsResult = flags.has("skip-tests")
    ? { ran: false, passed: null, summary: "pulado via --skip-tests (uso: iteração local rápida, nunca em monitoramento real)" }
    : runFullTestSuite(ROOT);

  const ctrRows = loadCtrRows(resolve(ROOT, "data", "link-ctr-table.csv"));
  const result = evaluateCalibrationRegression(ctrRows, appliedAt, testsResult);

  console.log(`[check-calibration-regression] aplicada em ${appliedAt}`);
  console.log(`  testes: ${result.tests.summary}`);
  if (result.reader_signal) {
    const rs = result.reader_signal;
    console.log(
      `  CTR médio antes=${rs.before.avg_ctr_pct?.toFixed(2) ?? "n/d"}% (${rs.before.row_count} linhas) depois=${rs.after.avg_ctr_pct?.toFixed(2) ?? "n/d"}% (${rs.after.row_count} linhas) delta=${rs.delta_pp?.toFixed(2) ?? "n/d"}pp`,
    );
  } else {
    console.log("  CTR: sem dado suficiente em data/link-ctr-table.csv pra calcular o sinal");
  }
  console.log(`  regressão de leitor: ${result.reader_regression ? "SIM (≥1pp de queda) — revisar manualmente antes de considerar revert-calibration.ts" : "não detectada"}`);
  console.log("  Ver docstring deste script — o gatilho de auto-revert por '3 edições sem reconhecimento' é pendência nomeada, não implementada.");

  const failed = result.tests.passed === false || result.reader_regression;
  process.exit(failed ? 1 : 0);
}
