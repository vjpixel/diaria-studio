/**
 * test/develop-target-set-coverage.test.ts (#5718)
 *
 * Cobertura de `scripts/lib/develop-target-set-coverage.ts` + a CLI
 * `scripts/check-develop-target-set-coverage.ts`: funções puras (issue
 * coberta/descoberta, entrada sem status, dedup/ordenação), a orquestração
 * I/O (`checkTargetSetCoverage` contra fixtures de `plan.json` em tmpdir,
 * array E dict), e o CLI (exit codes, mensagens acionáveis). Regressão
 * direta do cenário `260819d`: #5700/#5419/#5692 em `goal.target_set` sem
 * entrada em `issues[]`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEVELOP_NAO_TENTADA_STATUS,
  findMissingTargetSetCoverage,
  checkTargetSetCoverageFromPlan,
  checkTargetSetCoverage,
  type PlanWithTargetSet,
} from "../scripts/lib/develop-target-set-coverage.ts";
import type { DevelopPlanIssueLike } from "../scripts/lib/develop-plan-motivo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/check-develop-target-set-coverage.ts");

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function writePlanFixture(plan: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "develop-target-set-coverage-"));
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
  return planPath;
}

describe("DEVELOP_NAO_TENTADA_STATUS", () => {
  it("é o literal 'nao-tentada'", () => {
    assert.equal(DEVELOP_NAO_TENTADA_STATUS, "nao-tentada");
  });
});

describe("findMissingTargetSetCoverage — filtro puro", () => {
  it("issue com entrada e status → coberta", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 5700, status: "mergeada" }];
    assert.deepEqual(findMissingTargetSetCoverage([5700], issues), []);
  });

  it("issue ausente de issues[] inteiramente → descoberta (o bug do #5718)", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 1, status: "mergeada" }];
    assert.deepEqual(findMissingTargetSetCoverage([5700, 1], issues), [5700]);
  });

  it("entrada existe mas sem status → mesmo tratamento de ausente", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 5419 }];
    assert.deepEqual(findMissingTargetSetCoverage([5419], issues), [5419]);
  });

  it("entrada com status vazio ('') → mesmo tratamento de ausente", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 5692, status: "" }];
    assert.deepEqual(findMissingTargetSetCoverage([5692], issues), [5692]);
  });

  it("entrada já registrada como nao-tentada conta como coberta", () => {
    const issues: DevelopPlanIssueLike[] = [{ number: 5700, status: "nao-tentada" }];
    assert.deepEqual(findMissingTargetSetCoverage([5700], issues), []);
  });

  it("target_set vazio → nada faltando", () => {
    assert.deepEqual(findMissingTargetSetCoverage([], []), []);
  });

  it("saída ordenada e deduplicada", () => {
    const result = findMissingTargetSetCoverage([5692, 5419, 5419, 5700], []);
    assert.deepEqual(result, [5419, 5692, 5700]);
  });

  it("regressão 260819d: 3 issues nunca tentadas ficam explícitas, não somem em remaining solto", () => {
    const targetSet = [5700, 5419, 5692, 5713];
    const issues: DevelopPlanIssueLike[] = [{ number: 5713, status: "mergeada" }];
    assert.deepEqual(findMissingTargetSetCoverage(targetSet, issues), [5419, 5692, 5700]);
  });
});

describe("checkTargetSetCoverageFromPlan — veredito puro", () => {
  it("target_set ausente → ok (fail-open, ex: policy table_only)", () => {
    const plan: PlanWithTargetSet = { goal: {} };
    assert.deepEqual(checkTargetSetCoverageFromPlan(plan), { status: "ok" });
  });

  it("goal ausente → ok", () => {
    assert.deepEqual(checkTargetSetCoverageFromPlan({}), { status: "ok" });
  });

  it("todas cobertas → ok", () => {
    const plan: PlanWithTargetSet = {
      goal: { target_set: [1, 2] },
      issues: [
        { number: 1, status: "mergeada" },
        { number: 2, status: "pulada", motivo: "decisao-adiada" },
      ],
    };
    assert.deepEqual(checkTargetSetCoverageFromPlan(plan), { status: "ok" });
  });

  it("alguma faltando → missing com a lista", () => {
    const plan: PlanWithTargetSet = {
      goal: { target_set: [1, 2, 3] },
      issues: [{ number: 1, status: "mergeada" }],
    };
    assert.deepEqual(checkTargetSetCoverageFromPlan(plan), { status: "missing", issues: [2, 3] });
  });
});

describe("checkTargetSetCoverage — I/O, array e dict", () => {
  it("plan.issues como array — cobertura completa → ok", () => {
    const planPath = writePlanFixture({
      goal: { target_set: [5658] },
      issues: [{ number: 5658, status: "nao-tentada" }],
    });
    assert.deepEqual(checkTargetSetCoverage(planPath), { status: "ok" });
  });

  it("plan.issues como dict (shape real do develop, #4817/#4860) — issue faltando detectada", () => {
    const planPath = writePlanFixture({
      goal: { target_set: [5506, 5658] },
      issues: {
        "5658": { status: "mergeada" },
      },
    });
    assert.deepEqual(checkTargetSetCoverage(planPath), { status: "missing", issues: [5506] });
  });

  it("plan.json sem goal.target_set → ok (fail-open)", () => {
    const planPath = writePlanFixture({ started_at: "2026-08-19T18:48:00Z" });
    assert.deepEqual(checkTargetSetCoverage(planPath), { status: "ok" });
  });
});

describe("CLI (scripts/check-develop-target-set-coverage.ts)", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env },
    });
  }

  it("cobertura completa → exit 0, 'ok'", () => {
    const planPath = writePlanFixture({
      goal: { target_set: [1] },
      issues: [{ number: 1, status: "mergeada" }],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /entrada em issues/);
  });

  it("issue faltando → exit 1, lista o número e a instrução de backfill", () => {
    const planPath = writePlanFixture({
      goal: { target_set: [5700, 5419, 5692] },
      issues: [],
    });
    const r = run(["--plan", planPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#5700/);
    assert.match(r.stderr, /#5419/);
    assert.match(r.stderr, /#5692/);
    assert.match(r.stderr, /nao-tentada/);
  });

  it("plan.json ausente → erro acionável (path citado) e exit 2, nunca stack trace cru", () => {
    root = mkdtempSync(join(tmpdir(), "develop-target-set-coverage-cli-"));
    const missing = join(root, "plan.json");
    const r = run(["--plan", missing]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json não encontrado/);
    assert.doesNotMatch(r.stderr, /at readFileSync/);
  });

  it("sem --plan → uso + exit 2", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso: --plan/);
  });
});
