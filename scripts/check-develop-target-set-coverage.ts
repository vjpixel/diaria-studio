#!/usr/bin/env npx tsx
/**
 * check-develop-target-set-coverage.ts (#5718)
 *
 * CLI para o gate de "issue do target_set sem entrada em issues[]" — ver
 * `scripts/lib/develop-target-set-coverage.ts` para a lógica pura/
 * documentação completa do mecanismo. Este arquivo é só o ponto de entrada
 * de linha de comando, seguindo o mesmo padrão de
 * `scripts/validate-develop-plan-motivo.ts`.
 *
 * Roda na Fase 2 de `.claude/skills/diaria-develop/SKILL.md`, junto dos
 * outros dois gates pré-relatório. `exit 1` = pelo menos uma issue de
 * `goal.target_set` terminou a sessão sem entrada em `issues[]` (ou com
 * entrada sem `status`) — antes de escrever o relatório, o coordenador
 * precisa fazer o backfill mecânico: pra cada número listado, adicionar
 * `{ number, status: "nao-tentada" }` a `issues[]` (sem julgamento — é
 * registro, não reclassificação; a issue continua elegível pra dispatch em
 * sessão futura).
 *
 * Uso:
 *   npx tsx scripts/check-develop-target-set-coverage.ts --plan data/develop/260819/plan.json
 *
 * @see scripts/lib/develop-target-set-coverage.ts
 * @see scripts/validate-develop-plan-motivo.ts (padrão de estilo)
 * @see .claude/skills/diaria-develop/SKILL.md
 */

import { existsSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { checkTargetSetCoverage, DEVELOP_NAO_TENTADA_STATUS } from "./lib/develop-target-set-coverage.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-develop-target-set-coverage] uso: --plan {path}");
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-develop-target-set-coverage] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  const result = checkTargetSetCoverage(planPath);
  if (result.status === "ok") {
    console.log("ok — toda issue de goal.target_set tem entrada em issues[]");
    process.exit(0);
  }

  const list = result.issues.map((n) => `#${n}`).join(", ");
  console.error(
    `[check-develop-target-set-coverage] issue(s) de goal.target_set sem entrada em issues[]: ${list}`,
  );
  console.error(
    `  → pra cada uma, adicionar { number, status: "${DEVELOP_NAO_TENTADA_STATUS}" } a issues[] antes de fechar o relatório (backfill mecânico, sem julgamento).`,
  );
  process.exit(1);
}
