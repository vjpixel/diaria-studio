/**
 * test/measure-merge-train-ci-runs.test.ts (#6300, regressão #633)
 *
 * Cobre `scripts/measure-merge-train-ci-runs.ts` — agregação dos eventos
 * `merge_train_ci_runs` (emitidos por `scripts/run-merge-train.ts` a cada
 * invocação real) num resumo antes/depois. Mesmo padrão isolado em tmpdir
 * de `test/continuo-cost-summary.test.ts` — nunca toca `data/run-log.jsonl`
 * real do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  summarizeMergeTrainCiRunsEvents,
  measureMergeTrainCiRuns,
  formatMergeTrainCiRunsSummary,
} from "../scripts/measure-merge-train-ci-runs.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "measure-merge-train-ci-runs-"));
}

function ev(details: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-09-01T12:00:00.000Z",
    edition: null,
    stage: null,
    agent: "overnight",
    level: "info",
    message: "merge_train_ci_runs",
    details,
    ...overrides,
  });
}

describe("summarizeMergeTrainCiRunsEvents", () => {
  it("agrega múltiplos eventos, somando cada campo", () => {
    const lines = [
      ev({ ci_runs_used: 1, ci_runs_without_train: 2, issues_involved_in_batches: 2, solo_prs: 0, batches: 1 }),
      ev({ ci_runs_used: 2, ci_runs_without_train: 3, issues_involved_in_batches: 3, solo_prs: 1, batches: 2 }),
    ];
    const s = summarizeMergeTrainCiRunsEvents(lines);
    assert.equal(s.eventCount, 2);
    assert.equal(s.invocationsWithBatches, 2);
    assert.equal(s.ciRunsUsed, 3);
    assert.equal(s.ciRunsWithoutTrain, 5);
    assert.equal(s.issuesInvolvedInBatches, 5);
    assert.equal(s.soloPrs, 1);
  });

  it("evento com ci_runs_used=0 (só PRs solo, nenhum lote formado) conta em eventCount mas NÃO em invocationsWithBatches", () => {
    const lines = [ev({ ci_runs_used: 0, ci_runs_without_train: 0, issues_involved_in_batches: 0, solo_prs: 3, batches: 3 })];
    const s = summarizeMergeTrainCiRunsEvents(lines);
    assert.equal(s.eventCount, 1);
    assert.equal(s.invocationsWithBatches, 0);
    assert.equal(s.soloPrs, 3);
  });

  it("ignora mensagens de outro tipo e linhas malformadas, sem lançar", () => {
    const lines = [
      "não é json",
      JSON.stringify({ agent: "overnight", message: "subagent_metrics", details: { subagent_tokens: 999 } }),
      ev({ ci_runs_used: 1, ci_runs_without_train: 2, issues_involved_in_batches: 1, solo_prs: 0, batches: 1 }),
    ];
    const s = summarizeMergeTrainCiRunsEvents(lines);
    assert.equal(s.eventCount, 1);
    assert.equal(s.ciRunsUsed, 1);
  });

  it("--kind filtra por agent", () => {
    const lines = [
      ev({ ci_runs_used: 1, ci_runs_without_train: 2, issues_involved_in_batches: 1, solo_prs: 0, batches: 1 }, { agent: "overnight" }),
      ev({ ci_runs_used: 5, ci_runs_without_train: 6, issues_involved_in_batches: 5, solo_prs: 0, batches: 1 }, { agent: "develop" }),
    ];
    const s = summarizeMergeTrainCiRunsEvents(lines, { kind: "develop" });
    assert.equal(s.eventCount, 1);
    assert.equal(s.ciRunsUsed, 5);
  });

  it("--since filtra por dia (AAMMDD, derivado do timestamp UTC)", () => {
    const lines = [
      ev(
        { ci_runs_used: 1, ci_runs_without_train: 1, issues_involved_in_batches: 1, solo_prs: 0, batches: 1 },
        { timestamp: "2026-08-30T00:00:00.000Z" },
      ),
      ev(
        { ci_runs_used: 9, ci_runs_without_train: 9, issues_involved_in_batches: 9, solo_prs: 0, batches: 1 },
        { timestamp: "2026-09-01T00:00:00.000Z" },
      ),
    ];
    const s = summarizeMergeTrainCiRunsEvents(lines, { since: "260901" });
    assert.equal(s.eventCount, 1);
    assert.equal(s.ciRunsUsed, 9);
  });

  it("array vazio: tudo zero, nunca lança", () => {
    const s = summarizeMergeTrainCiRunsEvents([]);
    assert.deepEqual(s, {
      eventCount: 0,
      invocationsWithBatches: 0,
      ciRunsUsed: 0,
      ciRunsWithoutTrain: 0,
      issuesInvolvedInBatches: 0,
      soloPrs: 0,
    });
  });
});

describe("measureMergeTrainCiRuns — integração fim-a-fim via run-log.jsonl em tmpdir", () => {
  it("lê data/run-log.jsonl do rootDir dado e agrega", () => {
    const root = tmpRoot();
    try {
      const runLog = join(root, "data", "run-log.jsonl");
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(
        runLog,
        [
          ev({ ci_runs_used: 1, ci_runs_without_train: 3, issues_involved_in_batches: 3, solo_prs: 0, batches: 1 }),
        ].join("\n") + "\n",
        "utf8",
      );
      const s = measureMergeTrainCiRuns(root);
      assert.equal(s.eventCount, 1);
      assert.equal(s.ciRunsUsed, 1);
      assert.equal(s.ciRunsWithoutTrain, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run-log.jsonl ausente (clone fresco/worktree novo): summary zerado, nunca lança (fail-soft)", () => {
    const root = tmpRoot();
    try {
      const s = measureMergeTrainCiRuns(root);
      assert.equal(s.eventCount, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatMergeTrainCiRunsSummary", () => {
  it("nenhuma invocação com lote >= 2: mensagem explícita de 'instrumentação pronta, sem uso real' — nunca tabela zerada ambígua", () => {
    const md = formatMergeTrainCiRunsSummary({
      eventCount: 0,
      invocationsWithBatches: 0,
      ciRunsUsed: 0,
      ciRunsWithoutTrain: 0,
      issuesInvolvedInBatches: 0,
      soloPrs: 0,
    });
    assert.match(md, /instrumentação pronta/);
    assert.match(md, /nenhum lote de tamanho >= 2/);
  });

  it("com dados reais: tabela antes/depois + economia calculada", () => {
    const md = formatMergeTrainCiRunsSummary({
      eventCount: 2,
      invocationsWithBatches: 2,
      ciRunsUsed: 3,
      ciRunsWithoutTrain: 6,
      issuesInvolvedInBatches: 6,
      soloPrs: 1,
    });
    assert.match(md, /\| Runs de CI \| 6 \| 3 \|/);
    assert.match(md, /Economia: 3 run\(s\) de CI \(50\.0%\)\./);
  });

  it("issuesInvolvedInBatches=0 (não deveria acontecer com ciRunsUsed>0, mas defensivo): taxa por issue vira 'n/d', não divide por zero", () => {
    const md = formatMergeTrainCiRunsSummary({
      eventCount: 1,
      invocationsWithBatches: 1,
      ciRunsUsed: 1,
      ciRunsWithoutTrain: 2,
      issuesInvolvedInBatches: 0,
      soloPrs: 0,
    });
    assert.match(md, /Runs de CI \/ issue \| n\/d \| n\/d \|/);
  });
});
