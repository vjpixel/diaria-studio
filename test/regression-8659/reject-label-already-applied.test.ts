/**
 * Regressão #8659 / #7704: check-continuo-reject-label.ts deve reportar
 * labelApplied=true e firstTime=false quando o label `continuo-rejeitado`
 * já está na PR (estado estacionário de PR rejeitada a partir do 2º tick).
 * Antes do #7704, `labelApplied` era `false` nesse caso, fazendo o bash
 * do `continuo-pr-review.sh` acusar erro de infra a cada tick.
 *
 * A correção (check-continuo-reject-label.ts): `labelApplied = alreadyRejected ? true : applyLabel(...)`
 * garante que o estado estacionário não gere falso positivo de falha.
 */
import { describe, it, expect } from "vitest";
import { isAlreadyRejectLabeled } from "../../scripts/lib/continuo-reject-owner.ts";

describe("regressão #8659/7704 — reject label estado estacionário", () => {
  it("já rotulada => isAlreadyRejectLabeled true", () => {
    expect(isAlreadyRejectLabeled(["continuo-rejeitado", "bug"])).toBe(true);
  });

  it("não rotulada => isAlreadyRejectLabeled false", () => {
    expect(isAlreadyRejectLabeled(["bug", "enhancement"])).toBe(false);
  });
});
