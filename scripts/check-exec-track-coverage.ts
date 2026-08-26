#!/usr/bin/env npx tsx
/**
 * check-exec-track-coverage.ts (#6204 item 1 — generaliza #5907 item 1/a)
 *
 * CLI genérico do gate de cobertura de `exec_track_painel` — a lógica pura
 * mora em `scripts/lib/develop-exec-track-coverage.ts` (o nome do arquivo
 * de lib é histórico, herdado de quando só o `/diaria-develop` chamava
 * `classifyExecTrack` por issue no `plan.json`; a lógica em si sempre foi
 * genérica sobre `{ issues: [...] }`, sem nada específico de develop —
 * `checkExecTrackCoverageFromPlan` não olha pra nenhum campo exclusivo de
 * develop).
 *
 * Este CLI existe pra dar ao `/diaria-overnight` (Fase 0 passo 4a) e ao
 * `/diaria-continuo` (passo 3) o MESMO gate mecânico que o
 * `/diaria-develop` já tinha desde #5907 — sem duplicar a lógica pura, só
 * o ponto de entrada. `scripts/check-develop-exec-track-coverage.ts`
 * continua existindo e é quem a Fase 2 do develop chama (mudar o call site
 * dele não é escopo aqui); este arquivo é usado por overnight/continuo, que
 * nunca tiveram o gate antes.
 *
 * Uso (idêntico ao irmão específico do develop):
 *   npx tsx scripts/check-exec-track-coverage.ts --plan data/overnight/260826/plan.json
 *   npx tsx scripts/check-exec-track-coverage.ts --plan data/continuo/260826/plan.json
 *
 * `exit 1` = alguma entrada de `issues[]` está sem `exec_track_painel`
 * (a classificação de `classifyExecTrack` não rodou pra ela ainda) ou com
 * valor fora do enum de 6 tracks (`overnight|develop|agendada|bloqueada|
 * epica|fora-de-rodada`). Remediation determinística: pra cada número
 * listado, rodar `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`)
 * sobre `{ labels, body, state }` já em mãos e gravar o valor.
 *
 * @see scripts/lib/develop-exec-track-coverage.ts (lógica pura, compartilhada)
 * @see scripts/check-develop-exec-track-coverage.ts (CLI irmão, específico do develop)
 * @see scripts/lib/overnight-prose-track-map.ts (tradução prosa↔ExecTrack, #6204 item 3)
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
    console.error("[check-exec-track-coverage] uso: --plan {path}");
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-exec-track-coverage] plan.json não encontrado: ${planPath}`);
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
      `[check-exec-track-coverage] entrada(s) de issues[] sem exec_track_painel: ${list}`,
    );
  } else {
    const list = result.entries.map((e) => `#${e.number} (valor: "${e.value}")`).join(", ");
    console.error(
      `[check-exec-track-coverage] exec_track_painel fora do enum de tracks: ${list}`,
    );
  }
  console.error(
    `  → pra cada número, rodar classifyExecTrack (scripts/lib/issue-exec-track.ts) e gravar o valor em issues[].exec_track_painel — backfill mecânico, sem julgamento. Valores válidos: ${EXEC_TRACK_VALUES.join(", ")}.`,
  );
  process.exit(1);
}
