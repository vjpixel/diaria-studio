import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  commandHasHandwrittenPrChecksLoop as has,
  HANDWRITTEN_PR_CHECKS_LOOP_BLOCK_REASON,
} from "../.claude/hooks/block-handwritten-pr-checks-loop.mjs";

// #9161 — 3 laços `until gh pr checks ...; do sleep 30; done` escritos à mão
// ficaram órfãos 103-242min vigiando PRs já mergeadas (#9130, #9147).

const HOOK = join(import.meta.dirname, "..", ".claude", "hooks", "block-handwritten-pr-checks-loop.mjs");

describe("commandHasHandwrittenPrChecksLoop (#9161)", () => {
  it("comandos reais da issue → bloqueia", () => {
    assert.equal(
      has(`until gh pr checks 9130 --json bucket --jq 'all(.[]; .bucket!="pending") and length>0' 2>/dev/null | grep -q true; do sleep 30; done; gh pr checks 9130 --json name,bucket --jq '.[] | "\\(.name): \\(.bucket)"'`),
      true,
    );
    assert.equal(
      has(`sleep 60; until gh pr checks 9147 --json bucket --jq 'all(.bucket!="pending")' 2>/dev/null | grep -q true; do sleep 30; done`),
      true,
    );
  });
  it("while true; do gh pr checks; sleep → bloqueia", () => {
    assert.equal(has(`while true; do gh pr checks 12; sleep 20; done`), true);
    assert.equal(has(`while ! gh pr checks 12 >/dev/null; do\n  sleep 20\ndone`), true);
  });
  it("laço dentro de subshell/grupo → bloqueia", () => {
    assert.equal(has(`(until gh pr checks 1; do sleep 5; done)`), true);
  });
  it("wait-pr-checks.sh → passa", () => {
    assert.equal(has(`scripts/lib/wait-pr-checks.sh 9161`), false);
    assert.equal(has(`scripts/lib/wait-pr-checks.sh 9161 && gh pr checks 9161`), false);
  });
  it("gh pr checks pontual ou --watch → passa", () => {
    assert.equal(has(`gh pr checks 9161`), false);
    assert.equal(has(`gh pr checks 9161 --watch`), false);
  });
  it("for de disparo único sobre lista (sem sleep) → passa", () => {
    assert.equal(has(`for pr in 1 2 3; do gh pr checks $pr; done`), false);
  });
  it("citação em aspas/heredoc → passa", () => {
    assert.equal(has(`gh issue comment 1 --body "evite: until gh pr checks 1; do sleep 1; done"`), false);
    assert.equal(
      has(`gh pr create --body-file - <<'EOF'\nuntil gh pr checks 1 --json b; do sleep 1; done\nEOF`),
      false,
    );
  });
  it("laço de polling sem gh pr checks → passa", () => {
    assert.equal(has(`until curl -s localhost; do sleep 1; done`), false);
  });
  it("mensagem aponta pro helper com teto de vida", () => {
    assert.match(HANDWRITTEN_PR_CHECKS_LOOP_BLOCK_REASON, /scripts\/lib\/wait-pr-checks\.sh/);
  });
});

describe("hook entrypoint (#9161)", () => {
  const run = (command: string) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });

  it("nega o laço escrito à mão", () => {
    const r = run(`until gh pr checks 1; do sleep 30; done`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  });
  it("silencioso pra comando legítimo", () => {
    assert.equal(run(`gh pr checks 1`).stdout, "");
  });
  it("registrado em .claude/settings.json (PreToolUse Bash)", () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dirname, "..", ".claude", "settings.json"), "utf8"));
    const bash = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
    const args = bash.hooks.flatMap((h: { args?: string[] }) => h.args ?? []);
    assert.ok(args.some((a: string) => a.endsWith("block-handwritten-pr-checks-loop.mjs")));
  });
});
