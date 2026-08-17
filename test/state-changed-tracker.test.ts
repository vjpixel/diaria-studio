/**
 * test/state-changed-tracker.test.ts (#5476)
 *
 * Cobertura de `scripts/lib/state-changed-tracker.ts`: funções puras
 * (add/remove idempotentes, leitura fail-open de `state_changed_issues`
 * ausente, veredito de checagem) e a orquestração I/O (`addPendingToPlan`/
 * `removePendingFromPlan`/`checkStateChangedPending`) contra fixtures de
 * `plan.json` em tmpdir.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readStateChangedIssues,
  addStateChangedIssue,
  removeStateChangedIssue,
  checkStateChangedIssues,
  addPendingToPlan,
  removePendingFromPlan,
  checkStateChangedPending,
  type PlanWithStateChanged,
} from "../scripts/lib/state-changed-tracker.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/check-state-changed-pending.ts");

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function writePlanFixture(plan: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "state-changed-tracker-"));
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
  return planPath;
}

describe("readStateChangedIssues — leitura pura fail-open", () => {
  it("campo ausente vira []", () => {
    const plan: PlanWithStateChanged = {};
    assert.deepEqual(readStateChangedIssues(plan), []);
  });

  it("campo presente com números é lido normalmente", () => {
    const plan: PlanWithStateChanged = { state_changed_issues: [5480, 5481] };
    assert.deepEqual(readStateChangedIssues(plan), [5480, 5481]);
  });

  it("valores não-array ou entries não-numéricas são descartados sem lançar", () => {
    const planNotArray: PlanWithStateChanged = { state_changed_issues: "oops" };
    assert.deepEqual(readStateChangedIssues(planNotArray), []);

    const planMixed: PlanWithStateChanged = { state_changed_issues: [5480, "abc", null, 5481] };
    assert.deepEqual(readStateChangedIssues(planMixed), [5480, 5481]);
  });
});

describe("addStateChangedIssue — idempotente", () => {
  it("adiciona issue nova", () => {
    assert.deepEqual(addStateChangedIssue([5480], 5481), [5480, 5481]);
  });

  it("adicionar o mesmo número 2x não duplica", () => {
    const once = addStateChangedIssue([], 5480);
    const twice = addStateChangedIssue(once, 5480);
    assert.deepEqual(twice, [5480]);
  });

  it("não muta o array original", () => {
    const original = [5480];
    addStateChangedIssue(original, 5481);
    assert.deepEqual(original, [5480]);
  });
});

describe("removeStateChangedIssue — idempotente", () => {
  it("remove issue presente", () => {
    assert.deepEqual(removeStateChangedIssue([5480, 5481], 5480), [5481]);
  });

  it("remover issue ausente é no-op", () => {
    assert.deepEqual(removeStateChangedIssue([5480], 9999), [5480]);
  });

  it("remover de array vazio é no-op", () => {
    assert.deepEqual(removeStateChangedIssue([], 5480), []);
  });
});

describe("checkStateChangedIssues — veredito puro", () => {
  it("array vazio → ok", () => {
    assert.deepEqual(checkStateChangedIssues([]), { status: "ok" });
  });

  it("array não-vazio → pending com issues ordenadas", () => {
    assert.deepEqual(checkStateChangedIssues([5481, 5480]), {
      status: "pending",
      issues: [5480, 5481],
    });
  });
});

describe("orquestração I/O contra plan.json em tmpdir", () => {
  it("addPendingToPlan cria o campo quando ausente no plan.json legado", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-16T22:46:16Z" });
    addPendingToPlan(planPath, 5480);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.state_changed_issues, [5480]);
  });

  it("addPendingToPlan é idempotente (2x não duplica)", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    addPendingToPlan(planPath, 5480);
    addPendingToPlan(planPath, 5480);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.state_changed_issues, [5480]);
  });

  it("removePendingFromPlan remove e é idempotente", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5481] });
    removePendingFromPlan(planPath, 5480);
    removePendingFromPlan(planPath, 5480);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.state_changed_issues, [5481]);
  });

  it("checkStateChangedPending: plan.json sem o campo → ok, exit implícito 0", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-16T22:46:16Z" });
    assert.deepEqual(checkStateChangedPending(planPath), { status: "ok" });
  });

  it("checkStateChangedPending: plan.json com pendências → pending com lista", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5474] });
    assert.deepEqual(checkStateChangedPending(planPath), {
      status: "pending",
      issues: [5474, 5480],
    });
  });

  it("round-trip add → check → remove → check", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    addPendingToPlan(planPath, 5480);
    assert.deepEqual(checkStateChangedPending(planPath), { status: "pending", issues: [5480] });
    removePendingFromPlan(planPath, 5480);
    assert.deepEqual(checkStateChangedPending(planPath), { status: "ok" });
  });
});

describe("CLI (scripts/check-state-changed-pending.ts)", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env },
    });
  }

  it("--plan sozinho sobre plan.json vazio → exit 0, 'ok'", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ok — nenhuma pendência de re-triagem/);
  });

  it("--plan sozinho sobre plan.json com pendências → exit 1, lista as issues", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5474] });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5474/);
    assert.match(r.stderr, /#5480/);
  });

  it("--add-pending grava e --remove-pending resolve, refletindo em --plan", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    run(["--add-pending", "5480", "--plan", planPath]);
    assert.equal(run(["--plan", planPath]).status, 1);
    run(["--remove-pending", "5480", "--plan", planPath]);
    assert.equal(run(["--plan", planPath]).status, 0);
  });

  it("plan.json ausente → erro acionável (path citado) e exit 2, nunca stack trace cru", () => {
    root = mkdtempSync(join(tmpdir(), "state-changed-tracker-cli-"));
    const missing = join(root, "plan.json");
    const r = run(["--plan", missing]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json não encontrado/);
    assert.match(r.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(r.stderr, /at readFileSync/);
  });

  it("sem --plan → uso + exit 2", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso: --plan/);
  });
});
