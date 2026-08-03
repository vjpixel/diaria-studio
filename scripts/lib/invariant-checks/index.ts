/**
 * Registry central das regras de invariant-checks (#1007 Fase 1).
 *
 * `check-invariants.ts --stage N` lê esse registry e roda só as regras com
 * `stage === N`. Stage 0 = pre-flight global (sem editionDir). Stages 1-4
 * recebem editionDir.
 */

import type { InvariantRule } from "./types.ts";
import { STAGE_0_RULES } from "./stage-0.ts";
import { STAGE_1_RULES } from "./stage-1.ts";
import { STAGE_2_RULES } from "./stage-2.ts";
import { STAGE_3_RULES } from "./stage-3.ts";
import { STAGE_4_RULES } from "./stage-4.ts";
import { STAGE_5_RULES } from "./stage-5.ts";
import { STAGE_6_RULES } from "./stage-6.ts";

export const ALL_INVARIANT_RULES: InvariantRule[] = [
  ...STAGE_0_RULES,
  ...STAGE_1_RULES,
  ...STAGE_2_RULES,
  ...STAGE_3_RULES,
  ...STAGE_4_RULES,
  ...STAGE_5_RULES,
  ...STAGE_6_RULES,
];

/**
 * #4516: `opts.phase === "pre-dispatch"` exclui regras marcadas
 * `postDispatchOnly: true` (hoje só 2, no Stage 5 — `social-published-complete`/
 * `step-5-sentinel-exists`, que só podem passar DEPOIS que o dispatch já
 * rodou). Sem `opts`/`phase` omitido = comportamento de sempre (todas as
 * regras do stage, independente de fase) — usado por `§5i` (pós-publicação)
 * e por qualquer outro stage, nenhum dos quais tem regra marcada hoje.
 */
export function getRulesForStage(
  stage: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  opts?: { phase?: "pre-dispatch" },
): InvariantRule[] {
  const rules = ALL_INVARIANT_RULES.filter((r) => r.stage === stage);
  if (opts?.phase === "pre-dispatch") {
    return rules.filter((r) => !r.postDispatchOnly);
  }
  return rules;
}

export type { InvariantRule, InvariantViolation, InvariantSeverity } from "./types.ts";
