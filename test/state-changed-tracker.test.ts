/**
 * test/state-changed-tracker.test.ts (#5476, convergência #5706)
 *
 * Cobertura de `scripts/lib/state-changed-tracker.ts`: funções puras
 * (add/remove idempotentes, leitura fail-open de `state_changed_issues`
 * ausente, veredito de checagem) e a orquestração I/O (`addPendingToPlan`/
 * `removePendingFromPlan`/`checkStateChangedPending`) contra fixtures de
 * `plan.json` em tmpdir.
 *
 * Desde #5706, também cobre a re-varredura de convergência fundida neste
 * módulo (`collectKnownIssueNumbers`/`findMissingConvergenceIssues`/
 * `checkConvergenceScan`/`recordConvergenceScan`) — sempre via as funções
 * PURAS (issues abertas passadas como parâmetro, nunca `gh` real) e via a
 * CLI só com `--skip-convergence` ou `PATH` quebrado, nunca dependendo de
 * rede (regra do dispatch: testes locais não chamam rede).
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
  collectKnownIssueNumbers,
  findMissingConvergenceIssues,
  checkConvergenceScan,
  recordConvergenceScan,
  type PlanWithStateChanged,
  type PlanWithGoal,
  type ConvergenceScanIssue,
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

  // `--skip-convergence` em todos os testes de modo padrão abaixo: a
  // re-varredura de convergência (#5706) chama `gh` de verdade no modo
  // padrão — testes locais nunca chamam rede, então isolamos com a flag de
  // escape (comportamento dela própria é coberto na sua describe própria).

  it("--plan sozinho sobre plan.json vazio → exit 0, 'ok'", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    const r = run(["--plan", planPath, "--skip-convergence"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ok — nenhuma pendência de re-triagem/);
  });

  it("--plan sozinho sobre plan.json com pendências → exit 1, lista as issues", () => {
    const planPath = writePlanFixture({ state_changed_issues: [5480, 5474] });
    const r = run(["--plan", planPath, "--skip-convergence"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5474/);
    assert.match(r.stderr, /#5480/);
  });

  it("--add-pending grava e --remove-pending resolve, refletindo em --plan", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    run(["--add-pending", "5480", "--plan", planPath]);
    assert.equal(run(["--plan", planPath, "--skip-convergence"]).status, 1);
    run(["--remove-pending", "5480", "--plan", planPath]);
    assert.equal(run(["--plan", planPath, "--skip-convergence"]).status, 0);
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

  it("--skip-convergence: avisa em stderr e nunca chama gh (isolado de rede)", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    const r = run(["--plan", planPath, "--skip-convergence"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /--skip-convergence/);
    assert.match(r.stderr, /pulando re-varredura de convergência/);
  });

  it("gh indisponível (PATH sem o binário) → fail-soft, sem trava e sem crash (#738)", () => {
    const planPath = writePlanFixture({ state_changed_issues: [] });
    // PATH vazio garante que `gh` não é encontrado — sem depender de rede,
    // só do spawn falhando localmente (ENOENT), exatamente o cenário
    // "gh indisponível/offline" que a issue #5706 pede pra não travar.
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "--plan", planPath], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, PATH: "", Path: "" },
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /gh indisponível/);
  });
});

describe("collectKnownIssueNumbers — issues já conhecidas pelo plano", () => {
  it("plano sem goal/issues → conjunto vazio", () => {
    const plan: PlanWithGoal = {};
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set());
  });

  it("une goal.target_set + todos os tiers + issues[] top-level", () => {
    const plan: PlanWithGoal = {
      goal: {
        target_set: [100, 101],
        tiers: { "1a": [100], "1b": [], "2": [101, 102], "3": [] },
      },
      issues: [200, { number: 201 }],
    };
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set([100, 101, 102, 200, 201]));
  });

  it("entries não-numéricas/malformadas são ignoradas sem lançar", () => {
    const plan: PlanWithGoal = {
      goal: { target_set: [100, "abc", null], tiers: "not-an-object" as unknown as never },
      issues: "also-not-an-array",
    };
    assert.deepEqual(collectKnownIssueNumbers(plan), new Set([100]));
  });
});

describe("findMissingConvergenceIssues — só issue nova E classificável overnight/develop", () => {
  it("(a) todas as issues abertas já estão em known → nenhuma faltando", () => {
    const known = new Set([100, 101]);
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 101, labels: ["bug"] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), []);
  });

  it("(b) issue nova sem label de exclusão → aparece na lista (classifica overnight)", () => {
    const known = new Set([100]);
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 555, labels: ["bug"] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), [555]);
  });

  it("(b) issue nova classificada 'develop' (label windows) também aparece", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [{ number: 777, labels: ["windows"] }];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), [777]);
  });

  it("(c) issue nova classificada 'agendada' (marcador de data futura) NÃO é ruído", () => {
    const known = new Set<number>();
    const now = new Date("2026-08-19T00:00:00Z");
    const openIssues: ConvergenceScanIssue[] = [
      { number: 888, labels: [], body: "<!-- aguardando-ate: 2026-09-01 -->" },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, now), []);
  });

  it("(c) issue nova classificada 'fora-de-rodada' (on-hold) NÃO é ruído", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [{ number: 999, labels: ["on-hold"] }];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), []);
  });

  it("(c) issue nova classificada 'bloqueada' (external-blocker) NÃO é ruído", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [
      { number: 1000, labels: ["external-blocker"] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), []);
  });

  it("resultado vem ordenado numericamente", () => {
    const known = new Set<number>();
    const openIssues: ConvergenceScanIssue[] = [
      { number: 300, labels: [] },
      { number: 100, labels: [] },
      { number: 200, labels: [] },
    ];
    assert.deepEqual(findMissingConvergenceIssues(openIssues, known, new Date()), [100, 200, 300]);
  });
});

describe("checkConvergenceScan — veredito puro combinando os dois", () => {
  it("(a) target_set cobre todas as abertas → ok, novas_encontradas: 0", () => {
    const plan: PlanWithGoal = { goal: { target_set: [100, 101] } };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 101, labels: [] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), { status: "ok", novas_encontradas: 0 });
  });

  it("(b) issue aberta ausente do plano e não-excluída → missing com a issue", () => {
    const plan: PlanWithGoal = { goal: { target_set: [100] } };
    const openIssues: ConvergenceScanIssue[] = [
      { number: 100, labels: [] },
      { number: 555, labels: ["bug"] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues), {
      status: "missing",
      issues: [555],
      novas_encontradas: 1,
    });
  });

  it("(c) issue ausente mas classificada agendada/fora-de-rodada → ok", () => {
    const plan: PlanWithGoal = { goal: { target_set: [] } };
    const now = new Date("2026-08-19T00:00:00Z");
    const openIssues: ConvergenceScanIssue[] = [
      { number: 888, labels: [], body: "<!-- aguardando-ate: 2026-09-01 -->" },
      { number: 999, labels: ["wontfix"] },
    ];
    assert.deepEqual(checkConvergenceScan(plan, openIssues, now), {
      status: "ok",
      novas_encontradas: 0,
    });
  });
});

describe("recordConvergenceScan — I/O grava goal.last_convergence_scan", () => {
  it("grava at + novas_encontradas no plan.json", () => {
    const planPath = writePlanFixture({ goal: { target_set: [] } });
    recordConvergenceScan(planPath, 2, "2026-08-19T10:00:00.000Z");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.goal.last_convergence_scan, {
      at: "2026-08-19T10:00:00.000Z",
      novas_encontradas: 2,
    });
  });

  it("cria goal quando ausente (plano legado) em vez de lançar", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-16T22:46:16Z" });
    recordConvergenceScan(planPath, 0, "2026-08-19T10:00:00.000Z");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.goal.last_convergence_scan, {
      at: "2026-08-19T10:00:00.000Z",
      novas_encontradas: 0,
    });
  });

  it("preserva o resto de goal já existente (target_set, tiers, etc.)", () => {
    const planPath = writePlanFixture({ goal: { target_set: [100], reached: false } });
    recordConvergenceScan(planPath, 1, "2026-08-19T10:00:00.000Z");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(written.goal.target_set, [100]);
    assert.equal(written.goal.reached, false);
    assert.deepEqual(written.goal.last_convergence_scan, {
      at: "2026-08-19T10:00:00.000Z",
      novas_encontradas: 1,
    });
  });
});
