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
import { collapseGroupedFindings } from "../scripts/lib/alarm-issues.ts";

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

  it("#6562: todos os findings compartilham o mesmo `group` GLOBAL do check", () => {
    const files = ["a-safeBackup-0001.json", "b-safeBackup-0001.json", "c-safeBackup-0001.json"];
    const findings = buildSafeBackupFindings(files);
    const groups = new Set(findings.map((f) => f.group));
    assert.equal(groups.size, 1, "todo arquivo cai no mesmo grupo — é o que colapsa N arquivos em 1 issue");
    assert.ok(findings[0]!.group, "group precisa estar setado (não undefined)");
  });

  it("#6562: N findings do check → 1 único finding efetivo após collapseGroupedFindings, corpo lista os N fingerprints", () => {
    const files = ["a-safeBackup-0001.json", "b-safeBackup-0001.json", "c-safeBackup-0001.json"];
    const findings = buildSafeBackupFindings(files);
    const collapsed = collapseGroupedFindings(findings);
    assert.equal(collapsed.length, 1, "37 arquivos (ou 3, ou N) sempre colapsam pra 1 finding efetivo — 1 issue");
    for (const file of files) {
      assert.match(collapsed[0]!.body, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
