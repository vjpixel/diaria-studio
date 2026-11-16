/**
 * overnight-throughput-report-13271.test.ts (#13271, #13270)
 *
 * Leitura de vazão do overnight (trechos do ciclo por UNIDADE, motivos de
 * `pulada`, cobertura do timeline, issues por hora) e o veredito do critério de
 * reversão do teto da onda.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  aggregateThroughput,
  renderThroughputMarkdown,
  roundHours,
  unitKeyOf,
} from "../scripts/lib/overnight-throughput-report.ts";
import {
  aggregateWaveRounds,
  computeWaveUnitDurations,
  evaluateWaveCapReversal,
  renderReversalLine,
  renderWavesReportMarkdown,
  type WaveGroupSignals,
} from "../scripts/lib/overnight-waves-report.ts";
import { buildWaveRecord } from "../scripts/lib/overnight-waves.ts";
import { readRoundPlan } from "../scripts/report-overnight-waves.ts";
import type { PlanIssue } from "../scripts/render-overnight-timeline.ts";

const MIN = 60_000;

function issue(partial: Partial<PlanIssue> & { number: number }): PlanIssue {
  return { priority: "P2", status: "mergeada", batch: null, pr: null, ...partial } as PlanIssue;
}

describe("unitKeyOf", () => {
  it("PR > batch > issue, sempre prefixado pela rodada", () => {
    assert.equal(unitKeyOf(issue({ number: 1, pr: 50, batch: "x" }), "261116"), "261116|pr:50");
    assert.equal(unitKeyOf(issue({ number: 1, batch: "x" }), "261116"), "261116|batch:x");
    assert.match(unitKeyOf(issue({ number: 7 }), "261116"), /^261116\|issue:.*7$/);
  });
});

describe("aggregateThroughput", () => {
  const round = {
    dir: "261116",
    started_at: "2026-11-16T00:00:00Z",
    issues: [
      // Lote de 2 issues numa PR: conta como UMA unidade, não duas.
      issue({
        number: 1,
        pr: 100,
        timeline: {
          dispatch: "2026-11-16T00:00:00Z",
          pr_opened: "2026-11-16T00:20:00Z",
          ci_green: "2026-11-16T00:40:00Z",
          merged: "2026-11-16T01:00:00Z",
        },
      }),
      issue({
        number: 2,
        pr: 100,
        timeline: {
          dispatch: "2026-11-16T00:00:00Z",
          pr_opened: "2026-11-16T00:20:00Z",
          ci_green: "2026-11-16T00:40:00Z",
          merged: "2026-11-16T01:00:00Z",
        },
      }),
      // Unidade solo sem pr_opened/ci_green (o caso de cobertura parcial da issue).
      issue({ number: 3, pr: 101, timeline: { dispatch: "2026-11-16T01:00:00Z", merged: "2026-11-16T02:00:00Z" } }),
      // Marco fora de ordem: ci_green antes de pr_opened não entra no trecho.
      issue({
        number: 4,
        pr: 102,
        status: "draft-ci-vermelho",
        timeline: { pr_opened: "2026-11-16T03:00:00Z", ci_green: "2026-11-16T02:30:00Z" },
      }),
      issue({ number: 5, status: "pulada", motivo: "requer-sessao-local" }),
      issue({ number: 6, status: "pulada", motivo: "requer-sessao-local" }),
      issue({ number: 7, status: "pulada", motivo: "pr-em-voo" }),
      issue({ number: 8, status: "pulada" }),
    ],
  };

  it("agrega por unidade, conta puladas por motivo e a cobertura do timeline", () => {
    const r = aggregateThroughput([round]);
    assert.equal(r.rounds_scanned, 1);
    assert.equal(r.merged_issues, 3);
    assert.equal(r.round_hours, 3); // started_at 00:00 -> último marco 03:00
    assert.equal(r.merged_per_hour, 1);
    assert.equal(r.merged_per_round, 3);
    assert.deepEqual(r.segments["dispatch→pr_opened"], { p50_ms: 20 * MIN, p90_ms: 20 * MIN, n: 1 });
    assert.equal(r.segments["pr_opened→ci_green"].n, 1); // a unidade fora de ordem ficou de fora
    assert.equal(r.segments["dispatch→merged"].n, 2);
    assert.equal(r.segments["dispatch→merged"].p50_ms, 60 * MIN);
    assert.equal(r.merged_units, 2);
    assert.deepEqual(r.milestone_coverage, { dispatch: 2, pr_opened: 1, ci_green: 1, merged: 2 });
    assert.equal(r.pulada_total, 4);
    assert.deepEqual(r.pulada_by_motivo, { "requer-sessao-local": 2, "pr-em-voo": 1, "(sem motivo)": 1 });
  });

  it("renderiza a tabela de trechos e os motivos em ordem decrescente, com corte em --top", () => {
    const md = renderThroughputMarkdown(aggregateThroughput([round]), 1);
    assert.match(md, /Mergeadas: 3 \| por rodada: 3,0 \| por hora: 1,0/);
    assert.match(md, /\| dispatch→merged \| 1h00m \| 1h00m \| 2 \|/);
    assert.match(md, /Cobertura do timeline \(de 2 unidades com merged\): dispatch 2, pr_opened 1, ci_green 1, merged 2/);
    assert.match(md, /\| requer-sessao-local \| 2 \|/);
    assert.match(md, /\| \(outros 2 motivos\) \| 2 \|/);
  });

  it("nenhuma rodada: taxas nulas, sem lançar", () => {
    const r = aggregateThroughput([]);
    assert.equal(r.merged_per_round, null);
    assert.equal(r.merged_per_hour, null);
    assert.match(renderThroughputMarkdown(r), /por hora: —/);
  });
});

describe("roundHours", () => {
  it("sem started_at usa o primeiro marco; sem marco nenhum = 0", () => {
    const tl = { dispatch: "2026-11-16T01:00:00Z", merged: "2026-11-16T03:30:00Z" };
    assert.equal(roundHours({ dir: "x", issues: [issue({ number: 1, timeline: tl })] }), 2.5);
    assert.equal(roundHours({ dir: "x", started_at: "2026-11-16T00:00:00Z", issues: [issue({ number: 1 })] }), 0);
  });
});

describe("readRoundPlan expõe started_at", () => {
  it("lê o started_at do plano para a hora de rodada", () => {
    const base = mkdtempSync(join(tmpdir(), "throughput-13271-"));
    mkdirSync(join(base, "261116"));
    const planPath = join(base, "261116", "plan.json");
    writeFileSync(planPath, JSON.stringify({ started_at: "2026-11-16T00:00:00Z", issues: [] }));
    assert.equal(readRoundPlan(planPath)?.started_at, "2026-11-16T00:00:00Z");
  });
});

describe("CLI report-overnight-throughput", () => {
  it("recusa --since fora do formato AAMMDD", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/report-overnight-throughput.ts", "--since", "2611"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
  });
});

/** Sinais de um grupo; `draft_rate` derivado como no `groupSignals`. */
function sig(draft: number, merged: number, p50Min: number | null, n: number): WaveGroupSignals {
  return {
    draft,
    merged,
    draft_rate: draft + merged === 0 ? null : draft / (draft + merged),
    dispatch_to_pr_p50_ms: p50Min === null ? null : p50Min * MIN,
    dispatch_to_pr_n: n,
  };
}

