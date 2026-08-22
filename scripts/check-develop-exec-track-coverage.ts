#!/usr/bin/env npx tsx
/**
 * check-develop-exec-track-coverage.ts (#5907 item 1/a)
 *
 * CLI do gate de cobertura de `exec_track_painel` — ver
 * `scripts/lib/develop-exec-track-coverage.ts` para a lógica pura e a
 * história do gap (passo 6a da Fase 0 que estourou timeout na 260821c e
 * nunca rodou; nada obrigava). Este arquivo é só o ponto de entrada de
 * linha de comando, mesmo padrão de
 * `scripts/check-develop-target-set-coverage.ts`.
 *
 * Roda na Fase 2 de `.claude/skills/diaria-develop/SKILL.md`, na sequência
 * dos gates pré-relatório. `exit 1` = alguma entrada de `issues[]` está sem
 * `exec_track_painel` (o 6a não rodou pra ela) ou com valor fora do enum de
 * 5 tracks (typo = classificação que nenhum consumidor reconhece).
 *
 * Remediation determinística: pra cada número listado, rodar
 * `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`) e gravar o valor
 * em `issues[]` — backfill mecânico, sem julgamento.
 *
 * Uso:
 *   npx tsx scripts/check-develop-exec-track-coverage.ts --plan data/develop/260821c/plan.json
 *
 * @see scripts/lib/develop-exec-track-coverage.ts
 */

import { existsSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  checkExecTrackCoverage,
  EXEC_TRACK_VALUES,
} from "./lib/develop-exec-track-coverage.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-develop-exec-track-coverage] uso: --plan {path}");
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-develop-exec-track-coverage] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  const result = checkExecTrackCoverage(planPath);
  if (result.status === "ok") {
    console.log("ok — toda entrada de issues[] tem exec_track_painel com valor válido");
    process.exit(0);
  }

  if (result.status === "missing") {
    const list = result.numbers.map((n) => `#${n}`).join(", ");
    console.error(
      `[check-develop-exec-track-coverage] entrada(s) de issues[] sem exec_track_painel (passo 6a da Fase 0 não rodou pra elas): ${list}`,
    );
  } else {
    const list = result.entries.map((e) => `#${e.number} (valor: "${e.value}")`).join(", ");
    console.error(
      `[check-develop-exec-track-coverage] exec_track_painel fora do enum de 5 tracks: ${list}`,
    );
  }
  console.error(
    `  → pra cada número, rodar classifyExecTrack (scripts/lib/issue-exec-track.ts) e gravar o valor em issues[].exec_track_painel — backfill mecânico, sem julgamento. Valores válidos: ${EXEC_TRACK_VALUES.join(", ")}.`,
  );
  process.exit(1);
}
