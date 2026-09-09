import { describe, it, expect } from "vitest";
import { extractWorktreeBranches } from "../.claude/hooks/session-beacon.mjs";

describe("#7722 worktree identity", () => {
  it("deriva branches por worktree, não checkout principal", () => {
    const list = extractWorktreeBranches("/home/vjpixel/continuo-fix-7722-slug");
    // Deve incluir o próprio worktree com branch correto
    const self = list.find((w) => w.path.includes("continuo-fix-7722-slug"));
    expect(self).toBeDefined();
    expect(self!.branch).toBe("continuo/fix-7722-slug");
  });

  it("não confunde master do checkout principal com branch do worktree", () => {
    const list = extractWorktreeBranches("/home/vjpixel/continuo-fix-7722-slug");
    // O worktree atual é continuo/fix-7722-slug; master é outro entry
    const masterEntry = list.find((w) => w.branch === "master");
    expect(masterEntry).toBeDefined();
    // Eles são entries distintas — prova que não é mais um único valor
    const selfEntry = list.find((w) => w.path.includes("continuo-fix-7722-slug"));
    expect(selfEntry!.branch).not.toBe("master");
  });
});
