/**
 * test/check-invariants.test.ts (#965 / #966)
 *
 * Cobre o pre-flight de invariantes editoriais. Modo static (sem
 * edition_dir, valida estrutura do repo) + per-edition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNoForensicInDriveSync,
  STATIC_RULES,
} from "../scripts/check-invariants.ts";

describe("check-invariants — STATIC_RULES (#966)", () => {
  it("expõe pelo menos 1 rule estática", () => {
    assert.ok(STATIC_RULES.length >= 1);
    for (const rule of STATIC_RULES) {
      assert.ok(typeof rule.id === "string");
      assert.ok(typeof rule.description === "string");
      assert.ok(typeof rule.run === "function");
    }
  });
});

describe("check-invariants — checkNoForensicInDriveSync (#959)", () => {
  it("repo atual passa o check (zero violations)", () => {
    const violations = checkNoForensicInDriveSync();
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  });
});

describe("check-invariants CLI (#966)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "check-invariants.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("--static exit 0 no repo atual", () => {
    const r = runCli(["--static"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.passed, true);
    assert.ok(out.rules_run.includes("no-forensic-in-drive-sync"));
  });

  it("--static --rule <id> roda só a regra escolhida", () => {
    const r = runCli(["--static", "--rule", "no-forensic-in-drive-sync"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.rules_run, ["no-forensic-in-drive-sync"]);
  });

  it("sem args = exit 2 (erro de input)", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
  });
});
