/**
 * test/conflict-copy-plan-sweep-12380.test.ts (#12380)
 *
 * Depois do cutover de `data/` para o Google Drive (#12359), a cópia de
 * conflito deixa de ser a `-safeBackup-NNNN` do OneDrive e passa a ser a do
 * rclone bisync: `{nome}.{ext}.conflictN` (sufixo DEPOIS da extensão, medido
 * com rclone v1.75.2 em 08/11/2026, ver `scripts/lib/sync-conflict-copy.ts`).
 * Antes do fix, a restauração de `plan.json` (#10579/#11721) só via
 * `plan-*-safeBackup-*.json`: com `plan.json.conflictN` ao lado, o aviso de
 * `backup-alongside` não saía, e sem `--conflict-resolve newer` (as duas
 * versões ganham sufixo e `plan.json` some) a rodada pareceria inexistente.
 *
 * Só diretórios temporários: nunca toca o `data/` real nem o Drive/OneDrive.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLatestValidPlanSafeBackup,
  findPlanSafeBackups,
  isPlanSafeBackupName,
  readPlanJson,
  recoverPlanFromSafeBackup,
} from "../scripts/lib/plan-safe-backup.ts";
import { ORPHAN_SWEEP_MIN_AGE_MS, sweepContinuoOrphanSessions } from "../scripts/sweep-continuo-orphan-sessions.ts";
import type { SessionRecord } from "../scripts/lib/session-registry.ts";

const PLAN_OLD = { session_id: "s-old", resume_state: { phase: "fase-0" } };
const PLAN_NEW = { session_id: "s-new", resume_state: { phase: "fase-1" } };

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-conflict-12380-"));
  const dir = join(root, "data", "overnight", "261108");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, name: string, content: string, mtimeSec?: number): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe("plan-safe-backup reconhece a cópia do rclone (#12380)", () => {
  it("isPlanSafeBackupName: plan.json.conflictN sim; outros nomes não", () => {
    assert.equal(isPlanSafeBackupName("plan.json.conflict1"), true);
    assert.equal(isPlanSafeBackupName("plan.json.conflict12"), true);
    // OneDrive continua reconhecido.
    assert.equal(isPlanSafeBackupName("plan-300-safeBackup-0001.json"), true);
    assert.equal(isPlanSafeBackupName("plan.json.conflict"), false);
    assert.equal(isPlanSafeBackupName("report.json.conflict1"), false);
    assert.equal(isPlanSafeBackupName("plan.json.tmp.conflict1"), false);
    assert.equal(isPlanSafeBackupName("old-plan.json.conflict1"), false);
    assert.equal(isPlanSafeBackupName("plan.json"), false);
  });

  it("findPlanSafeBackups lista os dois formatos, mais recente primeiro, com seq do sufixo", () => {
    const dir = runDir();
    try {
      put(dir, "plan.json.conflict2", "{}", 1_790_000_300);
      put(dir, "plan-300-safeBackup-0001.json", "{}", 1_790_000_100);
      put(dir, "plan.json.conflict1", "{}", 1_790_000_200);
      put(dir, "report.md.conflict1", "x", 1_790_000_400);
      const got = findPlanSafeBackups(dir).map((b) => [b.name, b.seq]);
      assert.deepEqual(got, [
        ["plan.json.conflict2", 2],
        ["plan.json.conflict1", 1],
        ["plan-300-safeBackup-0001.json", 1],
      ]);
    } finally {
      rmSync(join(dir, "..", "..", ".."), { recursive: true, force: true });
    }
  });

  it("plan.json ausente + duas cópias .conflictN (sem --conflict-resolve newer) → restaura a mais recente", () => {
    const dir = runDir();
    try {
      put(dir, "plan.json.conflict1", JSON.stringify(PLAN_OLD), 1_790_000_000);
      const newer = put(dir, "plan.json.conflict2", JSON.stringify(PLAN_NEW), 1_790_000_500);
      const planPath = join(dir, "plan.json");
      const r = recoverPlanFromSafeBackup(planPath);
      assert.equal(r.status, "restored");
      assert.equal(r.status === "restored" && r.from, newer);
      assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), PLAN_NEW);
      assert.equal(Math.round(statSync(planPath).mtimeMs / 1000), 1_790_000_500);
      // Cópia mantida como evidência.
      assert.equal(existsSync(newer), true);
    } finally {
      rmSync(join(dir, "..", "..", ".."), { recursive: true, force: true });
    }
  });

  it("plan.json presente + plan.json.conflict1 (caso atual, --conflict-resolve newer) → backup-alongside, nada sobrescrito", () => {
    const dir = runDir();
    try {
      const planPath = put(dir, "plan.json", JSON.stringify(PLAN_NEW));
      const copy = put(dir, "plan.json.conflict1", JSON.stringify(PLAN_OLD));
      const r = recoverPlanFromSafeBackup(planPath);
      assert.deepEqual(r, { status: "backup-alongside", backups: [copy] });
      assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), PLAN_NEW);
    } finally {
      rmSync(join(dir, "..", "..", ".."), { recursive: true, force: true });
    }
  });

  it("readPlanJson e findLatestValidPlanSafeBackup veem o plano só na cópia .conflictN", () => {
    const dir = runDir();
    try {
      const copy = put(dir, "plan.json.conflict3", JSON.stringify(PLAN_NEW));
      const planPath = join(dir, "plan.json");
      // Leitura só-leitura (statusline) primeiro: não grava nada.
      const ro = findLatestValidPlanSafeBackup(planPath);
      assert.equal(ro?.path, copy);
      assert.equal(existsSync(planPath), false);
      const warnings: string[] = [];
      const r = readPlanJson(planPath, { warn: (m) => warnings.push(m) });
      assert.equal(r.status, "ok");
      assert.deepEqual(r.status === "ok" && r.plan, PLAN_NEW);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /conflito de sync/);
    } finally {
      rmSync(join(dir, "..", "..", ".."), { recursive: true, force: true });
    }
  });
});

describe("sweep de sessões órfãs do contínuo com cópia .conflictN (#12380)", () => {
  const JOB = "5d791ef6fc2c";
  const TAG = "300";
  const NOW = Date.parse("2026-11-08T12:00:00.000Z");
  const OLD = new Date(NOW - ORPHAN_SWEEP_MIN_AGE_MS - 60_000).toISOString();
  const FRESH = new Date(NOW - 10 * 60_000).toISOString();
  const opts = { jobId: JOB, localTag: TAG, now: NOW, excludeSessionId: `hermes-cron-${JOB}-atual` };
  let root: string;

  const rec = (id: string, over: Partial<SessionRecord> = {}): SessionRecord =>
    ({
      kind: "continuo",
      machineTag: TAG,
      sessionId: `hermes-cron-${JOB}-${id}`,
      startedAt: OLD,
      lastHeartbeat: OLD,
      claimed_issues: [],
      ...over,
    }) as SessionRecord;

  function write(r: SessionRecord): string {
    const p = join(root, "data", "sessions", `continuo-${r.machineTag}-${r.sessionId}.json`);
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  }
  function writeConflict(realPath: string, r: SessionRecord, n = 1): string {
    const p = `${realPath}.conflict${n}`;
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "sweep-conflict-12380-"));
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("claim só na cópia .json.conflict1 → NÃO encerra (soltaria a claim)", () => {
    const real = write(rec("cfclaim"));
    const copy = writeConflict(real, rec("cfclaim", { claimed_issues: [4242] }));
    const r = sweepContinuoOrphanSessions(root, { ...opts });
    const c = r.plan.find((x) => x.sessionId.endsWith("-cfclaim"));
    assert.equal(c?.action, "keep");
    assert.match(c!.reason, /#4242/);
    assert.equal(existsSync(real), true);
    assert.equal(existsSync(copy), true);
  });

  it("heartbeat recente só na cópia .conflictN → mantém", () => {
    const real = write(rec("cffresh"));
    writeConflict(real, rec("cffresh", { lastHeartbeat: FRESH }), 2);
    const r = sweepContinuoOrphanSessions(root, { ...opts });
    assert.equal(r.plan.find((x) => x.sessionId.endsWith("-cffresh"))?.action, "keep");
    assert.equal(existsSync(real), true);
  });

  it("a cópia .conflictN nunca vira candidata por si (uma entrada por sessão real)", () => {
    const real = write(rec("cfsolo"));
    writeConflict(real, rec("cfsolo"));
    const r = sweepContinuoOrphanSessions(root, { ...opts, dryRun: true });
    assert.equal(r.plan.filter((x) => x.sessionId.endsWith("-cfsolo")).length, 1);
  });
});
