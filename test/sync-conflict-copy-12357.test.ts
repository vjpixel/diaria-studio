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
  registerSession,
  claimIssue,
  unclaimIssue,
  endSession,
  listActiveSessions,
  planSessionGc,
  garbageCollectSessions,
  findLiveMergeGrant,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";
import { findLiveMergeGrantFile, RCLONE_SESSION_CONFLICT_RE } from "../.claude/hooks/consume-merge-grant-on-merge.mjs";
import { existsSync, readdirSync } from "node:fs";
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

// ─── Review da #12357: cópias `.conflictN` em todos os caminhos ─────────────

const T0 = "2026-11-08T10:00:00.000Z";
const T1 = "2026-11-08T10:01:00.000Z";
const T2 = "2026-11-08T10:02:00.000Z";
const T3 = "2026-11-08T10:03:00.000Z";

/** Sessão real com claims [1, 2], depois `unclaim 2`; a `.conflict1` é a
 * versão ANTERIOR ao unclaim, criada depois dele (o perdedor do rclone é
 * sempre o mtime mais antigo). */
function releaseThenConflict(): { root: string; real: string } {
  const root = freshRoot();
  registerSession(root, "develop", "s1", { tag: "Neo", startedAt: T0 });
  assert.equal(claimIssue(root, "develop", "s1", 1, "Neo", T1), true);
  assert.equal(claimIssue(root, "develop", "s1", 2, "Neo", T2), true);
  const real = join(sessionsDir(root), "develop-Neo-s1.json");
  const beforeUnclaim = readFileSync(real, "utf8");
  assert.equal(unclaimIssue(root, "develop", "s1", 2, "Neo", T3).reason, "unclaimed");
  writeFileSync(`${real}.conflict1`, beforeUnclaim, "utf8");
  return { root, real };
}

describe("liberação seguida de conflito .conflictN (review #12357)", () => {
  it("o real fica [1]; a cópia antiga carrega [1, 2] com claim anterior ao heartbeat do real", () => {
    const { real } = releaseThenConflict();
    const r = JSON.parse(readFileSync(real, "utf8")) as SessionRecord;
    assert.deepEqual(r.claimed_issues, [1]);
    const c = JSON.parse(readFileSync(`${real}.conflict1`, "utf8")) as SessionRecord;
    assert.deepEqual(c.claimed_issues, [1, 2]);
  });

  it("reconcileClaims NÃO ressuscita a claim solta (regra #6698, igual à -safeBackup-)", () => {
    const { root, real } = releaseThenConflict();
    const entry = reconcileClaims(root).find((x) => x.realPath === real);
    assert.ok(entry);
    assert.deepEqual(entry.addedIssues, []);
    assert.deepEqual((JSON.parse(readFileSync(real, "utf8")) as SessionRecord).claimed_issues, [1]);
  });

  it("planSafeBackupCleanup recolhe a cópia (removable), encerrando o falso-positivo", () => {
    const { root } = releaseThenConflict();
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "removable");
  });

  it("read-path: a união fail-safe (#6130) mostra a claim enquanto a cópia existir — contrato documentado em sync-conflict-copy.ts", () => {
    const { root, real } = releaseThenConflict();
    assert.deepEqual([...(readEffectiveSessionRecord(root, real)?.claimed_issues ?? [])].sort(), [1, 2]);
    // Mesma forma em disco com a cópia do OneDrive dá a mesma leitura: a
    // .conflictN não ganhou regra própria nem mais fraca.
    const root2 = freshRoot();
    const real2 = writeRaw(root2, "develop-Neo-s1.json", JSON.parse(readFileSync(real, "utf8")));
    writeFileSync(join(sessionsDir(root2), "develop-Neo-s1-Neo-safeBackup-0001.json"), readFileSync(`${real}.conflict1`));
    assert.deepEqual(
      [...(readEffectiveSessionRecord(root2, real2)?.claimed_issues ?? [])].sort(),
      [...(readEffectiveSessionRecord(root, real)?.claimed_issues ?? [])].sort(),
    );
  });

  it("unclaim com a .conflictN JÁ no disco limpa a cópia também (#6567 alcança .conflictN)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s1", { tag: "Neo", startedAt: T0 });
    claimIssue(root, "develop", "s1", 1, "Neo", T1);
    claimIssue(root, "develop", "s1", 2, "Neo", T2);
    const real = join(sessionsDir(root), "develop-Neo-s1.json");
    writeFileSync(`${real}.conflict1`, readFileSync(real));
    unclaimIssue(root, "develop", "s1", 2, "Neo", T3);
    assert.deepEqual((JSON.parse(readFileSync(`${real}.conflict1`, "utf8")) as SessionRecord).claimed_issues, [1]);
    assert.deepEqual(readEffectiveSessionRecord(root, real)?.claimed_issues, [1]);
  });
});

describe("cópia .conflictN com claim viva que o real não tem (review #12357)", () => {
  it("planSafeBackupCleanup NÃO a remove (pending-reconciliation)", () => {
    const root = freshRoot();
    writeRaw(root, "develop-Neo-s1.json", { ...BASE, lastHeartbeat: T1, claimed_issues: [1] });
    writeRaw(root, "develop-Neo-s1.json.conflict1", {
      ...BASE,
      lastHeartbeat: T2,
      claimed_issues: [1, 5],
      claimed_issues_at: { "5": T2 },
    });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "pending-reconciliation");
  });
});

