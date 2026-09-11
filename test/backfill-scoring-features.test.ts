/**
 * test/backfill-scoring-features.test.ts (#7975)
 *
 * Cobre o CLI scripts/backfill-scoring-features.ts — comportamento não
 * exercitado pelos testes de scoring-features.ts (a lib): idempotência via
 * --force, isolamento de erro entre edições, e as classes de erro
 * distintas (error-stat/error/error-write) que separam dado malformado de
 * infraestrutura (achado de review do #7975).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processEdition, runBackfill } from "../scripts/backfill-scoring-features.ts";

function writeCategorized(editionDir: string, overrides: Record<string, unknown[]> = {}): void {
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(
    join(editionDir, "_internal", "01-categorized.json"),
    JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: [{ url: "https://example.com/a", title: "A" }], use_melhor: [], video: [], ...overrides }),
    "utf8",
  );
}

describe("processEdition (#7975)", () => {
  it("escreve scoring-features.json quando 01-categorized.json existe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-write-"));
    try {
      const editionDir = join(dir, "260811");
      writeCategorized(editionDir);
      const result = await processEdition(editionDir, "260811", false);
      assert.equal(result.status, "written");
      assert.equal(result.rows, 1);
      const outPath = join(editionDir, "_internal", "scoring-features.json");
      assert.ok(existsSync(outPath));
      const payload = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(payload.edition, "260811");
      assert.equal(payload.row_count, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skipped-no-categorized quando a edição não tem 01-categorized.json ainda", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-nocat-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const result = await processEdition(editionDir, "260811", false);
      assert.equal(result.status, "skipped-no-categorized");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotência: 2ª chamada sem --force pula (skipped-exists), não sobrescreve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-idem-"));
    try {
      const editionDir = join(dir, "260811");
      writeCategorized(editionDir);
      const first = await processEdition(editionDir, "260811", false);
      assert.equal(first.status, "written");
      const outPath = join(editionDir, "_internal", "scoring-features.json");
      const before = readFileSync(outPath, "utf8");

      const second = await processEdition(editionDir, "260811", false);
      assert.equal(second.status, "skipped-exists");
      assert.equal(readFileSync(outPath, "utf8"), before, "não pode ter reescrito o arquivo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force re-grava mesmo com scoring-features.json já existente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-force-"));
    try {
      const editionDir = join(dir, "260811");
      writeCategorized(editionDir);
      await processEdition(editionDir, "260811", false);

      // Muda o categorized.json — --force deve refletir a mudança.
      writeCategorized(editionDir, { radar: [{ url: "https://example.com/a", title: "A" }, { url: "https://example.com/b", title: "B" }] });
      const result = await processEdition(editionDir, "260811", true);
      assert.equal(result.status, "written");
      assert.equal(result.rows, 2, "--force deveria re-extrair com o categorized.json atualizado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dado malformado (JSON inválido) vira status error, não trava o processo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-malformed-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "_internal", "01-categorized.json"), "{ isto não é json válido", "utf8");
      const result = await processEdition(editionDir, "260811", false);
      assert.equal(result.status, "error");
      assert.ok(result.error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runBackfill — isolamento de erro entre edições (#7975)", () => {
  it("1 edição com dado malformado não aborta o processamento das demais", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-isolation-"));
    try {
      const editionsRoot = join(dir, "editions");
      writeCategorized(join(editionsRoot, "260810"));
      mkdirSync(join(editionsRoot, "260811", "_internal"), { recursive: true });
      writeFileSync(join(editionsRoot, "260811", "_internal", "01-categorized.json"), "{ inválido", "utf8");
      writeCategorized(join(editionsRoot, "260812"));

      const results = await runBackfill(editionsRoot, { force: false });
      const byEdition = Object.fromEntries(results.map((r) => [r.edition, r.status]));
      assert.equal(byEdition["260810"], "written");
      assert.equal(byEdition["260811"], "error");
      assert.equal(byEdition["260812"], "written", "260812 não pode ter sido abortada pelo erro da 260811");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--edition AAMMDD inexistente no diretório devolve lista vazia, sem lançar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-missing-"));
    try {
      const editionsRoot = join(dir, "editions");
      mkdirSync(editionsRoot, { recursive: true });
      const results = await runBackfill(editionsRoot, { edition: "999999", force: false });
      assert.deepEqual(results, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
