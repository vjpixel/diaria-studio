import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/append-ci-failure.ts");

describe("append-ci-failure.ts (#740)", () => {
  function run(args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, ...args],
      { encoding: "utf8", cwd: ROOT, env: { ...process.env } },
    );
  }

  it("adiciona nova entrada ao arquivo (fresh)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-ci-"));
    const outFile = join(dir, "ci-failures.jsonl");
    try {
      const r = run([
        "--workflow", "CI",
        "--branch", "test-branch",
        "--run-url", "https://github.com/vjpixel/diaria-studio/actions/runs/123",
        "--summary", "Test failure",
        "--failed-at", "2026-05-06T01:00:00Z",
        "--out", outFile,
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim());
      assert.equal(out.added, true);
      assert.equal(out.path, outFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedup: não adiciona entry com run_url duplicado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-ci-"));
    const outFile = join(dir, "ci-failures.jsonl");
    const args = [
      "--workflow", "CI",
      "--branch", "feat/dedup-test",
      "--run-url", "https://github.com/vjpixel/diaria-studio/actions/runs/456",
      "--summary", "Dedup test failure",
      "--failed-at", "2026-05-06T02:00:00Z",
      "--out", outFile,
    ];
    try {
      // Primeira inserção
      const r1 = run(args);
      assert.equal(r1.status, 0);
      assert.equal(JSON.parse(r1.stdout.trim()).added, true);

      // Segunda inserção — deve retornar duplicate
      const r2 = run(args);
      assert.equal(r2.status, 0);
      const out2 = JSON.parse(r2.stdout.trim());
      assert.equal(out2.added, false);
      assert.equal(out2.reason, "duplicate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 quando args obrigatórios faltam", () => {
    const r = run(["--workflow", "CI"]);
    assert.equal(r.status, 2);
  });
});
