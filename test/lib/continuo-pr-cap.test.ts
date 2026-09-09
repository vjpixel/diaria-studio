/**
 * Regressão #7746 — teto de 3 PRs continuo/*.
 */
import { describe, it, expect } from "vitest";
import { shouldClaimNewIssue } from "../../scripts/lib/continuo-pr-cap.js";

describe("shouldClaimNewIssue (#7746)", () => {
  it("abaixo do teto → true", () => {
    expect(shouldClaimNewIssue(["continuo/a"], 3).mayClaim).toBe(true);
    expect(shouldClaimNewIssue(["continuo/a", "continuo/b"], 3).mayClaim).toBe(true);
  });
  it("exatamente no teto → false", () => {
    expect(shouldClaimNewIssue(["continuo/a", "continuo/b", "continuo/c"], 3).mayClaim).toBe(false);
  });
  it("acima do teto → false", () => {
    expect(shouldClaimNewIssue(["continuo/a","continuo/b","continuo/c","continuo/d"], 3).mayClaim).toBe(false);
  });
  it("draft resgate não conta (3 normais + 2 rescue = false; 2 normais + 3 rescue = true)", () => {
    expect(shouldClaimNewIssue([
      "continuo/a","continuo/b","continuo/c","continuo/rescue-1","continuo/rescue-2"
    ], 3).mayClaim).toBe(false); // 3 normais
    expect(shouldClaimNewIssue([
      "continuo/a","continuo/b","continuo/rescue-1","continuo/rescue-2","continuo/rescue-3"
    ], 3).mayClaim).toBe(true); // só 2 normais
  });
  it("recebe array já filtrado (contrato puro)", () => {
    expect(shouldClaimNewIssue(["continuo/z"], 3)).toMatchObject({ open: 1, mayClaim: true });
  });
  it("cap padrão = 3", () => {
    expect(shouldClaimNewIssue(["continuo/a"], 3).cap).toBe(3);
  });
});
