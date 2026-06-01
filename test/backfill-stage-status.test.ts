/**
 * test/backfill-stage-status.test.ts (#1661)
 *
 * Regressão: backfill-stage-status enumerava data/editions sem validar o nome
 * AAMMDD, então dirs de backup (260527-backup-…, 260422-local-backup) entravam
 * no scan e — sem --dry-run — tinham seu stage-status.json sobrescrito por
 * applyFixes. listEditionDirs agora aplica isValidEditionDir (mesmo guard do
 * dedup.ts, #1567) pra excluí-los.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEditionDirs } from "../scripts/backfill-stage-status.ts";

function setup(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "bss-"));
  for (const n of names) mkdirSync(join(root, n), { recursive: true });
  return root;
}

describe("listEditionDirs — exclui dirs de backup (#1661)", () => {
  it("regression #1661: backup dirs com sufixo são excluídos do scan", () => {
    const dir = setup([
      "260528",
      "260527-backup-20260526203126",
      "260422-local-backup",
    ]);
    // Sem o guard isValidEditionDir, os 2 backups entrariam (são diretórios) e
    // seriam alvos de escrita destrutiva.
    assert.deepEqual(listEditionDirs(dir).sort(), ["260528"]);
  });

  it("aceita múltiplas edições válidas e barra AAMMDD inválido (dia 99)", () => {
    const dir = setup(["260528", "260601", "not-an-edition", "260999"]);
    assert.deepEqual(listEditionDirs(dir).sort(), ["260528", "260601"]);
  });

  it("--edition filter restringe a uma edição, e ainda valida o nome", () => {
    const dir = setup(["260528", "260601", "260527-backup-x"]);
    assert.deepEqual(listEditionDirs(dir, "260601"), ["260601"]);
    // filtro apontando pra um backup → vazio (o guard rejeita mesmo com filtro)
    assert.deepEqual(listEditionDirs(dir, "260527-backup-x"), []);
  });
});
