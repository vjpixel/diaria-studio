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
import { markLowCadenceBypass } from "../scripts/fetch-rss-batch.ts";

describe("markLowCadenceBypass (#1992)", () => {
  const articles = [
    { url: "https://hamel.dev/1", title: "Post 1", published_at: "2026-03-01" },
    { url: "https://hamel.dev/2", title: "Post 2", published_at: "2026-04-15" },
    { url: "https://hamel.dev/3", title: "Post 3", published_at: "2026-05-10" },
  ];

  it("marca os top-N mais recentes com bypass_date_window=true", () => {
    const result = markLowCadenceBypass(articles, 2);
    const byUrl = Object.fromEntries(result.map((a) => [a.url, a]));
    assert.equal(byUrl["https://hamel.dev/3"].bypass_date_window, true, "mais recente marcado");
    assert.equal(byUrl["https://hamel.dev/2"].bypass_date_window, true, "2º mais recente marcado");
    assert.equal(byUrl["https://hamel.dev/1"].bypass_date_window, undefined, "mais antigo não marcado");
  });

  it("topN >= articles.length marca todos", () => {
    const result = markLowCadenceBypass(articles, 5);
    assert.ok(result.every((a) => a.bypass_date_window === true));
  });

  it("lista vazia retorna vazia sem crashar", () => {
    assert.deepEqual(markLowCadenceBypass([], 2), []);
  });

  it("não muta o array original", () => {
    const orig = [{ url: "https://a.com/1", published_at: "2026-05-10" }];
    markLowCadenceBypass(orig, 1);
    assert.equal((orig[0] as { bypass_date_window?: boolean }).bypass_date_window, undefined);
  });

  it("artigos sem published_at ficam no final da ordem e ainda são marcados se topN alcança", () => {
    const arts = [
      { url: "https://a.com/1", published_at: "2026-05-10" },
      { url: "https://a.com/2", published_at: undefined },
    ];
    const result = markLowCadenceBypass(arts, 1);
    const byUrl = Object.fromEntries(result.map((a) => [a.url, a]));
    assert.equal(byUrl["https://a.com/1"].bypass_date_window, true, "com data marcado primeiro");
    assert.equal(byUrl["https://a.com/2"].bypass_date_window, undefined, "sem data não fica no top-1");
  });
});

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
