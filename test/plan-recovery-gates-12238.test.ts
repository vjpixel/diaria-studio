/** #12238: gates must recover a plan renamed by OneDrive before rejecting its path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const gates = [
  "check-skipped-develop-track",
  "check-develop-target-set-coverage",
  "check-develop-exec-track-coverage",
  "check-develop-label-cleared",
];

function run(script: string, plan: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("scripts", `${script}.ts`), "--plan", plan, ...args], {
    encoding: "utf8", timeout: 30_000,
  });
}

for (const gate of gates) {
  test(`${gate}: restaura o backup válido mais novo, inclusive após nova perda`, () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-recovery-12238-"));
    try {
      const path = join(dir, "plan.json");
      const old = join(dir, "plan-300-safeBackup-0001.json");
      const latest = join(dir, "plan-300-safeBackup-0002.json");
      const corrupt = join(dir, "plan-300-safeBackup-0003.json");
      writeFileSync(old, JSON.stringify({ issues: [], marker: "old" }));
      const content = JSON.stringify({ issues: [], marker: "latest", resume_state: { phase: "fase-2" } });
      writeFileSync(latest, content);
      writeFileSync(corrupt, '{"issues":');
      utimesSync(old, 1000, 1000);
      utimesSync(latest, 2000, 2000);
      utimesSync(corrupt, 3000, 3000);
      for (let loss = 0; loss < 2; loss++) {
        const result = run(gate, path);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stderr, /restaurado de .*safeBackup-0002/);
        assert.equal(readFileSync(path, "utf8"), content);
        assert.equal(statSync(path).mtimeMs, 2_000_000);
        assert.equal(readFileSync(latest, "utf8"), content);
        unlinkSync(path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${gate}: ausência sem backup válido continua erro; plano vivo é preservado`, () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-recovery-12238-"));
    try {
      const path = join(dir, "plan.json");
      assert.equal(run(gate, path).status, 2);
      const backup = join(dir, "plan-300-safeBackup-0001.json");
      writeFileSync(backup, "{");
      assert.equal(run(gate, path).status, 2);
      assert.equal(existsSync(path), false);
      writeFileSync(backup, JSON.stringify({ issues: [], marker: "backup" }));
      const live = JSON.stringify({ issues: [], marker: "live" });
      writeFileSync(path, live);
      const result = run(gate, path);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(path, "utf8"), live);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("record-overnight-wave: recupera o plano e preserva seu estado ao registrar a onda", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-recovery-wave-12238-"));
  try {
    const path = join(dir, "plan.json");
    writeFileSync(join(dir, "plan-300-safeBackup-0001.json"), JSON.stringify({ issues: [], marker: "preserved" }));
    const result = run("record-overnight-wave", path, ["--units", "12238"]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(plan.marker, "preserved");
    assert.equal(plan.waves.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
