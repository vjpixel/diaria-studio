/**
 * test/round-diff-stats.test.ts (#7113)
 *
 * Dado sintético — sem bater em `git`/`run-log.jsonl` real, conforme a
 * própria issue exige ("Teste de regressão sobre o cálculo (dado
 * sintético; sem bater em `git` real)").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRoundDiffStatsRecord,
  buildRoundDiffStatsRunLogEvent,
  computeAllRoundDiffStatsWindows,
  computeWindowedRoundDiffStats,
  evaluateRoundDiffAlarm,
  formatRoundDiffStatsReport,
  parseRoundDiffStatsEvents,
  ROUND_DIFF_RATIO_ALARM_THRESHOLD,
  ROUND_DIFF_STATS_MESSAGE,
  type RoundDiffStatsRecord,
} from "../scripts/lib/round-diff-stats.ts";

function record(overrides: Partial<RoundDiffStatsRecord> = {}): RoundDiffStatsRecord {
  return {
    sessionKind: "overnight",
    base: "aaa",
    head: "bbb",
    files: 10,
    added: 1000,
    removed: 100,
    ratio: 10,
    net: 900,
    capturedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildRoundDiffStatsRecord", () => {
  it("deriva ratio/net a partir de stats + carimba capturedAt com `now`", () => {
    const now = new Date("2026-09-02T08:00:00.000Z");
    const rec = buildRoundDiffStatsRecord(
      { sessionKind: "develop", base: "base-sha", head: "head-sha", stats: { files: 5, added: 200, removed: 20 } },
      now,
    );
    assert.equal(rec.sessionKind, "develop");
    assert.equal(rec.ratio, 10);
    assert.equal(rec.net, 180);
    assert.equal(rec.capturedAt, now.toISOString());
  });

  it("ratio null quando removed é 0", () => {
    const rec = buildRoundDiffStatsRecord({
      sessionKind: "continuo",
      base: "a",
      head: "b",
      stats: { files: 1, added: 50, removed: 0 },
    });
    assert.equal(rec.ratio, null);
  });
});

describe("buildRoundDiffStatsRunLogEvent", () => {
  it("monta o envelope RunLogEvent com message round_diff_stats", () => {
    const rec = record();
    const event = buildRoundDiffStatsRunLogEvent(rec, "260902");
    assert.equal(event.message, ROUND_DIFF_STATS_MESSAGE);
    assert.equal(event.agent, "overnight");
    assert.equal(event.edition, "260902");
    assert.deepEqual(event.details, rec);
  });
});

describe("parseRoundDiffStatsEvents", () => {
  it("extrai só entries válidas de round_diff_stats, ignorando outros tipos e malformadas", () => {
    const rec = record();
    const entries = [
      { message: "subagent_metrics", details: {} },
      { message: ROUND_DIFF_STATS_MESSAGE, details: rec },
      { message: ROUND_DIFF_STATS_MESSAGE, details: { added: "not-a-number" } },
      null,
      "garbage",
      { message: ROUND_DIFF_STATS_MESSAGE }, // sem details
    ];
    const parsed = parseRoundDiffStatsEvents(entries);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], rec);
  });

  it("array vazio devolve array vazio", () => {
    assert.deepEqual(parseRoundDiffStatsEvents([]), []);
  });
});

describe("computeWindowedRoundDiffStats", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  it("agrega só records dentro da janela", () => {
    const records = [
      record({ capturedAt: "2026-09-09T00:00:00.000Z", added: 100, removed: 10 }), // 1d atrás — dentro de 7d
      record({ capturedAt: "2026-08-01T00:00:00.000Z", added: 5000, removed: 10 }), // >30d atrás — fora
    ];
    const w = computeWindowedRoundDiffStats(records, 7, now);
    assert.equal(w.rounds, 1);
    assert.equal(w.added, 100);
    assert.equal(w.removed, 10);
    assert.equal(w.ratio, 10);
    assert.equal(w.net, 90);
    assert.equal(w.netPerDay, 90 / 7);
  });

  it("janela vazia devolve zeros e ratio null", () => {
    const w = computeWindowedRoundDiffStats([], 7, now);
    assert.deepEqual(w, { windowDays: 7, rounds: 0, added: 0, removed: 0, ratio: null, net: 0, netPerDay: 0 });
  });

  it("timestamp inválido é ignorado, não quebra o cálculo", () => {
    const records = [record({ capturedAt: "not-a-date" }), record({ capturedAt: now.toISOString() })];
    const w = computeWindowedRoundDiffStats(records, 7, now);
    assert.equal(w.rounds, 1);
  });
});

describe("computeAllRoundDiffStatsWindows", () => {
  it("devolve as 3 janelas 7/30/90 na ordem", () => {
    const windows = computeAllRoundDiffStatsWindows([record({ capturedAt: new Date().toISOString() })]);
    assert.deepEqual(
      windows.map((w) => w.windowDays),
      [7, 30, 90],
    );
  });
});

describe("evaluateRoundDiffAlarm", () => {
  it("alarma quando ratio >= limiar", () => {
    const w = computeWindowedRoundDiffStats([record({ added: 200, removed: 10, capturedAt: new Date().toISOString() })], 7);
    const result = evaluateRoundDiffAlarm(w);
    assert.equal(result.alarming, true);
  });

  it("não alarma abaixo do limiar", () => {
    const w = computeWindowedRoundDiffStats([record({ added: 50, removed: 10, capturedAt: new Date().toISOString() })], 7);
    assert.equal(evaluateRoundDiffAlarm(w).alarming, false);
  });

  it("não alarma com janela vazia (rounds === 0)", () => {
    const w = computeWindowedRoundDiffStats([], 7);
    assert.equal(evaluateRoundDiffAlarm(w).alarming, false);
  });

  it("alarma quando ratio é null (sem remoções) e added > 0", () => {
    const w = computeWindowedRoundDiffStats([record({ added: 500, removed: 0, capturedAt: new Date().toISOString() })], 7);
    assert.equal(w.ratio, null);
    assert.equal(evaluateRoundDiffAlarm(w).alarming, true);
  });

  it("limiar customizado é respeitado", () => {
    const w = computeWindowedRoundDiffStats([record({ added: 50, removed: 10, capturedAt: new Date().toISOString() })], 7);
    assert.equal(w.ratio, 5);
    assert.equal(evaluateRoundDiffAlarm(w, 3).alarming, true);
    assert.equal(evaluateRoundDiffAlarm(w, 10).alarming, false);
  });

  it("usa ROUND_DIFF_RATIO_ALARM_THRESHOLD (10) por default", () => {
    assert.equal(ROUND_DIFF_RATIO_ALARM_THRESHOLD, 10);
  });
});

describe("formatRoundDiffStatsReport", () => {
  it("gera a tabela markdown com as janelas na ordem recebida", () => {
    const windows = computeAllRoundDiffStatsWindows([record({ capturedAt: new Date().toISOString() })]);
    const md = formatRoundDiffStatsReport(windows);
    assert.match(md, /\| janela \| rodadas \| adições \| remoções \| razão \| líquido\/dia \|/);
    assert.match(md, /\| 7d \|/);
    assert.match(md, /\| 30d \|/);
    assert.match(md, /\| 90d \|/);
  });
});
