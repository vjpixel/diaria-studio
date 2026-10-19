/**
 * test/plan-safe-backup.test.ts (#10579)
 *
 * Regressão do incidente da rodada 261019d: `data/overnight/261019d/plan.json`
 * sumiu no meio da Fase 1 e o OneDrive deixou `plan-300-safeBackup-0001.json`
 * no lugar. Antes do fix, o resolver de path via o slot como livre
 * (`mode: "fresh"`) e o coordenador reescreveria o plano por cima do estado
 * vivo; o watchdog deixava de ver a rodada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPlanSafeBackups,
  isPlanSafeBackupName,
  recoverPlanFromSafeBackup,
} from "../scripts/lib/plan-safe-backup.ts";
import { createFsPlanProbe, resolvePlanPath } from "../scripts/lib/plan-path-resolution.ts";
import { findActiveRun } from "../scripts/overnight-watchdog.ts";

const SID = "sess-261019d";
const PLAN = {
  session_id: SID,
  resume_state: { phase: "fase-1" },
  waves: [{ composed_at: "2026-10-19T03:10:00Z", unit_count: 2 }],
};

function setup(): { root: string; runDir: string; planPath: string } {
  const root = mkdtempSync(join(tmpdir(), "plan-safe-backup-"));
  const runDir = join(root, "data", "overnight", "261019d");
  mkdirSync(runDir, { recursive: true });
  return { root, runDir, planPath: join(runDir, "plan.json") };
}

function writeBackup(runDir: string, name: string, content: string, mtimeSec?: number): string {
  const p = join(runDir, name);
  writeFileSync(p, content);
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

test("isPlanSafeBackupName reconhece o nome real do incidente e rejeita os demais", () => {
  assert.equal(isPlanSafeBackupName("plan-300-safeBackup-0001.json"), true);
  assert.equal(isPlanSafeBackupName("plan-DESKTOP-ABC-safeBackup-0012.json"), true);
  assert.equal(isPlanSafeBackupName("plan.json"), false);
  assert.equal(isPlanSafeBackupName("report-300-safeBackup-0001.md"), false);
  assert.equal(isPlanSafeBackupName("plan-300-safeBackup-0001.json.tmp"), false);
});

test("plan.json ausente + plan-300-safeBackup-0001.json → restaura conteúdo e mtime do backup", () => {
  const { root, runDir, planPath } = setup();
  try {
    const backup = writeBackup(runDir, "plan-300-safeBackup-0001.json", JSON.stringify(PLAN), 1_790_000_000);
    const r = recoverPlanFromSafeBackup(planPath);
    assert.equal(r.status, "restored");
    assert.equal(r.status === "restored" && r.from, backup);
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), PLAN);
    assert.equal(Math.round(statSync(planPath).mtimeMs / 1000), 1_790_000_000);
    assert.ok(existsSync(backup), "backup é mantido como evidência");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vários backups → escolhe o de mtime mais recente e pula JSON truncado", () => {
  const { root, runDir, planPath } = setup();
  try {
    writeBackup(runDir, "plan-300-safeBackup-0001.json", JSON.stringify({ ...PLAN, v: "velho" }), 1_790_000_000);
    writeBackup(runDir, "plan-300-safeBackup-0003.json", '{"session_id": "trunc', 1_790_000_900);
    writeBackup(runDir, "plan-neo-safeBackup-0002.json", JSON.stringify({ ...PLAN, v: "novo" }), 1_790_000_500);
    assert.equal(findPlanSafeBackups(runDir)[0].name, "plan-300-safeBackup-0003.json");
    const r = recoverPlanFromSafeBackup(planPath);
    assert.equal(r.status, "restored");
    assert.equal(JSON.parse(readFileSync(planPath, "utf8")).v, "novo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("só backups ilegíveis → unrecoverable, nada escrito", () => {
  const { root, runDir, planPath } = setup();
  try {
    writeBackup(runDir, "plan-300-safeBackup-0001.json", "{ nope");
    assert.equal(recoverPlanFromSafeBackup(planPath).status, "unrecoverable");
    assert.equal(existsSync(planPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan.json presente + backup ao lado → só avisa, plano vivo intocado", () => {
  const { root, runDir, planPath } = setup();
  try {
    writeFileSync(planPath, JSON.stringify({ ...PLAN, v: "vivo" }));
    writeBackup(runDir, "plan-300-safeBackup-0001.json", JSON.stringify({ ...PLAN, v: "backup" }));
    assert.equal(recoverPlanFromSafeBackup(planPath).status, "backup-alongside");
    assert.equal(JSON.parse(readFileSync(planPath, "utf8")).v, "vivo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sem backup → clean", () => {
  const { root, planPath } = setup();
  try {
    assert.equal(recoverPlanFromSafeBackup(planPath).status, "clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver de path: com só o backup em disco, a sessão dona RETOMA (não vê slot livre)", () => {
  const { root, runDir } = setup();
  try {
    writeBackup(runDir, "plan-300-safeBackup-0001.json", JSON.stringify(PLAN));
    const r = resolvePlanPath(join(root, "data", "overnight"), "261019d", SID, createFsPlanProbe());
    assert.equal(r.mode, "resume");
    assert.equal(r.suffix, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog: rodada overnight cujo plan.json virou safeBackup continua visível", () => {
  const { root, runDir } = setup();
  try {
    writeBackup(runDir, "plan-300-safeBackup-0001.json", JSON.stringify(PLAN));
    const found = findActiveRun(root, "overnight", { lastActivityOf: () => ({ ts: 0, source: "test" }) });
    assert.ok(found, "rodada deveria ser encontrada");
    assert.equal(found?.aammdd, "261019d");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
