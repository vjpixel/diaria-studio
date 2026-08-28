#!/usr/bin/env npx tsx
/**
 * check-overnight-plan-motivo.ts (#6438)
 *
 * CLI do gate de "motivo fora do vocabulário fechado" para o plan.json do
 * `/diaria-overnight` — espelha `scripts/validate-develop-plan-motivo.ts`
 * (#5708). Ver `scripts/lib/overnight-plan-motivo.ts` para a lógica
 * pura/documentação completa.
 *
 * `exit 1` = pelo menos uma issue `pulada` tem `motivo` fora do vocabulário
 * fechado (ou ausente). Remediation: reclassificar num motivo real do
 * vocabulário, ou — se o motivo descreve algo genuinamente novo — abrir
 * issue pra fechar o vocabulário (mesmo padrão que originou este próprio
 * gate, #6438).
 *
 * Uso:
 *   npx tsx scripts/check-overnight-plan-motivo.ts --plan data/overnight/260828/plan.json
 *
 * @see scripts/lib/overnight-plan-motivo.ts
 * @see scripts/validate-develop-plan-motivo.ts (CLI irmão do develop)
 */

import { existsSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  checkOvernightPlanMotivos,
  OVERNIGHT_PULADA_MOTIVOS,
} from "./lib/overnight-plan-motivo.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-overnight-plan-motivo] uso: --plan {path}");
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-overnight-plan-motivo] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  const result = checkOvernightPlanMotivos(planPath);
  if (result.status === "ok") {
    console.log("ok — todo motivo de issue pulada está no vocabulário fechado");
    process.exit(0);
  }

  console.error(
    `[check-overnight-plan-motivo] motivo fora do vocabulário fechado (${OVERNIGHT_PULADA_MOTIVOS.join(", ")}), ou ausente:`,
  );
  for (const entry of result.entries) {
    const label = Number.isFinite(entry.number) ? `#${entry.number}` : "#?";
    console.error(`  ${label} — motivo: ${entry.motivo ?? "(ausente)"}`);
  }
  process.exit(1);
}