describe("real removido por endSession, só a .conflictN sobrou (review #12357)", () => {
  it("endSession carimba endedAt na .conflictN e ela não vira sessão ativa", () => {
    const root = freshRoot();
    const now = Date.now();
    const iso = new Date(now).toISOString();
    registerSession(root, "develop", "s1", { tag: "Neo", startedAt: iso });
    claimIssue(root, "develop", "s1", 4, "Neo", iso);
    const real = join(sessionsDir(root), "develop-Neo-s1.json");
    writeFileSync(`${real}.conflict1`, readFileSync(real));
    assert.equal(endSession(root, "develop", "s1", "Neo"), true);
    assert.equal(existsSync(real), false);
    const copy = JSON.parse(readFileSync(`${real}.conflict1`, "utf8")) as SessionRecord;
    assert.ok(copy.endedAt, "endSession propagou endedAt à cópia .conflictN");
    assert.equal(listActiveSessions(root, now).some((x) => x.sessionId === "s1"), false);
  });

  it("órfã .conflictN de heartbeat velho não é sessão ativa", () => {
    const root = freshRoot();
    writeRaw(root, "develop-Neo-s1.json.conflict1", { ...BASE, claimed_issues: [4] });
    assert.equal(listActiveSessions(root, Date.parse("2026-11-08T12:00:00Z")).some((x) => x.sessionId === "s1"), false);
  });
});

describe("GC de órfã .conflictN (review #12357)", () => {
  it("planSessionGc/garbageCollectSessions recolhem a órfã velha e mantêm a recente", () => {
    const root = freshRoot();
    const now = Date.parse("2026-12-08T12:00:00Z");
    const old = writeRaw(root, "develop-Neo-s1.json.conflict1", { ...BASE });
    const recent = writeRaw(root, "develop-Neo-s2.json.conflict1", {
      ...BASE,
      sessionId: "s2",
      lastHeartbeat: new Date(now - 60_000).toISOString(),
    });
    const plan = planSessionGc(root, { now, localMachineTag: "Neo", isPidAlive: () => false });
    const byFile = (p: string) => plan.find((e) => e.files.includes(p));
    assert.equal(byFile(old)?.action, "removed");
    assert.match(byFile(old)!.identity, /^orphan-backup:develop-Neo-s1\.json\.conflict1$/);
    assert.equal(byFile(recent)?.action, "kept");
    garbageCollectSessions(root, { now, localMachineTag: "Neo", isPidAlive: () => false });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
  });
});

describe("merge_grant em cópia .conflictN (review #12357)", () => {
  function coordWithGrantOnlyInCopy(): { root: string; now: number } {
    const root = freshRoot();
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const rec: SessionRecord = { kind: "develop", machineTag: "Neo", sessionId: "coord", startedAt: iso, lastHeartbeat: iso };
    writeRaw(root, "develop-Neo-coord.json", rec);
    writeRaw(root, "develop-Neo-coord.json.conflict1", {
      ...rec,
      merge_grant: { grantedBy: "coord", grantedTo: "interativa", grantedAt: iso, pr: 12379 },
    });
    return { root, now };
  }

  it("findLiveMergeGrant acha o grant mas diz que ele veio de cópia (mergeGrantLivesInRealFile ignora .conflictN)", () => {
    const { root, now } = coordWithGrantOnlyInCopy();
    const found = findLiveMergeGrant(root, "interativa", now);
    assert.ok(found);
    assert.equal(found.source, "backup");
  });

  it("hook: findLiveMergeGrantFile vê a cópia .json.conflictN só com includeBackups (#6952)", () => {
    const { root, now } = coordWithGrantOnlyInCopy();
    assert.equal(findLiveMergeGrantFile(root, "interativa", now), null);
    const found = findLiveMergeGrantFile(root, "interativa", now, true);
    assert.ok(found);
    assert.match(found.path, /develop-Neo-coord\.json\.conflict1$/);
  });

  it("regex do hook espelha rcloneConflictOriginalName pra arquivo de sessão", () => {
    for (const n of ["develop-Neo-s1.json.conflict1", "a.json.conflict12"]) {
      assert.equal(RCLONE_SESSION_CONFLICT_RE.test(n), true, n);
      assert.ok(rcloneConflictOriginalName(n)?.endsWith(".json"), n);
    }
    for (const n of [".json.conflict1", "a.txt.conflict1", "a.json.conflict", "a.json", "a-safeBackup-0001.json"]) {
      assert.equal(RCLONE_SESSION_CONFLICT_RE.test(n), false, n);
    }
  });
});

describe("findExistingSessionFileAnyKind nunca escolhe a .conflictN (review #12357)", () => {
  it("re-registro com só a cópia .conflictN no disco não a adota como arquivo da sessão", () => {
    const root = freshRoot();
    // Cópia de OUTRO kind da mesma sessão: se fosse escolhida como arquivo
    // existente, o registro "promoveria" a partir dela e removeria a cópia.
    const copy = writeRaw(root, "interactive-Neo-s9.json.conflict1", { ...BASE, kind: "interactive", sessionId: "s9" });
    registerSession(root, "develop", "s9", { tag: "Neo" });
    const names = readdirSync(sessionsDir(root)).sort();
    assert.ok(names.includes("develop-Neo-s9.json"), names.join(","));
    assert.equal(existsSync(copy), true, "a cópia de conflito não foi tratada como o arquivo real da sessão");
  });
});
