/**
 * test/reconcile-overnight-report-plan-missing-11721.test.ts (#11721)
 *
 * Regressão da rodada 261030c: o OneDrive renomeou
 * `data/overnight/261030c/plan.json` para `plan-300-safeBackup-0001.json`
 * durante a Fase 2. `reconcile-overnight-report.ts` não achou o plano e gravou
 * "Nenhuma PR da rodada encontrada" no report.md, com 9 unidades mergeadas; os
 * gates da Fase 2 tiveram de ser apontados para o backup à mão.
 *
 * Cobre: (1) o leitor único `readPlanJson` (restaura o backup, distingue
 * ausente de ilegível); (2) o reconcile falha alto com plano ausente e usa o
 * backup quando ele existe; (3) os gates da Fase 2 chamam a recuperação antes
 * de checar a existência do plano.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlanJson } from "../scripts/lib/plan-safe-backup.ts";
import { reconcileReport, type GhJson } from "../scripts/reconcile-overnight-report.ts";

const PLAN = {
  started_at: "2026-10-30T02:00:00Z",
  issues: [
    { number: 11700, in_round: true, pr: 11710 },
    { number: 11701, in_round: true, pr: 11711 },
  ],
};

function setup(): { root: string; runDir: string; planPath: string; reportPath: string } {
  const root = mkdtempSync(join(tmpdir(), "reconcile-11721-"));
  const runDir = join(root, "data", "overnight", "261030c");
  mkdirSync(runDir, { recursive: true });
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, "# overnight 261030c\n\nprosa da Fase 2\n");
  return { root, runDir, planPath: join(runDir, "plan.json"), reportPath };
}

const gh: GhJson = (args) => {
  if (args[0] === "pr" && args[1] === "list") return { ok: true, data: [] };
  const n = Number(args[2]);
  return {
    ok: true,
    data: { number: n, title: `PR ${n}`, url: `https://x/${n}`, state: "MERGED", mergedAt: "2026-10-30T04:00:00Z", comments: [] },
  };
};

const silent = () => {};

describe("readPlanJson (#11721)", () => {
  it("plano ausente + plan-300-safeBackup-0001.json → restaura e devolve ok", () => {
    const { root, runDir, planPath } = setup();
    try {
      writeFileSync(join(runDir, "plan-300-safeBackup-0001.json"), JSON.stringify(PLAN));
      const warnings: string[] = [];
      const r = readPlanJson(planPath, { warn: (m) => warnings.push(m) });
      assert.equal(r.status, "ok");
      assert.equal(r.recovery.status, "restored");
      assert.deepEqual(r.status === "ok" && r.plan, PLAN);
      assert.ok(existsSync(planPath), "plan.json restaurado em disco");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /plan-300-safeBackup-0001\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem plano e sem backup → missing (nunca plano vazio)", () => {
    const { root, planPath } = setup();
    try {
      const r = readPlanJson(planPath, { warn: silent });
      assert.equal(r.status, "missing");
      assert.match(r.status === "missing" ? r.message : "", /plan\.json não encontrado/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("só backup truncado → missing citando a cópia ilegível", () => {
    const { root, runDir, planPath } = setup();
    try {
      writeFileSync(join(runDir, "plan-300-safeBackup-0001.json"), "{\"started_at\": ");
      const r = readPlanJson(planPath, { warn: silent });
      assert.equal(r.status, "missing");
      assert.equal(r.recovery.status, "unrecoverable");
      assert.match(r.status === "missing" ? r.message : "", /safeBackup-0001\.json/);
      assert.equal(existsSync(planPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plan.json inválido ou array → unreadable", () => {
    const { root, planPath } = setup();
    try {
      writeFileSync(planPath, "not json");
      assert.equal(readPlanJson(planPath, { warn: silent }).status, "unreadable");
      writeFileSync(planPath, "[]");
      assert.equal(readPlanJson(planPath, { warn: silent }).status, "unreadable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reconcile-overnight-report com plano ausente (#11721)", () => {
  it("cenário 261030c: plano renomeado para safeBackup → reconcilia pelas PRs do backup, nunca '0 PRs'", () => {
    const { root, runDir, planPath, reportPath } = setup();
    try {
      writeFileSync(join(runDir, "plan-300-safeBackup-0001.json"), JSON.stringify(PLAN));
      const r = reconcileReport({ reportPath, planPath, extraPrs: [], discover: true, check: false, gh, warn: silent, now: () => "2026-10-30T05:00:00Z" });
      assert.equal(r.exitCode, 0, r.message);
      assert.deepEqual(r.prs.map((p) => p.number), [11710, 11711]);
      const text = readFileSync(reportPath, "utf8");
      assert.doesNotMatch(text, /Nenhuma PR da rodada encontrada/);
      assert.match(text, /2 mergeada\(s\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem plano nenhum → exit 3, relatório intocado", () => {
    const { root, planPath, reportPath } = setup();
    try {
      const before = readFileSync(reportPath, "utf8");
      const r = reconcileReport({ reportPath, planPath, extraPrs: [], discover: true, check: false, gh, warn: silent });
      assert.equal(r.exitCode, 3);
      assert.match(r.message, /plan\.json não encontrado/);
      assert.equal(readFileSync(reportPath, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem plano mas com --prs explícito → ainda falha (sem plano a descoberta não roda e a lista sairia parcial)", () => {
    const { root, planPath, reportPath } = setup();
    try {
      const before = readFileSync(reportPath, "utf8");
      const r = reconcileReport({ reportPath, planPath, extraPrs: [11710], discover: true, check: false, gh, warn: silent });
      assert.equal(r.exitCode, 3);
      assert.equal(readFileSync(reportPath, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--check com plano ausente também sai 3 (não 'em dia' nem 'defasado')", () => {
    const { root, planPath, reportPath } = setup();
    try {
      const r = reconcileReport({ reportPath, planPath, extraPrs: [], discover: true, check: true, gh, warn: silent });
      assert.equal(r.exitCode, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gates da Fase 2 recuperam o safeBackup antes de checar o plano (#11721)", () => {
  const GATES: Array<[string, string]> = [
    ["check-overnight-plan-briefing.ts", "planPath"],
    ["check-overnight-comment-coverage.ts", "planPath"],
    ["check-overnight-plan-motivo.ts", "planPath"],
    ["check-decision-label-drift-gate.ts", "planPath"],
    ["check-state-changed-pending.ts", "planPath"],
    ["check-pr-terminal-state.ts", "planPath"],
    ["check-block-staleness.ts", "planPath"],
    ["render-overnight-timeline.ts", "absPath"],
  ];
  for (const [file, v] of GATES) {
    it(`${file}: recoverPlanFromSafeBackupWithWarning(${v}) antes de existsSync(${v})`, () => {
      const src = readFileSync(join(import.meta.dirname, "..", "scripts", file), "utf8");
      const rec = src.indexOf(`recoverPlanFromSafeBackupWithWarning(${v});`);
      const ex = src.indexOf(`if (!existsSync(${v}))`);
      assert.ok(rec >= 0, "chama a recuperação");
      assert.ok(ex > rec, "a recuperação vem antes da checagem de existência");
    });
  }
});
