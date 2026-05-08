/**
 * Tipos compartilhados pelas regras de invariant-checks (#1007 Fase 1).
 *
 * Cada regra é uma função pura `(editionDir: string) => InvariantViolation[]`
 * registrada em `index.ts`. Roda sob `check-invariants.ts --stage N` antes
 * de cada gate do orchestrator.
 */

export type InvariantSeverity = "error" | "warning";

export interface InvariantViolation {
  rule: string;
  message: string;
  source_issue: string;
  severity: InvariantSeverity;
  file?: string;
  line?: number;
}

export interface InvariantRule {
  id: string;
  description: string;
  source_issue: string;
  /**
   * Stage em que a regra deve ser checada. `0` roda no Stage 0 preflight
   * (antes de iniciar). `1`-`4` rodam pré-gate de cada stage.
   */
  stage: 0 | 1 | 2 | 3 | 4;
  run: (editionDir: string) => InvariantViolation[];
}
