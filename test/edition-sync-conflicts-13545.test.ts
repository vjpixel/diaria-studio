/**
 * test/edition-sync-conflicts-13545.test.ts (#13545)
 *
 * Edição 261118: o sync renomeou arquivos da edição para `.conflictN` e o
 * Stage 4 seguiu sem perceber. A invariante `edition-sync-conflicts` acusa a
 * cópia e o arquivo obrigatório ausente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { checkEditionSyncConflicts, EDITION_REQUIRED_FILES } from "../scripts/lib/invariant-checks/stage-4.ts";

function edition(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-sync-conflict-13545-"));
  for (const f of files) {
    const p = join(dir, f);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
  }
  return dir;
}

describe("invariante edition-sync-conflicts (#13545)", () => {
  it("registrada no Stage 4 como error", () => {
    assert.ok(getRulesForStage(4).some((r) => r.id === "edition-sync-conflicts"));
  });

  it("edição íntegra não acusa", () => {
    const dir = edition([...EDITION_REQUIRED_FILES]);
    try { assert.deepEqual(checkEditionSyncConflicts(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("acusa .conflictN e o original ausente", () => {
    const dir = edition(["_internal/01-approved.json", "06-public-images.json", "02-reviewed.md.conflict2"]);
    try {
      const v = checkEditionSyncConflicts(dir);
      assert.ok(v.every((x) => x.severity === "error"));
      assert.ok(v.some((x) => x.file === "02-reviewed.md.conflict2"));
      assert.ok(v.some((x) => x.file === "02-reviewed.md" && /ausente/.test(x.message)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ignora cópias já arquivadas em _conflitos-*", () => {
    const dir = edition([...EDITION_REQUIRED_FILES, "_internal/_conflitos-261118/01-approved.json.conflict1"]);
    try { assert.deepEqual(checkEditionSyncConflicts(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
