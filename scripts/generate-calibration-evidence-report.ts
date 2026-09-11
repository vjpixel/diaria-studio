#!/usr/bin/env npx tsx
/**
 * scripts/generate-calibration-evidence-report.ts (#7978, Camada 5 da #7972)
 *
 * CLI fina sobre `scripts/lib/calibration-evidence-report.ts`. Lê um JSON
 * de input (`CalibrationEvidenceInput`) de disco, grava o markdown
 * renderizado em `data/reports/calibration/{feature}-{sessionId}.md`, e
 * registra a entrada em `data/reports/index.jsonl` (kind "calibration",
 * mesmo mecanismo de `register-report.ts`) — pra ficar visível na
 * superfície de Relatórios do Studio junto com overnight/develop.
 *
 * Quem monta o JSON de input é quem tem o contexto de qual calibração está
 * sendo proposta — tipicamente `calibrate-scoring-weights.ts` (#7990,
 * ainda não implementado) ou uma sessão que revisou
 * `calibration-power-report.ts`/`shadow-validation-report.ts` manualmente.
 * Este script NUNCA decide se uma calibração deve acontecer — só formata
 * o relatório de evidência de uma decisão já tomada.
 *
 * Uso:
 *   npx tsx scripts/generate-calibration-evidence-report.ts \
 *     --input path/pra/evidence-input.json --pr-number 8010
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { renderCalibrationEvidenceReport, type CalibrationEvidenceInput } from "./lib/calibration-evidence-report.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(import.meta.dirname, "..");

export function generate(rootDir: string, input: CalibrationEvidenceInput, prNumber: string): { markdown: string; outPath: string } {
  const markdown = renderCalibrationEvidenceReport(input);
  const outDir = resolve(rootDir, "data", "reports", "calibration");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${input.feature}-${prNumber}.md`);
  writeFileSync(outPath, markdown, "utf8");
  return { markdown, outPath: `data/reports/calibration/${input.feature}-${prNumber}.md` };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const inputPath = values["input"];
  const prNumber = values["pr-number"];

  if (!inputPath || !prNumber) {
    console.error("Uso: generate-calibration-evidence-report.ts --input <path.json> --pr-number <N>");
    process.exit(2);
  }
  const absInputPath = resolve(process.cwd(), inputPath);
  if (!existsSync(absInputPath)) {
    console.error(`Arquivo de input não encontrado: ${absInputPath}`);
    process.exit(2);
  }

  let input: CalibrationEvidenceInput;
  try {
    input = JSON.parse(readFileSync(absInputPath, "utf8"));
  } catch (err) {
    console.error(`Input não é JSON válido: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
    throw err;
  }

  let result: { markdown: string; outPath: string };
  try {
    result = generate(ROOT, input, prNumber);
  } catch (err) {
    console.error(`[#7978] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
    throw err;
  }

  const registerResult = registerReport(
    ROOT,
    { kind: "calibration", sessionId: prNumber, title: `Calibração ${input.feature} — PR #${prNumber}`, htmlPath: result.outPath },
    undefined,
    false, // calibração nunca dispara e-mail automático — o sinal certo é a label de sign-off na PR, não um e-mail
  );
  if (!registerResult.ok) {
    console.error(`[#7978] registro em data/reports/index.jsonl falhou (fail-soft, relatório já foi escrito em disco): ${registerResult.error}`);
  }

  console.log(result.outPath);
  console.log("");
  console.log(result.markdown);
}
