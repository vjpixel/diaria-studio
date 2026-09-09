/**
 * Regressão #7746 — teto de 3 PRs continuo/*.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldClaimNewIssue } from "../../scripts/lib/continuo-pr-cap.ts";

describe("shouldClaimNewIssue (#7746)", () => {
  it("abaixo do teto → true", () => {
    assert.strictEqual(shouldClaimNewIssue(["continuo/a"], 3).mayClaim, true);
    assert.strictEqual(shouldClaimNewIssue(["continuo/a", "continuo/b"], 3).mayClaim, true);
  });
  it("exatamente no teto → false", () => {
    assert.strictEqual(shouldClaimNewIssue(["continuo/a", "continuo/b", "continuo/c"], 3).mayClaim, false);
  });
  it("acima do teto → false", () => {
    assert.strictEqual(shouldClaimNewIssue(["continuo/a","continuo/b","continuo/c","continuo/d"], 3).mayClaim, false);
  });
  it("draft resgate não conta (3 normais + 2 rescue = false; 2 normais + 3 rescue = true)", () => {
    assert.strictEqual(shouldClaimNewIssue([
      "continuo/a","continuo/b","continuo/c","continuo/rescue-1","continuo/rescue-2"
    ], 3).mayClaim, false); // 3 normais
    assert.strictEqual(shouldClaimNewIssue([
      "continuo/a","continuo/b","continuo/rescue-1","continuo/rescue-2","continuo/rescue-3"
    ], 3).mayClaim, true); // só 2 normais
  });
  it("recebe array já filtrado (contrato puro)", () => {
    const result = shouldClaimNewIssue(["continuo/z"], 3);
    assert.deepStrictEqual(result, { open: 1, mayClaim: true, cap: 3, counted: ['continuo/z'] });
  });
  it("cap padrão = 3", () => {
    assert.strictEqual(shouldClaimNewIssue(["continuo/a"], 3).cap, 3);
  });
});
