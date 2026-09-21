import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  decide,
  findGuardedOps,
  commandHasGitCommit,
  BLOCK_REASON,
} from "../.claude/hooks/block-continuo-master-commit.mjs";

const CONT = { DIARIA_SESSION_KIND: "continuo" };
const p = (command: string, cwd = "/x") => ({ tool_name: "Bash", cwd, tool_input: { command } });
const onMaster = () => "master";

describe("block-continuo-master-commit (#8588)", () => {
  it("regressão: continuo commitando em master/main é bloqueado", () => {
    assert.equal(decide(p('git commit -m "fix"'), CONT, () => "master"), BLOCK_REASON);
    assert.equal(decide(p("git commit -m x"), CONT, () => "main"), BLOCK_REASON);
  });
  it("branch própria e sessão sem marcador passam", () => {
    assert.equal(decide(p("git commit -m x"), CONT, () => "continuo/fix-1-x"), null);
    assert.equal(decide(p("git commit -m x"), {}, onMaster), null);
  });
  it("não-commit e texto citando git commit não bloqueiam; heredoc não gera falso positivo", () => {
    assert.equal(decide(p("git status"), CONT, onMaster), null);
    assert.equal(commandHasGitCommit('echo "git commit"'), false);
    assert.equal(commandHasGitCommit("gh issue create --body-file - <<'EOF'\ngit commit -m x\nEOF"), false);
    assert.equal(commandHasGitCommit("git add -A && git commit -m x"), true);
  });
  const bypasses: [string, string][] = [
    ["git -C dir commit", "git -C /repo commit -m x"],
    ["git -c k=v commit", "git -c user.name=a commit -m x"],
    ["--no-pager", "git --no-pager commit -m x"],
    ["subshell (", "(git commit -m x)"],
    ["chave {", "{ git commit -m x; }"],
    ["env", "env FOO=1 git commit -m x"],
    ["command", "command git commit -m x"],
    ["sudo", "sudo git commit -m x"],
    ["time", "time git commit -m x"],
    ["bash -c", "bash -c 'git commit -m x'"],
    ["merge", "git merge feature"],
    ["cherry-pick", "git cherry-pick abc"],
    ["update-ref", "git update-ref refs/heads/master abc"],
    ["apóstrofo solto (falha fechada)", "echo it's && git commit -m x"],
  ];
  for (const [name, cmd] of bypasses) {
    it(`bypass coberto: ${name}`, () => {
      assert.equal(decide(p(cmd), CONT, onMaster), BLOCK_REASON, cmd);
    });
  }
  it("cd para worktree / git -C worktree usa a branch do diretório efetivo", () => {
    const head = (d: string) => (d.replaceAll("\\", "/").includes("worktrees") ? "continuo/x" : "master");
    assert.equal(decide(p("cd .claude/worktrees/x && git commit -m y", "/repo"), CONT, head), null);
    assert.equal(decide(p("git -C .claude/worktrees/x commit -m y", "/repo"), CONT, head), null);
    assert.equal(decide(p("git commit -m y", "/repo"), CONT, head), BLOCK_REASON);
  });
  it("findGuardedOps resolve dir", () => {
    const ops = findGuardedOps("cd sub && git commit -m x", "/repo");
    assert.equal(ops.length, 1);
    assert.match(ops[0].dir.replaceAll("\\", "/"), /repo\/sub$/);
  });
  it("hook real via stdin em repo temporário: deny em master, silêncio em branch e sem marcador", () => {
    const repo = mkdtempSync(join(tmpdir(), "h8588-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "master");
    const run = (env: Record<string, string>) =>
      execFileSync("node", [".claude/hooks/block-continuo-master-commit.mjs"], {
        input: JSON.stringify(p("git commit -m x", repo)),
        encoding: "utf8",
        env: { ...process.env, DIARIA_SESSION_KIND: "", ...env },
      });
    assert.match(run({ DIARIA_SESSION_KIND: "continuo" }), /"permissionDecision":"deny"/);
    assert.equal(run({}), "");
    git("checkout", "-q", "-b", "continuo/fix-1");
    assert.equal(run({ DIARIA_SESSION_KIND: "continuo" }), "");
  });
  it("registrado em settings.json e exportado pelo claude-delegate.sh", () => {
    assert.match(readFileSync(".claude/settings.json", "utf8"), /block-continuo-master-commit\.mjs/);
    assert.match(readFileSync("hermes/scripts/claude-delegate.sh", "utf8"), /^export DIARIA_SESSION_KIND=continuo\r?$/m);
  });
});
