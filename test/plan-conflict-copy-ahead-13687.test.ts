/**
 * test/plan-conflict-copy-ahead-13687.test.ts (#13687)
 *
 * Rodada overnight 261119: o bisync de data/ deixou `plan.json.conflict1` ao
 * lado do plano vivo enquanto o plano era regravado várias vezes por minuto.
 * Ali a cópia era a mais velha; o cenário perigoso é o inverso — a cópia
 * `.conflictN` é a MAIS NOVA (tem `merged`/`pr` que o vivo não tem) e o plano
 * vivo perderia esse estado, levando o coordenador a re-despachar issue já
 * mergeada. Antes do fix, `recoverPlanFromSafeBackup` só avisava
 * (`backup-alongside`) e todo leitor seguia com o plano atrasado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCopyIsAheadOf, readPlanJson, recoverPlanFromSafeBackup } from "../scripts/lib/plan-safe-backup.ts";

const SID = "sess-261119";

function planWith(issues: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SID, issues, ...extra };
}

const OLD = planWith([
  { number: 13687, pr: 13700, timeline: { dispatch: "2026-11-19T11:50:00Z", pr_opened: "2026-11-19T12:10:00Z" } },
  { number: 13688, timeline: { dispatch: "2026-11-19T11:51:00Z" } },
]);
const NEW = planWith([
  {
    number: 13687,
    pr: 13700,
    timeline: { dispatch: "2026-11-19T11:50:00Z", pr_opened: "2026-11-19T12:10:00Z", merged: "2026-11-19T12:40:00Z" },
  },
  { number: 13688, pr: 13701, timeline: { dispatch: "2026-11-19T11:51:00Z", pr_opened: "2026-11-19T12:20:00Z" } },
]);

function setup(): { root: string; runDir: string; planPath: string } {
  const root = mkdtempSync(join(tmpdir(), "plan-ahead-13687-"));
  const runDir = join(root, "data", "overnight", "261119");
  mkdirSync(runDir, { recursive: true });
  return { root, runDir, planPath: join(runDir, "plan.json") };
}

test("cenário da issue: .conflictN MAIS NOVO (merged/pr a mais) → promovido; vivo antigo guardado como conflict2", () => {
  const { root, runDir, planPath } = setup();
  try {
    writeFileSync(planPath, JSON.stringify(OLD));
    const copy = join(runDir, "plan.json.conflict1");
    writeFileSync(copy, JSON.stringify(NEW));

    const r = recoverPlanFromSafeBackup(planPath);
    assert.equal(r.status, "promoted");
    assert.ok(r.status === "promoted");
    assert.equal(r.from, copy);
    assert.equal(r.demotedTo, join(runDir, "plan.json.conflict2"));
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), NEW);
    assert.deepEqual(JSON.parse(readFileSync(r.demotedTo, "utf8")), OLD, "plano anterior guardado para auditoria");
    assert.ok(existsSync(copy), "cópia original mantida");

    // Idempotente: a segunda leitura não promove de novo (nada está à frente).
    assert.equal(recoverPlanFromSafeBackup(planPath).status, "backup-alongside");
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), NEW);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPlanJson devolve o plano promovido (o coordenador vê o merged)", () => {
  const { root, runDir, planPath } = setup();
  try {
    writeFileSync(planPath, JSON.stringify(OLD));
    writeFileSync(join(runDir, "plan.json.conflict1"), JSON.stringify(NEW));
    const warnings: string[] = [];
    const read = readPlanJson(planPath, { warn: (m) => warnings.push(m) });
    assert.equal(read.status, "ok");
    assert.ok(read.status === "ok");
    const issues = read.plan.issues as { timeline: Record<string, string> }[];
    assert.equal(issues[0].timeline.merged, "2026-11-19T12:40:00Z");
    assert.match(warnings.join("\n"), /#13687/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caso observado (cópia mais VELHA) → backup-alongside, vivo intocado", () => {
  const { root, runDir, planPath } = setup();
  try {
    writeFileSync(planPath, JSON.stringify(NEW));
    writeFileSync(join(runDir, "plan.json.conflict1"), JSON.stringify(OLD));
    assert.equal(recoverPlanFromSafeBackup(planPath).status, "backup-alongside");
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), NEW);
    assert.equal(existsSync(join(runDir, "plan.json.conflict2")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("divergência (cada lado com algo que o outro não tem) → backup-alongside", () => {
  const { root, runDir, planPath } = setup();
  try {
    const live = planWith([{ number: 13687, timeline: { dispatch: "t1", merged: "t3" } }]);
    const copy = planWith([{ number: 13687, pr: 13700, timeline: { dispatch: "t1", pr_opened: "t2" } }]);
    writeFileSync(planPath, JSON.stringify(live));
    writeFileSync(join(runDir, "plan.json.conflict1"), JSON.stringify(copy));
    assert.equal(recoverPlanFromSafeBackup(planPath).status, "backup-alongside");
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), live);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planCopyIsAheadOf: valor diferente, session_id diferente, pr trocado e cópia igual não contam", () => {
  assert.equal(planCopyIsAheadOf(OLD, NEW), true);
  assert.equal(planCopyIsAheadOf(NEW, OLD), false);
  assert.equal(planCopyIsAheadOf(OLD, OLD), false, "igual não é à frente");
  assert.equal(planCopyIsAheadOf(OLD, { ...NEW, session_id: "outra" }), false);
  const changedTs = planWith([
    { number: 13687, pr: 13700, timeline: { dispatch: "2026-11-19T11:59:00Z", pr_opened: "2026-11-19T12:10:00Z", merged: "x" } },
    { number: 13688, timeline: { dispatch: "2026-11-19T11:51:00Z" } },
  ]);
  assert.equal(planCopyIsAheadOf(OLD, changedTs), false, "marco com timestamp diferente");
  const otherPr = planWith([
    { number: 13687, pr: 9999, timeline: { dispatch: "2026-11-19T11:50:00Z", pr_opened: "2026-11-19T12:10:00Z", merged: "x" } },
    { number: 13688, timeline: { dispatch: "2026-11-19T11:51:00Z" } },
  ]);
  assert.equal(planCopyIsAheadOf(OLD, otherPr), false, "pr diferente");
  // issues em forma de objeto (chave = número) e pr como "#N" também casam.
  const asObject = { session_id: SID, issues: { "13687": { pr: "#13700", timeline: { dispatch: "2026-11-19T11:50:00Z", pr_opened: "2026-11-19T12:10:00Z", merged: "y" } }, "13688": { timeline: { dispatch: "2026-11-19T11:51:00Z" } } } };
  assert.equal(planCopyIsAheadOf(OLD, asObject), true);
});

test("várias cópias à frente → promove a mais adiantada da cadeia", () => {
  const { root, runDir, planPath } = setup();
  try {
    const MID = planWith([
      { number: 13687, pr: 13700, timeline: { dispatch: "2026-11-19T11:50:00Z", pr_opened: "2026-11-19T12:10:00Z" } },
      { number: 13688, pr: 13701, timeline: { dispatch: "2026-11-19T11:51:00Z" } },
    ]);
    writeFileSync(planPath, JSON.stringify(OLD));
    writeFileSync(join(runDir, "plan.json.conflict1"), JSON.stringify(NEW));
    writeFileSync(join(runDir, "plan.json.conflict2"), JSON.stringify(MID));
    const r = recoverPlanFromSafeBackup(planPath);
    assert.equal(r.status, "promoted");
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), NEW);
    assert.ok(r.status === "promoted");
    assert.equal(r.demotedTo, join(runDir, "plan.json.conflict3"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state-changed-tracker grava o plano de forma atômica (sem writeFileSync cru)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "lib", "state-changed-tracker.ts"), "utf8");
  assert.doesNotMatch(src, /writeFileSync\(/);
  assert.match(src, /writeFileAtomic\(planPath/);
});
