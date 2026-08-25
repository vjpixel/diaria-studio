/**
 * test/session-registry-safebackup-alarm.test.ts (#6130)
 *
 * Cobre `scripts/lib/session-registry-safebackup-alarm.ts` — a lógica pura
 * (`buildSafeBackupFindings`) do alarme de cópias de conflito do OneDrive em
 * `data/sessions/`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSafeBackupFindings } from "../scripts/lib/session-registry-safebackup-alarm.ts";

describe("buildSafeBackupFindings (#6130)", () => {
  it("lista vazia de backups → nenhum finding", () => {
    assert.deepEqual(buildSafeBackupFindings([]), []);
  });

  it("1 finding POR arquivo backup, com fingerprint = nome do arquivo", () => {
    const files = [
      "continuo-predator-abc-predator-safeBackup-0001.json",
      "overnight-helios-def-predator-safeBackup-0001.json",
    ];
    const findings = buildSafeBackupFindings(files);
    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((f) => f.fingerprint),
      files,
    );
    for (const f of findings) {
      assert.equal(f.check, "session-registry-safebackup");
      assert.equal(f.family, "estado", "condição re-checável — some quando o arquivo é limpo/GC'd");
      assert.equal(f.priority, "P3");
      assert.deepEqual(f.labels, ["bug"]);
      assert.match(f.title, /#|session-registry/i);
      assert.match(f.body, new RegExp(f.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
