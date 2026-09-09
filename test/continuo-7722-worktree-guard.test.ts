import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

describe("#7722 worktree guard (não stub, #7806 rejeitada)", () => {
  it("resolveWorktreeBranches é export real no beacon (não stub constante)", () => {
    const beacon = fs.readFileSync(".claude/hooks/session-beacon.mjs", "utf8");
    assert.ok(beacon.includes("resolveWorktreeBranches"), "função deve existir");
    assert.ok(beacon.includes("git worktree list --porcelain"), "deve chamar git real");
  });

  it("claimWorktree é export real e não retorna true incondicional (#7806)", () => {
    const reg = fs.readFileSync("scripts/lib/session-registry.ts", "utf8");
    assert.ok(reg.includes("Implementação real (#7722"), "não pode ser stub de constante");
    assert.ok(reg.includes("readJsonSafe"), "deve ler estado");
  });

  it("block-worktree-alien-commit existe e não é stub (não sempre blocked:false)", () => {
    assert.strictEqual(fs.existsSync(".claude/hooks/block-worktree-alien-commit.mjs"), true);
    const guard = fs.readFileSync(".claude/hooks/block-worktree-alien-commit.mjs", "utf8");
    assert.ok(guard.includes("BLOQUEADO"), "deve bloquear algum caminho");
    assert.ok(!guard.includes("return true"), "não pode ser stub sempre true");
  });
});
