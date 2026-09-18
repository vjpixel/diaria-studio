#!/usr/bin/env npx tsx
/**
 * report-stage4-timing.ts (#8123 residual)
 *
 * CLI fino sobre `scripts/lib/stage4-timing-report.ts` — lê
 * `data/run-log.jsonl` e imprime a tabela de tempo do loop "ajustar" do
 * Stage 4, que é o critério de aceite "antes/depois medido numa edição
 * real" da issue.
 *
 * Uso:
 *   npx tsx scripts/report-stage4-timing.ts                  # todas as edições
 *   npx tsx scripts/report-stage4-timing.ts --edition 260918
 *   npx tsx scripts/report-stage4-timing.ts --json
 *
 * Só LÊ. Nunca escreve no run-log nem em lugar nenhum — é relatório.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { buildStage4TimingReport, renderStage4TimingReport, type RunLogEntry } from "./lib/stage4-timing-report.ts";

/** Lê o run-log linha a linha. Linha inválida é pulada em silêncio: o
 *  arquivo é append-only e escrito por dezenas de produtores concorrentes,
 *  então uma linha meio-escrita (leitura durante um append) não pode
 *  derrubar um relatório de leitura. */
export function readRunLog(path: string): RunLogEntry[] {
  if (!existsSync(path)) return [];
  const out: RunLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RunLogEntry);
    } catch {
      // linha parcial/corrompida — ignora
    }
  }
  return out;
}

function main(): void {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const rootDir = values["root-dir"] ?? process.cwd();
  const logPath = resolve(rootDir, "data", "run-log.jsonl");
  const edition = values["edition"] ?? null;

  const report = buildStage4TimingReport(readRunLog(logPath), edition);

  if (flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderStage4TimingReport(report));
}

if (isMainModule(import.meta.url)) {
  main();
}
