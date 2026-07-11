/**
 * dedup-input-shape.test.ts (#1268)
 *
 * Tests do guard que dedup.ts aplica em input shape — aceita array raw
 * OU objeto wrapped `{articles, expanded?, warnings?}` (output do
 * expand-inbox-aggregators.ts propagado por enrich-inbox-articles.ts).
 *
 * Antes de #1268, dedup.ts crashava silenciosamente com
 * "articles.filter is not a function" quando recebia wrapped object.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-dedup-shape-"));
  mkdirSync(join(dir, "out"), { recursive: true });
  // past-editions.md mínimo (vazio, sem seções) — guard #672 emite warn
  // mas não bloqueia.
  writeFileSync(
    join(dir, "past-editions.md"),
    "# Past editions\n\nemtpy\n",
    "utf8",
  );
  return dir;
}

function runDedup(articlesPath: string, dir: string): { code: number; stderr: string } {
  const r = spawnSync("npx", [
    "tsx",
    "scripts/dedup.ts",
    "--articles", articlesPath,
    "--past-editions", join(dir, "past-editions.md"),
    "--window", "3",
    "--out", join(dir, "out/dedup-output.json"),
    // #3311: isola o logEvent de auditoria (`dedup: N artigos removidos...`)
    // pro tmpdir do teste — sem isso, main() cai no default de logEvent
    // (process.cwd()), que aqui é `cwd: ROOT` (raiz real do repo/worktree),
    // poluindo data/run-log.jsonl de produção a cada test run bem-sucedido.
    "--log-root-dir", dir,
  ], { cwd: ROOT, encoding: "utf8", shell: true });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("dedup.ts — input shape guard (#1268)", () => {
  it("aceita array raw (shape canônico)", () => {
    const dir = makeFixture();
    try {
      const articles = [
        { url: "https://example.com/a", title: "Article A", source: "test" },
        { url: "https://example.com/b", title: "Article B", source: "test" },
      ];
      const articlesPath = join(dir, "articles.json");
      writeFileSync(articlesPath, JSON.stringify(articles), "utf8");

      const realRepoLogPath = resolve(ROOT, "data", "run-log.jsonl");
      const realRepoLogSnapshot = existsSync(realRepoLogPath) ? readFileSync(realRepoLogPath, "utf8") : null;

      const r = runDedup(articlesPath, dir);
      assert.equal(r.code, 0, `dedup deveria passar com array raw; stderr: ${r.stderr}`);

      // #3311: prova que o logEvent de auditoria (`dedup: N artigos...`) foi
      // de fato isolado no tmpdir via --log-root-dir — nunca no repo real.
      const isolatedLogPath = join(dir, "data", "run-log.jsonl");
      assert.ok(existsSync(isolatedLogPath), "log de auditoria deveria existir no tmpdir isolado (--log-root-dir)");
      assert.match(readFileSync(isolatedLogPath, "utf8"), /"agent":"dedup\.ts"/);
      if (existsSync(realRepoLogPath)) {
        assert.equal(
          readFileSync(realRepoLogPath, "utf8"),
          realRepoLogSnapshot,
          "data/run-log.jsonl REAL do repo não deveria ter sido alterado por este teste",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aceita objeto wrapped {articles, expanded, warnings} (output expand-inbox)", () => {
    const dir = makeFixture();
    try {
      const wrapped = {
        articles: [
          { url: "https://example.com/a", title: "Article A", source: "test" },
          { url: "https://example.com/b", title: "Article B", source: "test" },
        ],
        expanded: [],
        warnings: [],
      };
      const articlesPath = join(dir, "articles-wrapped.json");
      writeFileSync(articlesPath, JSON.stringify(wrapped), "utf8");

      const r = runDedup(articlesPath, dir);
      assert.equal(r.code, 0, `dedup deveria passar com wrapped; stderr: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha loud com mensagem clara quando shape é inválido", () => {
    const dir = makeFixture();
    try {
      const invalid = { something_else: "not articles" };
      const articlesPath = join(dir, "invalid.json");
      writeFileSync(articlesPath, JSON.stringify(invalid), "utf8");

      const r = runDedup(articlesPath, dir);
      assert.notEqual(r.code, 0, "dedup deveria falhar com shape inválido");
      // Mensagem deve ser clara — não TypeError críptico
      assert.ok(
        /shape inesperado|não é array nem tem campo/.test(r.stderr),
        `mensagem deveria explicar shape inválido; got: ${r.stderr.slice(0, 200)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
