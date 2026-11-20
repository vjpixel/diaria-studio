/**
 * test/plan-conflict-copy-known-advances-13717.test.ts (#13717)
 *
 * Depois do #13703 a cópia de conflito só era promovida com todos os demais
 * campos do vivo iguais na cópia. Medido sobre as 31 cópias reais do OneDrive,
 * nenhuma era reconhecida como versão anterior do plano final: o `status` da
 * issue (`pr-aberta` → `mergeada`) e os campos de progresso da rodada
 * (`goal.last_convergence_scan`, `findings_depth`, `rescans_done`,
 * `review_1_5b_has_p2`) mudam junto com o evento de merge. Estes testes fixam
 * os avanços aceitos e o que continua sendo divergência.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planCopyIsAheadOf,
  planIssueStatusContainedIn,
  recoverPlanFromSafeBackup,
} from "../scripts/lib/plan-safe-backup.ts";

const SID = "sess-261120";

const LIVE = {
  session_id: SID,
  rescans_done: 1,
  findings_depth: 0,
  review_1_5b_has_p2: false,
  goal: { policy: "exhaust", last_convergence_scan: { at: "2026-11-20T03:00:00.000Z", novas_encontradas: 4 } },
  issues: [{ number: 13717, status: "pr-aberta", pr: 13730, motivo: "x", timeline: { dispatch: "t1", pr_opened: "t2" } }],
};

/** O cenário da issue: a cópia tem o merge na timeline e o status `mergeada`. */
function copyMerged(over: Record<string, unknown> = {}, issueOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...LIVE,
    issues: [{ ...LIVE.issues[0], status: "mergeada", timeline: { dispatch: "t1", pr_opened: "t2", merged: "t3" }, ...issueOver }],
    ...over,
  };
}

test("cenário da issue: vivo pr-aberta, cópia com merge na timeline e status mergeada → à frente", () => {
  assert.equal(planCopyIsAheadOf(LIVE, copyMerged()), true);
});

test("campos de progresso da rodada mais adiantados na cópia → à frente", () => {
  const copy = copyMerged({
    rescans_done: 2,
    findings_depth: 1,
    review_1_5b_has_p2: true,
    goal: { policy: "exhaust", last_convergence_scan: { at: "2026-11-20T03:40:00.000Z", novas_encontradas: 0 } },
  });
  assert.equal(planCopyIsAheadOf(LIVE, copy), true);
});

test("status para trás ou entre desfechos diferentes → não está à frente", () => {
  const live = { ...LIVE, issues: [{ ...LIVE.issues[0], status: "mergeada" }] };
  assert.equal(planCopyIsAheadOf(live, copyMerged({}, { status: "pr-aberta" })), false);
  assert.equal(planCopyIsAheadOf(live, copyMerged({}, { status: "draft-ci-vermelho" })), false);
});

test("status fora da ordem conhecida segue estrito (pulada → mergeada não é avanço)", () => {
  const live = { ...LIVE, issues: [{ ...LIVE.issues[0], status: "pulada" }] };
  assert.equal(planCopyIsAheadOf(live, copyMerged()), false);
});

test("motivo da issue diferente continua sendo divergência mesmo com status avançado", () => {
  assert.equal(planCopyIsAheadOf(LIVE, copyMerged({}, { motivo: "y" })), false);
});

test("contador ou flag para trás, ou varredura mais antiga → não está à frente", () => {
  assert.equal(planCopyIsAheadOf({ ...LIVE, rescans_done: 3 }, copyMerged()), false);
  assert.equal(planCopyIsAheadOf({ ...LIVE, findings_depth: 2 }, copyMerged()), false);
  assert.equal(planCopyIsAheadOf({ ...LIVE, review_1_5b_has_p2: true }, copyMerged({ review_1_5b_has_p2: false })), false);
  const older = { policy: "exhaust", last_convergence_scan: { at: "2026-11-20T02:00:00.000Z", novas_encontradas: 4 } };
  assert.equal(planCopyIsAheadOf(LIVE, copyMerged({ goal: older })), false);
});

test("varredura sem at legível ou outro campo de goal diferente → não está à frente", () => {
  assert.equal(planCopyIsAheadOf(LIVE, copyMerged({ goal: { policy: "exhaust", last_convergence_scan: { novas_encontradas: 0 } } })), false);
  const otherPolicy = { policy: "blocked_only", last_convergence_scan: LIVE.goal.last_convergence_scan };
  assert.equal(planCopyIsAheadOf(LIVE, copyMerged({ goal: otherPolicy })), false);
});

test("só avanço de status, sem marco novo em timeline/pr, não basta para estar à frente", () => {
  const copy = { ...LIVE, issues: [{ ...LIVE.issues[0], status: "mergeada" }] };
  assert.equal(planCopyIsAheadOf(LIVE, copy), false);
});

test("planIssueStatusContainedIn: tabela de postos", () => {
  assert.equal(planIssueStatusContainedIn("elegivel", "pr-aberta"), true);
  assert.equal(planIssueStatusContainedIn("pendente", "mergeada"), true);
  assert.equal(planIssueStatusContainedIn(undefined, "mergeada"), true);
  assert.equal(planIssueStatusContainedIn("mergeada", "mergeada"), true);
  assert.equal(planIssueStatusContainedIn("pr-aberta", "elegivel"), false);
  assert.equal(planIssueStatusContainedIn("mergeada", "merged"), false);
  assert.equal(planIssueStatusContainedIn("pr-aberta", "pulada"), false);
  assert.equal(planIssueStatusContainedIn("pr-aberta", undefined), false);
});

test("no disco: vivo atrasado em pr-aberta é rebaixado e a cópia mergeada vira plan.json", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-advances-13717-"));
  try {
    const runDir = join(root, "data", "overnight", "261120");
    mkdirSync(runDir, { recursive: true });
    const planPath = join(runDir, "plan.json");
    const copy = copyMerged({ rescans_done: 2, goal: { policy: "exhaust", last_convergence_scan: { at: "2026-11-20T03:40:00.000Z", novas_encontradas: 0 } } });
    writeFileSync(planPath, JSON.stringify(LIVE));
    writeFileSync(join(runDir, "plan.json.conflict1"), JSON.stringify(copy));
    const r = recoverPlanFromSafeBackup(planPath);
    assert.ok(r.status === "promoted");
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")), copy);
    assert.deepEqual(JSON.parse(readFileSync(r.demotedTo, "utf8")), LIVE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
