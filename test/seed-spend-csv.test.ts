/**
 * test/seed-spend-csv.test.ts (#5236 Parte 1)
 *
 * `scripts/seed-spend-csv.ts` — escreve o seed inicial de `spend.csv`,
 * idempotente (recusa sobrescrever sem `--force`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/seed-spend-csv.ts";
import { SPEND_SEED_ROWS } from "../scripts/lib/aquisicao-spend.ts";
import { parseSpendCsv } from "../scripts/lib/aquisicao-spend.ts";

describe("seed-spend-csv main", () => {
  it("escreve o seed quando o arquivo não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-spend-"));
    try {
      const outPath = join(dir, "spend.csv");
      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--out", outPath]);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.notEqual(exit, 1);
      assert.ok(existsSync(outPath));
      const { rows, errors } = parseSpendCsv(readFileSync(outPath, "utf8"));
      assert.deepEqual(errors, []);
      assert.deepEqual(rows, SPEND_SEED_ROWS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa sobrescrever um arquivo existente sem --force (exit 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-spend-existing-"));
    try {
      const outPath = join(dir, "spend.csv");
      writeFileSync(outPath, "canal,mes,moeda,valor,fonte\nEditado pelo editor,2026-08,BRL,1,x\n", "utf8");

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      main(["--out", outPath]);
      const exit = process.exitCode;
      process.exitCode = exitBefore;

      assert.equal(exit, 1);
      const content = readFileSync(outPath, "utf8");
      assert.match(content, /Editado pelo editor/, "não deveria ter sobrescrito o arquivo do editor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force sobrescreve um arquivo existente", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-spend-force-"));
    try {
      const outPath = join(dir, "spend.csv");
      writeFileSync(outPath, "canal,mes,moeda,valor,fonte\nAntigo,2026-08,BRL,1,x\n", "utf8");

      main(["--out", outPath, "--force"]);

      const { rows } = parseSpendCsv(readFileSync(outPath, "utf8"));
      assert.deepEqual(rows, SPEND_SEED_ROWS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
