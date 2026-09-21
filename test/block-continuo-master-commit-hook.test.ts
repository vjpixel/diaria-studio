import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  decide,
  commandHasGitCommit,
  BLOCK_REASON,
} from "../.claude/hooks/block-continuo-master-commit.mjs";

const commit = { tool_name: "Bash", cwd: "/x", tool_input: { command: 'git commit -m "fix"' } };
const CONT = { DIARIA_SESSION_KIND: "continuo" };

describe("block-continuo-master-commit (#8588)", () => {
  it("regressão: continuo commitando em master é bloqueado", () => {
    assert.equal(decide(commit, CONT, () => "master"), BLOCK_REASON);
    assert.equal(decide(commit, CONT, () => "main"), BLOCK_REASON);
  });
  it("continuo em branch própria passa", () => {
    assert.equal(decide(commit, CONT, () => "continuo/fix-1-x"), null);
  });
  it("sessão sem marcador (interativa) em master passa", () => {
    assert.equal(decide(commit, {}, () => "master"), null);
  });
  it("comando que não é git commit passa; mensagem citando git commit não conta", () => {
    assert.equal(decide({ ...commit, tool_input: { command: "git status" } }, CONT, () => "master"), null);
    assert.equal(commandHasGitCommit('echo "git commit"'), false);
    assert.equal(commandHasGitCommit("git add -A && git commit -m x"), true);
  });
  it("hook real via stdin: deny com marcador, silêncio sem", () => {
    const run = (env: Record<string, string>) =>
      execFileSync("node", [".claude/hooks/block-continuo-master-commit.mjs"], {
        input: JSON.stringify({ ...commit, cwd: process.cwd() }),
        encoding: "utf8",
        env: { ...process.env, DIARIA_SESSION_KIND: "", ...env },
      });
    assert.equal(run({}), "");
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const out = run({ DIARIA_SESSION_KIND: "continuo" });
    if (branch === "master" || branch === "main") assert.match(out, /"deny"/);
    else assert.equal(out, "");
  });
  it("registrado em settings.json e exportado pelo claude-delegate.sh", () => {
    assert.match(readFileSync(".claude/settings.json", "utf8"), /block-continuo-master-commit\.mjs/);
    assert.match(readFileSync("hermes/scripts/claude-delegate.sh", "utf8"), /^export DIARIA_SESSION_KIND=continuo$/m);
  });
});
