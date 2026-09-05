#!/usr/bin/env npx tsx
/**
 * check-overnight-plan-briefing.ts (#7497)
 *
 * CLI do gate de formato do campo raiz `briefing` do plan.json do
 * `/diaria-overnight`/`/diaria-continuo` — ver
 * `scripts/lib/overnight-plan-briefing.ts` para a lógica pura/docstring
 * completa (o que cada `reason` significa, por que o campo existe).
 *
 * `exit 1` = campo `briefing` presente mas estruturalmente inválido
 * (`asked`/`reason` ausentes, fora de tipo, ou inconsistentes entre si).
 * Campo ausente (plano anterior a este PR) → `exit 0` (fail-open, plano
 * legado). Campo presente e válido → `exit 0`, com aviso extra se
 * `isSuspiciousMissingBriefing` for `true` (sinal pro relatório da Fase 2,
 * não motivo de falha do gate — a issue pediu visibilidade, não bloqueio).
 *
 * Uso:
 *   npx tsx scripts/check-overnight-plan-briefing.ts --plan data/overnight/260905/plan.json
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  checkOvernightPlanBriefingFromRoot,
  isSuspiciousMissingBriefing,
  type OvernightPlanRootLike,
} from "./lib/overnight-plan-briefing.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-overnight-plan-briefing] uso: --plan {path}");
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-overnight-plan-briefing] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as OvernightPlanRootLike;
  const result = checkOvernightPlanBriefingFromRoot(plan);

  if (result.status === "invalid") {
    console.error("[check-overnight-plan-briefing] briefing inválido:");
    for (const problem of result.problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  if (!result.present) {
    console.log("ok — plan.json sem campo briefing (plano legado, anterior a #7497)");
    process.exit(0);
  }

  if (isSuspiciousMissingBriefing(plan)) {
    console.log(
      'ok (com aviso) — briefing.asked=false e reason="desconhecido": nenhuma causa legítima conhecida para a ausência da pergunta. Sinalizar no relatório da Fase 2 (#7497).',
    );
    process.exit(0);
  }

  console.log("ok — briefing consistente");
  process.exit(0);
}
