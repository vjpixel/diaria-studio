/**
 * test/sync-conflict-copy-12357.test.ts (#12357, épica #12353)
 *
 * Cópia de conflito do rclone bisync (`--conflict-loser num`):
 * `{nome-inteiro}.conflictN`, sufixo DEPOIS da extensão (formato medido com
 * o rclone v1.75.2 em 08/11/2026, ver `scripts/lib/sync-conflict-copy.ts`).
 * Antes do #12357 o `session-registry` só listava `*.json`: a cópia
 * `x.json.conflict1` era invisível — a claim que só sobreviveu nela se perdia
 * e o GC nunca a recolhia. Isolado em tmpdir, nunca toca `data/` real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSyncConflictCopyName,
  isRcloneConflictName,
  isOnedriveSafeBackupName,
  rcloneConflictOriginalName,
  conflictCopyBelongsToStem,
} from "../scripts/lib/sync-conflict-copy.ts";
import {
  sessionsDir,
  readEffectiveSessionRecord,
  planSafeBackupCleanup,
  reconcileClaims,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";
import {
  isBackupSiblingFilename,
  backupSiblingCanonicalName,
  isBackupSiblingProtected,
} from "../scripts/lib/data-dir-gc-policy.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `sync-conflict-copy-12357-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function writeRaw(root: string, name: string, record: Partial<SessionRecord>): string {
  const p = join(sessionsDir(root), name);
  writeFileSync(p, JSON.stringify(record), "utf8");
  return p;
}

const BASE: SessionRecord = {
  kind: "develop",
  machineTag: "Neo",
  sessionId: "s1",
  startedAt: "2026-11-01T00:00:00.000Z",
  lastHeartbeat: "2026-11-01T00:00:00.000Z",
};

describe("sync-conflict-copy — nomes (#12357)", () => {
  it("reconhece o formato medido do rclone: sufixo depois da extensão, N crescente", () => {
    for (const n of ["s-123.json.conflict1", "s-123.json.conflict2", "noext.conflict1", "arch.tar.gz.conflict1"]) {
      assert.equal(isRcloneConflictName(n), true, n);
      assert.equal(isSyncConflictCopyName(n), true, n);
    }
    assert.equal(rcloneConflictOriginalName("s-123.json.conflict2"), "s-123.json");
    assert.equal(rcloneConflictOriginalName("arch.tar.gz.conflict1"), "arch.tar.gz");
  });

  it("não confunde com nome comum que só contém 'conflict'", () => {
    for (const n of ["conflict1.json", "s.conflict.json", "s.json.conflict", "s.json.conflictX", "conflicts.md"]) {
      assert.equal(isRcloneConflictName(n), false, n);
    }
    assert.equal(rcloneConflictOriginalName(".conflict1"), null);
  });

  it("segue reconhecendo a cópia do OneDrive", () => {
    assert.equal(isOnedriveSafeBackupName("develop-Neo-s1-Neo-safeBackup-0001.json"), true);
    assert.equal(isSyncConflictCopyName("develop-Neo-s1-Neo-safeBackup-0001.json"), true);
    assert.equal(isSyncConflictCopyName("develop-Neo-s1.json"), false);
  });

  it("dono da cópia: rclone casa o nome original EXATO, OneDrive casa o prefixo", () => {
    assert.equal(conflictCopyBelongsToStem("develop-Neo-s1.json.conflict1", "develop-Neo-s1", ".json"), true);
    // stem mais curto que é prefixo NÃO leva a cópia rclone de outro arquivo
    assert.equal(conflictCopyBelongsToStem("develop-Neo-s1-2.json.conflict1", "develop-Neo-s1", ".json"), false);
    assert.equal(conflictCopyBelongsToStem("develop-Neo-s1-Neo-safeBackup-0001.json", "develop-Neo-s1", ".json"), true);
    assert.equal(conflictCopyBelongsToStem("develop-Neo-s1.json", "develop-Neo-s1", ".json"), false);
  });
});

describe("session-registry enxerga a cópia .conflictN (#12357)", () => {
  it("claim que só sobreviveu na cópia do rclone entra no registro efetivo", () => {
    const root = freshRoot();
    const real = writeRaw(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRaw(root, "develop-Neo-s1.json.conflict1", { ...BASE, claimed_issues: [1, 2] });
    const rec = readEffectiveSessionRecord(root, real);
    assert.ok(rec);
    assert.deepEqual([...(rec.claimed_issues ?? [])].sort(), [1, 2]);
  });

  it("cópia rclone já refletida no real é recolhível pelo cleanup (antes ficava pra sempre)", () => {
    const root = freshRoot();
    writeRaw(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1, 2] });
    writeRaw(root, "develop-Neo-s1.json.conflict1", { ...BASE, claimed_issues: [1, 2] });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "removable");
    assert.equal(plan[0]!.backupPaths.length, 1);
    assert.match(plan[0]!.backupPaths[0]!, /develop-Neo-s1\.json\.conflict1$/);
  });

  it("reconcileClaims funde no real a claim da cópia rclone", () => {
    const root = freshRoot();
    const real = writeRaw(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRaw(root, "develop-Neo-s1.json.conflict1", { ...BASE, claimed_issues: [1, 7] });
    const res = reconcileClaims(root);
    const entry = res.find((r) => r.realPath === real);
    assert.ok(entry);
    assert.deepEqual(entry.addedIssues, [7]);
    const after = JSON.parse(readFileSync(real, "utf8")) as SessionRecord;
    assert.ok((after.claimed_issues ?? []).includes(7));
  });

  it("cópia rclone de OUTRO arquivo não é atribuída ao stem mais curto", () => {
    const root = freshRoot();
    const real = writeRaw(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRaw(root, "develop-Neo-s1-2.json", { ...BASE, sessionId: "s1-2", claimed_issues: [5] });
    writeRaw(root, "develop-Neo-s1-2.json.conflict1", { ...BASE, sessionId: "s1-2", claimed_issues: [5, 9] });
    const rec = readEffectiveSessionRecord(root, real);
    assert.deepEqual(rec?.claimed_issues, [1]);
  });

  it("arquivos .conflictN que não são de sessão (.txt, dotfile) ficam de fora", () => {
    const root = freshRoot();
    const real = writeRaw(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeFileSync(join(sessionsDir(root), "notas.txt.conflict1"), "x");
    writeFileSync(join(sessionsDir(root), ".merge-lock.json.conflict1"), "{}");
    assert.deepEqual(readEffectiveSessionRecord(root, real)?.claimed_issues, [1]);
    assert.deepEqual(planSafeBackupCleanup(root), []);
  });
});

describe("gc-data-dir trata .conflictN como cópia-irmã (#12357)", () => {
  it("reconhece e devolve o canônico", () => {
    assert.equal(isBackupSiblingFilename("run-log.jsonl.conflict1"), true);
    assert.equal(backupSiblingCanonicalName("run-log.jsonl.conflict3"), "run-log.jsonl");
    assert.equal(backupSiblingCanonicalName("cache-Neo.json.conflict1"), "cache.json");
  });
  it("store SQLite e arquivo editorial seguem protegidos", () => {
    assert.equal(isBackupSiblingProtected("clarice-users.db.conflict1"), true);
    assert.equal(isBackupSiblingProtected("editions/2611/261108/02-reviewed.md.conflict1"), true);
    assert.equal(isBackupSiblingProtected("drive-cache.json.conflict1"), false);
  });
});
