import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  slugify,
  emptyEntry,
  applyRun,
  computeFailureStreak,
  recordRun,
  recordRunsBatch,
  type SourceEntry,
  type RunRecord,
} from "../scripts/lib/source-runs.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("slugify", () => {
  it("normaliza com lowercase, sem acentos, hífens", () => {
    assert.equal(slugify("MIT Technology Review"), "mit-technology-review");
    assert.equal(slugify("Canaltech (IA)"), "canaltech-ia");
    assert.equal(slugify("São Paulo"), "sao-paulo");
  });

  it("remove hífens trailing/leading", () => {
    assert.equal(slugify("--oi--"), "oi");
  });

  it("colapsa múltiplos separadores", () => {
    assert.equal(slugify("a  b   c"), "a-b-c");
  });
});

describe("applyRun", () => {
  const now = "2026-04-24T12:00:00.000Z";

  it("outcome=ok incrementa successes + last_success + articles", () => {
    const prev = emptyEntry();
    const run: RunRecord = {
      source: "Tecnoblog",
      outcome: "ok",
      duration_ms: 1000,
      articles: [{ title: "A" }, { title: "B" }],
    };
    const next = applyRun(prev, run, now);
    assert.equal(next.attempts, 1);
    assert.equal(next.successes, 1);
    assert.equal(next.failures, 0);
    assert.equal(next.last_success_iso, now);
    assert.equal(next.last_duration_ms, 1000);
    assert.equal(next.total_articles, 2);
  });

  it("outcome=fail incrementa failures + last_failure (sem articles)", () => {
    const prev = emptyEntry();
    const run: RunRecord = { source: "X", outcome: "fail", duration_ms: 500 };
    const next = applyRun(prev, run, now);
    assert.equal(next.failures, 1);
    assert.equal(next.last_failure_iso, now);
    assert.equal(next.total_articles, 0);
  });

  it("outcome=timeout incrementa timeouts + last_failure", () => {
    const prev = emptyEntry();
    const run: RunRecord = { source: "X", outcome: "timeout" };
    const next = applyRun(prev, run, now);
    assert.equal(next.timeouts, 1);
    assert.equal(next.last_failure_iso, now);
  });

  it("recent_outcomes cresce e trunca em 10", () => {
    let entry = emptyEntry();
    for (let i = 0; i < 12; i++) {
      entry = applyRun(entry, { source: "X", outcome: "ok" }, `2026-04-24T12:${String(i).padStart(2, "0")}:00.000Z`);
    }
    assert.equal(entry.recent_outcomes.length, 10);
    assert.equal(entry.recent_outcomes[0].timestamp, "2026-04-24T12:02:00.000Z");
  });

  it("não muta a entry original (pure)", () => {
    const prev = emptyEntry();
    const run: RunRecord = { source: "X", outcome: "ok" };
    const next = applyRun(prev, run, now);
    assert.notEqual(prev, next);
    assert.equal(prev.attempts, 0);
    assert.equal(next.attempts, 1);
  });
});

describe("computeFailureStreak", () => {
  it("zero failures recentes", () => {
    const entry: SourceEntry = {
      ...emptyEntry(),
      recent_outcomes: [
        { outcome: "ok", timestamp: "t1" },
        { outcome: "ok", timestamp: "t2" },
      ],
    };
    const r = computeFailureStreak(entry);
    assert.equal(r.consecutive_failures, 0);
    assert.deepEqual(r.failure_timestamps, []);
  });

  it("streak de 3 failures no final", () => {
    const entry: SourceEntry = {
      ...emptyEntry(),
      recent_outcomes: [
        { outcome: "ok", timestamp: "t1" },
        { outcome: "fail", timestamp: "t2" },
        { outcome: "fail", timestamp: "t3" },
        { outcome: "timeout", timestamp: "t4" },
      ],
    };
    const r = computeFailureStreak(entry);
    assert.equal(r.consecutive_failures, 3);
    assert.deepEqual(r.failure_timestamps, ["t2", "t3", "t4"]);
  });

  it("todas as ocorrências são failures", () => {
    const entry: SourceEntry = {
      ...emptyEntry(),
      recent_outcomes: [
        { outcome: "fail", timestamp: "t1" },
        { outcome: "fail", timestamp: "t2" },
      ],
    };
    const r = computeFailureStreak(entry);
    assert.equal(r.consecutive_failures, 2);
  });
});

describe("recordRun / recordRunsBatch — I/O", () => {
  it("escreve em source-health.json e no log individual", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-runs-"));
    try {
      const run: RunRecord = {
        source: "Canaltech (IA)",
        outcome: "ok",
        duration_ms: 2500,
        articles: [{ title: "A", url: "https://canaltech.com.br/x" }],
        edition: "260424",
      };
      const r = recordRun(tmp, run);

      assert.equal(r.source, "Canaltech (IA)");
      assert.equal(r.slug, "canaltech-ia");
      assert.equal(r.attempts, 1);

      const health = JSON.parse(readFileSync(join(tmp, "data/source-health.json"), "utf8"));
      assert.equal(health.sources["Canaltech (IA)"].successes, 1);

      const log = readFileSync(join(tmp, "data/sources/canaltech-ia.jsonl"), "utf8");
      assert.ok(log.includes("\"source\":\"Canaltech (IA)\""));
      assert.ok(log.includes("\"edition\":\"260424\""));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("batch registra múltiplos runs em sequência", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-runs-"));
    try {
      const runs: RunRecord[] = [
        { source: "A", outcome: "ok", duration_ms: 100 },
        { source: "B", outcome: "fail", duration_ms: 5000, reason: "timeout_fetch" },
        { source: "C", outcome: "timeout", duration_ms: 20000 },
      ];
      const results = recordRunsBatch(tmp, runs);
      assert.equal(results.length, 3);

      const health = JSON.parse(readFileSync(join(tmp, "data/source-health.json"), "utf8"));
      assert.equal(Object.keys(health.sources).length, 3);
      assert.equal(health.sources["A"].successes, 1);
      assert.equal(health.sources["B"].failures, 1);
      assert.equal(health.sources["C"].timeouts, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("múltiplos runs da mesma fonte acumulam stats", () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-runs-"));
    try {
      const runs: RunRecord[] = [
        { source: "X", outcome: "ok" },
        { source: "X", outcome: "fail" },
        { source: "X", outcome: "ok" },
      ];
      recordRunsBatch(tmp, runs);
      const health = JSON.parse(readFileSync(join(tmp, "data/source-health.json"), "utf8"));
      assert.equal(health.sources["X"].attempts, 3);
      assert.equal(health.sources["X"].successes, 2);
      assert.equal(health.sources["X"].failures, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
