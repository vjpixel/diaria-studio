import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test pra --summary-out flag do smoke-test (#1013).
 *
 * Valida que o JSON estruturado é gerado corretamente quando o flag é
 * passado, contendo per-stage stats. Usado pelo weekly-e2e workflow
 * como artefato pra observabilidade.
 */

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SMOKE_SCRIPT = join(PROJECT_ROOT, "scripts", "smoke-test.ts");
const tmpDir = mkdtempSync(join(tmpdir(), "smoke-summary-"));
const summaryPath = join(tmpDir, "summary.json");

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("smoke-test --summary-out (#1013)", () => {
  it("gera JSON estruturado com per-stage stats", () => {
    const result = spawnSync(
      "npx",
      ["tsx", SMOKE_SCRIPT, "--summary-out", summaryPath],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );

    assert.equal(result.status, 0, `smoke-test falhou: ${result.stderr}`);

    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));

    // Schema esperado: generated_at + stage1-4 com passed/failures
    assert.ok(summary.generated_at, "generated_at deve existir");
    assert.match(summary.generated_at, /^\d{4}-\d{2}-\d{2}T/, "ISO 8601");

    // Stage 1
    assert.ok(summary.stage1, "stage1 deve existir");
    assert.equal(typeof summary.stage1.dedup_kept, "number");
    assert.ok(summary.stage1.categorize_buckets, "categorize_buckets deve existir");
    assert.equal(summary.stage1.passed, true);

    // Stages 2-4: { passed: number, failures: number }
    for (const stage of ["stage2", "stage3", "stage4"] as const) {
      assert.ok(summary[stage], `${stage} deve existir`);
      assert.equal(typeof summary[stage].passed, "number");
      assert.equal(typeof summary[stage].failures, "number");
      assert.equal(summary[stage].failures, 0, `${stage} não deve ter falhas em smoke run`);
    }
  });
});
