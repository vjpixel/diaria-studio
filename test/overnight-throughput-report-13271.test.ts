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
  evaluateWaveCapReversal,
  renderReversalLine,
  WAVE_CAP_REVERSAL_P90_MS,
} from "../scripts/lib/overnight-waves-report.ts";
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
    assert.deepEqual(r.milestone_coverage, { dispatch: 2, pr_opened: 1, ci_green: 1, review_done: 0, gate2: 0, merged: 2 });
    assert.equal(r.pulada_total, 4);
    assert.deepEqual(r.pulada_by_motivo, { "requer-sessao-local": 2, "pr-em-voo": 1, "(sem motivo)": 1 });
  });

  it("renderiza a tabela de trechos e os motivos em ordem decrescente, com corte em --top", () => {
    const md = renderThroughputMarkdown(aggregateThroughput([round]), 1);
    assert.match(md, /Mergeadas: 3 \| por rodada: 3,0 \| por hora: 1,0/);
    assert.match(md, /\| dispatch→merged \| 1h00m \| 1h00m \| 2 \|/);
    assert.match(md, /Cobertura do timeline \(de 2 unidades com merged\): dispatch 2, pr_opened 1, ci_green 1, review_done 0, gate2 0, merged 2/);
    assert.match(md, /\| requer-sessao-local \| 2 \|/);
    assert.match(md, /\| \(outros 2 motivos\) \| 2 \|/);
  });

  it("separa review, espera pelo Gate 2 e fila de merge sem duplicar lote", () => {
    const timeline = {
      pr_opened: "2026-11-16T00:00:00Z",
      ci_green: "2026-11-16T00:01:00Z",
      review_done: "2026-11-16T00:10:00Z",
      gate2: "2026-11-16T00:12:00Z",
      merged: "2026-11-16T00:13:00Z",
    };
    const r = aggregateThroughput([{ dir: "261116", issues: [
      issue({ number: 1, pr: 100, timeline }),
      issue({ number: 2, pr: 100, timeline }),
    ] }]);
    for (const [name, minutes] of [
      ["pr_opened→review_done", 10], ["review_done→gate2", 2],
      ["ci_green→gate2", 11], ["gate2→merged", 1],
    ] as const) {
      assert.deepEqual(r.segments[name], { p50_ms: minutes * MIN, p90_ms: minutes * MIN, n: 1 });
    }
    assert.equal(r.milestone_coverage.review_done, 1);
    assert.equal(r.milestone_coverage.gate2, 1);
    const legacy = aggregateThroughput([round]);
    assert.equal(legacy.segments["gate2→merged"].n, 0);
    assert.equal(legacy.segments["pr_opened→review_done"].p50_ms, null);
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

describe("evaluateWaveCapReversal (#13270)", () => {
  const T = WAVE_CAP_REVERSAL_P90_MS;
  it("sem amostra em onda cheia", () => {
    assert.equal(evaluateWaveCapReversal({ cap_hit_true: null, cap_hit_false: 90 * MIN }).verdict, "sem-amostra");
  });
  it("dentro do limiar não dispara", () => {
    assert.equal(evaluateWaveCapReversal({ cap_hit_true: T, cap_hit_false: null }).verdict, "nao-disparou");
  });
  it("caso medido na #13270 (1h29m cheias vs 56m): dispara, ondas cheias piores", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: 89 * MIN, cap_hit_false: 56 * MIN });
    assert.equal(v.verdict, "disparou");
    assert.match(renderReversalLine(v), /DISPAROU, e as ondas cheias ficam piores/);
  });
  it("as duas acima do limiar e as cheias não piores: dispara sem efeito do teto", () => {
    const v = evaluateWaveCapReversal({ cap_hit_true: 40 * MIN, cap_hit_false: 50 * MIN });
    assert.equal(v.verdict, "disparou-sem-efeito-do-teto");
    assert.match(renderReversalLine(v), /O gargalo não é o teto/);
  });
});
