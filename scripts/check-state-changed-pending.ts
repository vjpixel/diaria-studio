#!/usr/bin/env npx tsx
/**
 * check-state-changed-pending.ts (#5476)
 *
 * CLI para o gate de "re-triagem pendente" — ver `scripts/lib/state-changed-tracker.ts`
 * para a lógica pura/documentação completa do mecanismo. Este arquivo é só o
 * ponto de entrada de linha de comando, seguindo o mesmo padrão de
 * `scripts/check-overnight-token-instrumentation.ts`.
 *
 * Uso:
 *   # checar (modo padrão): sai 1 se houver pendência, 0 se vazio
 *   npx tsx scripts/check-state-changed-pending.ts --plan data/overnight/260817/plan.json
 *
 *   # registrar pendência (ex: acabou de aplicar uma label de classificação
 *   # ou remover uma claim de session-registry durante a rodada)
 *   npx tsx scripts/check-state-changed-pending.ts --add-pending 5480 --plan data/overnight/260817/plan.json
 *
 *   # resolver pendência (depois de reavaliar dispatch pra essa issue)
 *   npx tsx scripts/check-state-changed-pending.ts --remove-pending 5480 --plan data/overnight/260817/plan.json
 *
 * @see scripts/lib/state-changed-tracker.ts
 * @see scripts/check-overnight-token-instrumentation.ts (padrão de estilo)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-continuo/SKILL.md
 */

import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  addPendingToPlan,
  checkStateChangedPending,
  removePendingFromPlan,
} from "./lib/state-changed-tracker.ts";

function parseIssueArg(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`[check-state-changed-pending] --${flag} inválido: ${raw}`);
    process.exit(2);
  }
  return n;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error(
      "[check-state-changed-pending] uso: --plan {path} [--add-pending N | --remove-pending N]",
    );
    process.exit(2);
  }

  if (values["add-pending"] !== undefined) {
    const n = parseIssueArg(values["add-pending"], "add-pending");
    addPendingToPlan(planPath, n);
    console.log(`[check-state-changed-pending] #${n} adicionada a state_changed_issues (${planPath}).`);
    process.exit(0);
  }

  if (values["remove-pending"] !== undefined) {
    const n = parseIssueArg(values["remove-pending"], "remove-pending");
    removePendingFromPlan(planPath, n);
    console.log(`[check-state-changed-pending] #${n} removida de state_changed_issues (${planPath}).`);
    process.exit(0);
  }

  // Modo padrão: checar.
  const result = checkStateChangedPending(planPath);
  if (result.status === "ok") {
    console.log("ok — nenhuma pendência de re-triagem");
    process.exit(0);
  }
  const list = result.issues.map((n) => `#${n}`).join(", ");
  console.error(
    `pendências de re-triagem: ${list} — reavalie dispatch antes de fechar a rodada`,
  );
  process.exit(1);
}
