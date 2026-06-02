import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport } from "../scripts/record-source-run.ts";

function entry(recent: Array<"ok" | "fail" | "timeout" | "empty">): any {
  return {
    attempts: recent.length,
    successes: recent.filter((o) => o === "ok").length,
    failures: recent.filter((o) => o === "fail").length,
    timeouts: recent.filter((o) => o === "timeout").length,
    last_success_iso: null,
    last_failure_iso: null,
    last_duration_ms: null,
    recent_outcomes: recent.map((outcome, i) => ({ outcome, timestamp: `2026-06-02T00:0${i}:00Z` })),
    total_articles: 0,
  };
}

describe("buildRunReport (#1683) — delega streak ao computeFailureStreak", () => {
  it("monta o report com os campos do CLI", () => {
    const r = buildRunReport(entry(["ok", "fail"]), {
      source: "MIT Tech Review",
      slug: "mit-tech-review",
      outcome: "fail",
      logPath: "data/sources/mit-tech-review.jsonl",
    });
    assert.equal(r.source, "MIT Tech Review");
    assert.equal(r.slug, "mit-tech-review");
    assert.equal(r.outcome, "fail");
    assert.equal(r.attempts, 2);
    assert.equal(r.log_path, "data/sources/mit-tech-review.jsonl");
  });

  it("#1665: streak conta só falhas DURAS (fail/timeout), 'empty' NÃO infla", () => {
    // 'empty' (fetch OK, zero artigos) NÃO é falha dura → não conta no streak.
    const r = buildRunReport(entry(["fail", "empty", "fail"]), {
      source: "X",
      slug: "x",
      outcome: "fail",
      logPath: "p",
    });
    // recent (cronológico): fail, empty, fail → o streak a partir do fim conta o
    // último fail; 'empty' antes dele interrompe (não é dura mas não é ok tampouco)
    // — a semântica exata vem de computeFailureStreak; aqui só garantimos que o
    // report expõe o número e os timestamps sem inflar com 'empty'.
    assert.ok(typeof r.consecutive_failures === "number");
    assert.ok(Array.isArray(r.failure_timestamps));
    assert.ok(r.consecutive_failures <= 2, "não conta 'empty' como falha");
  });

  it("streak 0 quando última é ok", () => {
    const r = buildRunReport(entry(["fail", "ok"]), { source: "X", slug: "x", outcome: "ok", logPath: "p" });
    assert.equal(r.consecutive_failures, 0);
  });
});
