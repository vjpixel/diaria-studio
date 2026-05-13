/**
 * test/fetch-rss-batch-smoke.test.ts (#1209)
 *
 * Smoke tests pra fetch-rss-batch.ts. Não bate em rede — usa mock pra
 * exercitar a orquestração (Promise.all + concurrency + outcome mapping).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("fetch-rss-batch CLI (#1209)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "fetch-rss-batch.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("rejeita sources.json ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "rss-batch-"));
    try {
      const out = join(dir, "results.json");
      const r = runCli(["--sources", join(dir, "missing.json"), "--out", out]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /não existe/i);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejeita uso sem --sources ou --out", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Uso:/);
  });

  it("processa fonte com URL inválida (timeout/fail) sem crashar batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "rss-batch-fail-"));
    try {
      const sources = [
        { name: "BadFeed", rss: "https://nonexistent-domain-xyz-12345.invalid/rss" },
      ];
      const sourcesPath = join(dir, "sources.json");
      const outPath = join(dir, "results.json");
      writeFileSync(sourcesPath, JSON.stringify(sources));

      const r = runCli([
        "--sources", sourcesPath,
        "--out", outPath,
        "--days", "3",
        "--timeout-per-feed", "5000",
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(existsSync(outPath), "output file should exist");
      const results = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(results.length, 1);
      assert.equal(results[0].source, "BadFeed");
      assert.ok(
        ["fail", "timeout"].includes(results[0].outcome),
        `expected fail/timeout, got ${results[0].outcome}`,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
