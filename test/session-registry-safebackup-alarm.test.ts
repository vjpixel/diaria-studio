/**
 * test/session-registry-safebackup-alarm.test.ts (#6130)
 *
 * Cobre `scripts/lib/session-registry-safebackup-alarm.ts` — a lógica pura
 * (`buildSafeBackupFindings`) do alarme de cópias de conflito do OneDrive em
 * `data/sessions/`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSafeBackupFindings,
  buildAggregatedSafeBackupFinding,
  resolveSafeBackupFindings,
  SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD,
} from "../scripts/lib/session-registry-safebackup-alarm.ts";

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

describe("buildAggregatedSafeBackupFinding (#6562)", () => {
  it("agrega N arquivos numa única finding com fingerprint fixo, listando todos no corpo", () => {
    const files = ["b-safeBackup-0001.json", "a-safeBackup-0002.json"];
    const finding = buildAggregatedSafeBackupFinding(files);
    assert.equal(finding.check, "session-registry-safebackup");
    assert.equal(finding.fingerprint, "estreia-aggregate");
    assert.equal(finding.family, "estado");
    assert.equal(finding.priority, "P3");
    assert.deepEqual(finding.labels, ["bug"]);
    assert.match(finding.title, /2.*cópias/i);
    for (const file of files) {
      assert.match(finding.body, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});

describe("resolveSafeBackupFindings (#6562 — modo de estreia)", () => {
  it("lista vazia → nenhum finding, independente do state", () => {
    assert.deepEqual(resolveSafeBackupFindings([], true), []);
    assert.deepEqual(resolveSafeBackupFindings([], false), []);
  });

  it("state NÃO vazio → sempre 1-por-arquivo, mesmo acima do teto", () => {
    const files = Array.from(
      { length: SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD + 5 },
      (_, i) => `file-${i}-safeBackup-0001.json`,
    );
    const findings = resolveSafeBackupFindings(files, false);
    assert.equal(findings.length, files.length);
    assert.deepEqual(
      findings.map((f) => f.fingerprint).sort(),
      [...files].sort(),
    );
  });

  it("state vazio + volume ABAIXO/NO teto → continua 1-por-arquivo (comportamento preservado)", () => {
    const files = Array.from(
      { length: SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD },
      (_, i) => `file-${i}-safeBackup-0001.json`,
    );
    const findings = resolveSafeBackupFindings(files, true);
    assert.equal(findings.length, files.length);
  });

  it("state vazio + volume ACIMA do teto → 1 finding agregado, não 1-por-arquivo", () => {
    const files = Array.from(
      { length: SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD + 1 },
      (_, i) => `file-${i}-safeBackup-0001.json`,
    );
    const findings = resolveSafeBackupFindings(files, true);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fingerprint, "estreia-aggregate");
  });
});