describe("evaluateWaveCapReversal, critério v2 (#13270)", () => {
  it("dado medido em 16/11 (draft 1/101 vs 5/332, dispatch→PR p50 16m vs 14m): não dispara", () => {
    // Regressão do critério v1: com o pr→merge p90 (1h29m vs 56m) o veredito
    // era DISPAROU, embora o teto não piorasse nada que ele controla.
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(1, 100, 16, 25), cap_hit_false: sig(5, 327, 14, 76) });
    assert.deepEqual(v, { verdict: "nao-disparou", evaluated: ["draft-ci-vermelho", "dispatch-pr"] });
    assert.match(renderReversalLine(v), /não disparou/);
  });
  it("draft-ci-vermelho 2x maior nas ondas cheias, com 3+ drafts: dispara", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(4, 36, 15, 20), cap_hit_false: sig(5, 195, 15, 80) });
    assert.deepEqual(v, { verdict: "disparou", reasons: ["draft-ci-vermelho"] });
    assert.match(renderReversalLine(v), /DISPAROU \(draft-ci-vermelho\)\. Leitura direta: voltar o teto a 6/);
  });
  it("taxa maior mas só 2 drafts nas cheias: não dispara (1 ou 2 contra 0 não é sinal)", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(2, 30, 15, 20), cap_hit_false: sig(0, 200, 15, 80) });
    assert.equal(v.verdict, "nao-disparou");
  });
  it("outras ondas sem nenhum draft e 3 nas cheias: dispara", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(3, 30, null, 0), cap_hit_false: sig(0, 200, null, 0) });
    assert.deepEqual(v, { verdict: "disparou", reasons: ["draft-ci-vermelho"] });
  });
  it("dispatch→PR p50 1,5x maior nas ondas cheias: dispara", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(0, 30, 21, 12), cap_hit_false: sig(0, 200, 14, 80) });
    assert.deepEqual(v, { verdict: "disparou", reasons: ["dispatch-pr"] });
    assert.match(renderReversalLine(v), /DISPAROU \(dispatch→PR p50\)/);
  });
  it("amostra abaixo do mínimo nos dois sinais: sem-amostra", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(5, 10, 60, 9), cap_hit_false: sig(0, 200, 10, 80) });
    assert.deepEqual(v, { verdict: "sem-amostra" });
    assert.match(renderReversalLine(v), /sem amostra mínima/);
  });
  it("só um sinal com amostra: avalia só ele", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: sig(0, 25, 60, 5), cap_hit_false: sig(1, 200, 10, 80) });
    assert.deepEqual(v, { verdict: "nao-disparou", evaluated: ["draft-ci-vermelho"] });
  });
});

