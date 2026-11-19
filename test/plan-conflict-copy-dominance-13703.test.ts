/**
 * test/plan-conflict-copy-dominance-13703.test.ts (#13703)
 *
 * Review consolidado da rodada overnight 261119b sobre a PR #13691 (#13687):
 *
 * 1. A promoção da cópia de conflito comparava só `timeline`/`pr`. Uma cópia
 *    com evento novo de `timeline` era promovida mesmo quando o plano vivo
 *    tinha mudanças próprias em `status`/`motivo`, `waves` ou no contador de
 *    reespera de CI (`ci_queue_reawaits`) — essas mudanças sobreviviam só no
 *    `plan.json.conflictN`.
 * 2. O vivo rebaixado ganhava mtime = agora e virava o backup "mais novo"; se
 *    o `plan.json` sumisse depois (#10579), o restauro escolhia a versão
 *    atrasada e perdia `merged`/`pr`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCopyIsAheadOf, recoverPlanFromSafeBackup } from "../scripts/lib/plan-safe-backup.ts";

const SID = "sess-261119b";

const LIVE_BASE = {
  session_id: SID,
  waves: [{ n: 1, issues: [13703] }],
  ci_queue_reawaits: { "13710": 1 },
  issues: [{ number: 13703, status: "pr-aberta", pr: 13710, timeline: { dispatch: "t1", pr_opened: "t2" } }],
};

/** Cópia "à frente" só por timeline (evento `ci_green` novo). */
function copyWithNewTimeline(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...LIVE_BASE,
    issues: [{ number: 13703, status: "pr-aberta", pr: 13710, timeline: { dispatch: "t1", pr_opened: "t2", ci_green: "t3" } }],
    ...over,
  };
}

function setup(): { root: string; runDir: string; planPath: string } {
  const root = mkdtempSync(join(tmpdir(), "plan-dominance-13703-"));
  const runDir = join(root, "data", "overnight", "261119b");
  mkdirSync(runDir, { recursive: true });
  return { root, runDir, planPath: join(runDir, "plan.json") };
}

test("controle: cópia com timeline novo e o resto igual continua à frente", () => {
  assert.equal(planCopyIsAheadOf(LIVE_BASE, copyWithNewTimeline()), true);
});

test("defeito 1: vivo com status/motivo próprio da issue → cópia com timeline novo NÃO está à frente", () => {
  const live = {
    ...LIVE_BASE,
    issues: [{ ...LIVE_BASE.issues[0], status: "pulada", motivo: "pr-em-voo" }],
  };
  assert.equal(planCopyIsAheadOf(live, copyWithNewTimeline()), false);
});

test("defeito 1: vivo com onda nova (waves) → não está à frente", () => {
  const live = { ...LIVE_BASE, waves: [...LIVE_BASE.waves, { n: 2, issues: [13704] }] };
  assert.equal(planCopyIsAheadOf(live, copyWithNewTimeline()), false);
});

test("defeito 1: vivo com contador de reespera de CI maior → não está à frente", () => {
  const live = { ...LIVE_BASE, ci_queue_reawaits: { "13710": 2 } };
  assert.equal(planCopyIsAheadOf(live, copyWithNewTimeline()), false);
});

test("defeito 1: vivo com state_changed_pending que a cópia não tem → não está à frente", () => {
  const live = { ...LIVE_BASE, state_changed_pending: [{ issue: 13703, at: "t9" }] };
  assert.equal(planCopyIsAheadOf(live, copyWithNewTimeline()), false);
});

test("subconjunto vale: a cópia pode ter campos e ondas a mais, e null no vivo cabe em qualquer valor", () => {
  const live = { ...LIVE_BASE, resume_state: null, issues: [{ ...LIVE_BASE.issues[0], motivo: null }] };
  const copy = copyWithNewTimeline({
    waves: [...LIVE_BASE.waves, { n: 2, issues: [13704] }],
    ci_queue_reawaits: { "13710": 1, "13711": 1 },
    resume_state: { phase: 1 },
  });
  assert.equal(planCopyIsAheadOf(live, copy), true);
});

