import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { requireSharedIssueRegistry } from "../scripts/lib/exec-mode.ts";

test("cloud sem data/ recusa execução; local continua permitido", () => {
  assert.throws(() => requireSharedIssueRegistry({ statFn: () => { throw Error("ENOENT"); } }, {}), /#12307/);
  assert.doesNotThrow(() => requireSharedIssueRegistry({ statFn: () => ({ isDirectory: () => true }) }, {}));
  assert.throws(() => requireSharedIssueRegistry({ statFn: () => ({ isDirectory: () => true }) }, { CLAUDE_CODE_REMOTE: "true" }), /#12307/);
});

test("CLI falha antes de criar registro e data/ artificial não libera harness remoto", () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-12307-"));
  const cli = resolve("scripts/lib/exec-mode.ts");
  const tsx = resolve("node_modules/tsx/dist/cli.mjs");
  const run = (remote: string) => spawnSync(process.execPath, [tsx, cli, "--require-shared-issue-registry"], {
    cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_REMOTE: remote },
  });
  try {
    const absent = run("false");
    assert.equal(absent.status, 1, absent.stderr);
    assert.match(absent.stderr, /claims locais não evitam trabalho duplicado/);
    mkdirSync(join(root, "data"));
    assert.equal(run("true").status, 1);
    const local = run("false");
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout.trim(), "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skills barram cloud antes de qualquer passo operacional, sem depender de hooks", () => {
  for (const skill of ["diaria-overnight", "diaria-develop", "diaria-desbloqueia"]) {
    const text = readFileSync(`.claude/skills/${skill}/SKILL.md`, "utf8");
    const firstInstruction = text.split(`# /${skill}\n`)[1];
    assert.ok(firstInstruction.startsWith("\n**Preflight obrigatório de ambiente (#12307)"), skill);
    assert.match(firstInstruction, /exec-mode\.ts --require-shared-issue-registry/);
    assert.match(firstInstruction, /encerrar a skill/);
  }
});