describe("sinais por unidade do critério v2 (#13270)", () => {
  const at = (h: number, m: number) => `2026-11-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  it("lote: dispatch e pr_opened mais cedo; draft em qualquer issue faz a unidade draft", () => {
    const wave = buildWaveRecord({ units: [[1, 2], [3]], cap: 2, deferred: 1, now: new Date(at(0, 0)) });
    const issues = [
      issue({ number: 1, status: "mergeada", timeline: { dispatch: at(0, 5), pr_opened: at(0, 40) } }),
      issue({ number: 2, status: "draft-ci-vermelho", timeline: { dispatch: at(0, 0), pr_opened: at(0, 30) } }),
      issue({ number: 3, status: "mergeada", timeline: { dispatch: at(0, 0), pr_opened: at(0, 10), merged: at(0, 50) } }),
    ];
    const [lote, solo] = computeWaveUnitDurations([wave], issues);
    assert.equal(lote.outcome, "draft");
    assert.equal(lote.dispatch_to_pr_ms, 30 * MIN);
    assert.equal(solo.outcome, "merged");
    assert.equal(solo.dispatch_to_pr_ms, 10 * MIN);
  });
  it("relatório imprime os sinais e marca pr→merge como contexto", () => {
    const wave = buildWaveRecord({ units: [[1]], cap: 1, deferred: 1, now: new Date(at(0, 0)) });
    const report = aggregateWaveRounds([
      { waves: [wave], issues: [issue({ number: 1, timeline: { dispatch: at(0, 0), pr_opened: at(0, 10), merged: at(0, 20) } })] },
    ]);
    assert.equal(report.reversal_signals.cap_hit_true.merged, 1);
    const md = renderWavesReportMarkdown(report);
    assert.match(md, /pr→merge é contexto/);
    assert.match(md, /draft-ci-vermelho \(cap_hit=true\): 0\/1/);
    assert.match(md, /dispatch→PR p50 \(cap_hit=true\): 10m \(n=1\)/);
    assert.match(md, /sem amostra mínima/);
  });
});