test("defeito 1 no disco: vivo com status/waves/reespera mudados + cópia com timeline novo → backup-alongside, vivo intocado", () => {
  const { root, runDir, planPath } = setup();
  try {
    const live = {
      ...LIVE_BASE,
      waves: [...LIVE_BASE.waves, { n: 2, issues: [13704] }],
      ci_queue_reawaits: { "13710": 2 },
      issues: [{ ...LIVE_BASE.issues[0], status: "pulada", motivo: "pr-em-voo" }],
    };
    writeFileSync(planPath, JSON.stringify(live));
    writeFileSync(join(runDir, "plan.json.conflict1"), JSON.stringify(copyWithNewTimeline()));
    const r = recoverPlanFromSafeBackup(planPath);
    assert.equal(r.status, "backup-alongside");
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), live);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defeito 2: rebaixado mantém o mtime do vivo e o restauro após promoção não escolhe o rebaixado", () => {
  const { root, runDir, planPath } = setup();
  try {
    const copy = copyWithNewTimeline();
    const copyPath = join(runDir, "plan.json.conflict1");
    writeFileSync(copyPath, JSON.stringify(copy));
    writeFileSync(planPath, JSON.stringify(LIVE_BASE));
    // bisync `--conflict-resolve newer`: o vivo é o de mtime MAIOR.
    const copyTime = new Date("2026-11-19T12:00:00Z");
    const liveTime = new Date("2026-11-19T12:05:00Z");
    utimesSync(copyPath, copyTime, copyTime);
    utimesSync(planPath, liveTime, liveTime);

    const r = recoverPlanFromSafeBackup(planPath);
    assert.ok(r.status === "promoted");
    assert.equal(Math.round(statSync(r.demotedTo).mtimeMs), liveTime.getTime(), "rebaixado guarda o mtime original");

    // O plano some de novo (#10579): o restauro precisa voltar a versão à frente.
    rmSync(planPath);
    const again = recoverPlanFromSafeBackup(planPath);
    assert.ok(again.status === "restored");
    assert.equal(again.from, copyPath);
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), copy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restauro sem promoção prévia: cópia atrasada com mtime maior perde para a que está à frente", () => {
  const { root, runDir, planPath } = setup();
  try {
    const ahead = copyWithNewTimeline();
    const behindPath = join(runDir, "plan.json.conflict2");
    const aheadPath = join(runDir, "plan.json.conflict1");
    writeFileSync(aheadPath, JSON.stringify(ahead));
    writeFileSync(behindPath, JSON.stringify(LIVE_BASE));
    utimesSync(aheadPath, new Date("2026-11-19T12:00:00Z"), new Date("2026-11-19T12:00:00Z"));
    utimesSync(behindPath, new Date("2026-11-19T12:09:00Z"), new Date("2026-11-19T12:09:00Z"));
    const r = recoverPlanFromSafeBackup(planPath);
    assert.ok(r.status === "restored");
    assert.equal(r.from, aheadPath);
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), ahead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restauro com cópias divergentes (nenhuma à frente da outra) segue o maior mtime", () => {
  const { root, runDir, planPath } = setup();
  try {
    const a = { ...LIVE_BASE, issues: [{ ...LIVE_BASE.issues[0], status: "pulada" }] };
    const b = copyWithNewTimeline();
    const aPath = join(runDir, "plan.json.conflict1");
    const bPath = join(runDir, "plan.json.conflict2");
    writeFileSync(aPath, JSON.stringify(a));
    writeFileSync(bPath, JSON.stringify(b));
    utimesSync(aPath, new Date("2026-11-19T12:09:00Z"), new Date("2026-11-19T12:09:00Z"));
    utimesSync(bPath, new Date("2026-11-19T12:00:00Z"), new Date("2026-11-19T12:00:00Z"));
    const r = recoverPlanFromSafeBackup(planPath);
    assert.ok(r.status === "restored");
    assert.equal(r.from, aPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
