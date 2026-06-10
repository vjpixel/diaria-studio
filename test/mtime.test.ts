/**
 * test/mtime.test.ts (#2048 item 10)
 *
 * Testa o helper `mtimeMs` extraído de `upload-html-public.ts`.
 * Verifica: arquivo existente → número; arquivo ausente → null.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mtimeMs } from "../scripts/lib/mtime.ts";

describe("mtimeMs (#2048 item 10)", () => {
  it("retorna número para arquivo existente", () => {
    const dir = mkdtempSync(join(tmpdir(), "mtime-test-"));
    const p = join(dir, "test.txt");
    try {
      writeFileSync(p, "hello", "utf8");
      const t = mtimeMs(p);
      assert.ok(typeof t === "number", "deve retornar number");
      assert.ok(t > 0, "deve ser timestamp positivo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null para arquivo ausente (ENOENT)", () => {
    const result = mtimeMs("/caminho/que/nao/existe/arquivo.txt");
    assert.equal(result, null);
  });

  it("retorna null, não 0 — semântica de 'ausente' vs 'sempre-stale'", () => {
    const result = mtimeMs("/nao/existe.txt");
    assert.equal(result, null, "null = ausente; 0 seria 'sempre-stale' — não o contrato deste helper");
    assert.notEqual(result, 0);
  });
});
