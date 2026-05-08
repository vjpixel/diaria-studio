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

export const ALL_INVARIANT_RULES: InvariantRule[] = [
  ...STAGE_0_RULES,
  ...STAGE_1_RULES,
  ...STAGE_2_RULES,
  ...STAGE_3_RULES,
  ...STAGE_4_RULES,
];

export function getRulesForStage(stage: 0 | 1 | 2 | 3 | 4): InvariantRule[] {
  return ALL_INVARIANT_RULES.filter((r) => r.stage === stage);
}

export type { InvariantRule, InvariantViolation, InvariantSeverity } from "./types.ts";
