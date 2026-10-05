/**
 * #9652: o streak de "falhas consecutivas" de fonte contava LINHAS de log, não
 * RODADAS. Uma rodada grava várias linhas por fonte (RSS + busca `site:` +
 * fallback de fetch). Caso real: 27/08/2026 23:14:49, OpenAI — 1 `ok` (RSS, 11
 * artigos) + 3 `fail` com o mesmo timestamp (busca 402 "Usage limit exceeded",
 * fetch 403) → "3 falhas consecutivas" → #6601 → fonte removida por 5 semanas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRun,
  buildOutcomeEntry,
  computeFailureStreak,
  emptyEntry,
  groupOutcomesIntoRounds,
  isSearchQuotaFailure,
  OUTCOME_REASON_MAX,
  recordRunsBatch,
  roundDryStreak,
  roundFailureStreak,
  type OutcomeLike,
  type SourceEntry,
} from "../scripts/lib/source-runs.ts";
import { signalsFromSourceHealth } from "../scripts/collect-edition-signals.ts";
import { renderSourceHealth } from "../scripts/render-categorized-md.ts";

/** Reason real gravado em data/sources/openai.jsonl (busca devolveu 402). */
const REASON_402 =
  'error: {"type":"ErrorResponse","error":{"id":"a81a52d6-7310-42aa-8e0e-3fffce2535c5","status":402,"detail":"Usage limit exceeded.","meta":{"plan":"Search","current_spend":5.0,"usage_limit":5.0,"usage_limit_ty';

/** `recent_outcomes` da OpenAI em data/source-health.json no dia da remoção (só outcome+timestamp). */
const OPENAI_260827: OutcomeLike[] = [
  { outcome: "ok", timestamp: "2026-08-26T15:52:20.189Z" },
  { outcome: "fail", timestamp: "2026-08-26T15:52:20.189Z" },
  { outcome: "fail", timestamp: "2026-08-26T15:52:20.189Z" },
  { outcome: "ok", timestamp: "2026-08-27T23:12:52.690Z" },
  { outcome: "fail", timestamp: "2026-08-27T23:12:52.690Z" },
  { outcome: "fail", timestamp: "2026-08-27T23:12:52.690Z" },
  { outcome: "ok", timestamp: "2026-08-27T23:14:49.327Z" },
  { outcome: "fail", timestamp: "2026-08-27T23:14:49.327Z" },
  { outcome: "fail", timestamp: "2026-08-27T23:14:49.327Z" },
  { outcome: "fail", timestamp: "2026-08-27T23:14:49.327Z" },
];

function entryWith(recent: OutcomeLike[], successes = 100): SourceEntry {
  return { ...emptyEntry(), successes, recent_outcomes: recent as SourceEntry["recent_outcomes"] };
}

/** Fonte não primária de propósito: o fix não pode depender da guarda de #9644. */
const NON_PRIMARY = "Fonte X";

describe("#9652 — caso real 27/08 (OpenAI): 1 rodada com RSS ok não é falha", () => {
  it("o fixture reproduz o bug: 3 LINHAS fail no fim", () => {
    const trailingFailLines = OPENAI_260827.slice().reverse().findIndex((o) => o.outcome !== "fail");
    assert.equal(trailingFailLines, 3);
  });

  it("agrupado por rodada: 3 rodadas, todas ok → streak 0", () => {
    const rounds = groupOutcomesIntoRounds(OPENAI_260827);
    assert.deepEqual(rounds.map((r) => r.verdict), ["ok", "ok", "ok"]);
    assert.equal(computeFailureStreak(entryWith(OPENAI_260827)).consecutive_failures, 0);
  });

  it("signalsFromSourceHealth não emite source_streak nem source_dry", () => {
    const signals = signalsFromSourceHealth({
      sources: { [NON_PRIMARY]: { successes: 130, recent_outcomes: OPENAI_260827 as never } },
    });
    assert.deepEqual(signals, []);
  });

  it("render-categorized-md não sugere desativar", () => {
    const dir = mkdtempSync(join(tmpdir(), "streak-9652-"));
    try {
      const p = join(dir, "source-health.json");
      writeFileSync(p, JSON.stringify({ sources: { [NON_PRIMARY]: { recent_outcomes: OPENAI_260827 } } }));
      assert.doesNotMatch(renderSourceHealth(p), /considere desativar/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ponta a ponta: recordRunsBatch com 1 ok + 3 fail na mesma rodada → consecutive_failures 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "streak-9652-"));
    try {
      const now = "2026-08-27T23:14:49.327Z";
      const results = recordRunsBatch(
        dir,
        [
          { source: "OpenAI", edition: "260828", outcome: "ok", articles: [{ title: "a" }] },
          { source: "OpenAI", edition: "260828", outcome: "fail", reason: REASON_402 },
          { source: "OpenAI", edition: "260828", outcome: "fail", reason: "consecutive_fetch_errors (403)" },
          { source: "OpenAI", edition: "260828", outcome: "fail", reason: "consecutive_fetch_errors (403)" },
        ],
        now,
      );
      assert.equal(results[results.length - 1].consecutive_failures, 0);
      const health = JSON.parse(readFileSync(join(dir, "data/source-health.json"), "utf8"));
      const recent = health.sources.OpenAI.recent_outcomes;
      assert.equal(recent.length, 4);
      assert.ok(recent.every((o: OutcomeLike) => o.edition === "260828"));
      assert.equal(recent[1].search_quota, true);
      assert.equal(recent[2].search_quota, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9652 — falha REAL em rodadas seguidas continua sinalizada", () => {
  const brokenRounds: OutcomeLike[] = [
    { outcome: "ok", timestamp: "t0", edition: "260901" },
    ...["260902", "260903", "260904"].flatMap((ed) => [
      { outcome: "fail", timestamp: `t-${ed}`, edition: ed, reason: "HTTP 404" },
      { outcome: "fail", timestamp: `t-${ed}`, edition: ed, reason: "consecutive_fetch_errors (5xx/404)" },
    ]),
  ];

  it("3 rodadas com 2 linhas fail cada → streak 3 (não 6)", () => {
    const r = roundFailureStreak(brokenRounds);
    assert.equal(r.consecutive_failures, 3);
    assert.deepEqual(r.failure_timestamps, ["t-260902", "t-260903", "t-260904"]);
  });

  it("signalsFromSourceHealth emite source_streak com 3 rodadas", () => {
    const signals = signalsFromSourceHealth({
      sources: { [NON_PRIMARY]: { successes: 5, recent_outcomes: brokenRounds as never } },
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "source_streak");
    assert.equal(signals[0].details.consecutive_failures, 3);
  });

  it("render-categorized-md sinaliza 3 rodadas com falha", () => {
    const dir = mkdtempSync(join(tmpdir(), "streak-9652-"));
    try {
      const p = join(dir, "source-health.json");
      writeFileSync(p, JSON.stringify({ sources: { [NON_PRIMARY]: { recent_outcomes: brokenRounds } } }));
      assert.match(renderSourceHealth(p), /Fonte X — 3 rodadas seguidas com falha/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("render-categorized-md: `empty` não é falha (antes contava qualquer não-ok)", () => {
    const dir = mkdtempSync(join(tmpdir(), "streak-9652-"));
    try {
      const p = join(dir, "source-health.json");
      const empties = ["a", "b", "c"].map((t) => ({ outcome: "empty", timestamp: t }));
      writeFileSync(p, JSON.stringify({ sources: { [NON_PRIMARY]: { recent_outcomes: empties } } }));
      assert.doesNotMatch(renderSourceHealth(p), /considere desativar/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("histórico sem `edition`: agrupa por timestamp", () => {
    const legacy: OutcomeLike[] = ["t1", "t1", "t2", "t2", "t3"].map((t) => ({ outcome: "fail", timestamp: t }));
    assert.equal(roundFailureStreak(legacy).consecutive_failures, 3);
  });

  it("rodadas repetidas da mesma edição (timestamps diferentes) contam como 1", () => {
    const rerun: OutcomeLike[] = [
      { outcome: "fail", timestamp: "2026-08-27T23:12:52.690Z", edition: "260828", reason: "HTTP 404" },
      { outcome: "fail", timestamp: "2026-08-27T23:14:49.327Z", edition: "260828", reason: "HTTP 404" },
    ];
    assert.equal(groupOutcomesIntoRounds(rerun).length, 1);
    assert.equal(roundFailureStreak(rerun).consecutive_failures, 1);
  });
});

describe("#9652 — cota/limite da API de busca (402/429) não é falha da fonte", () => {
  it("isSearchQuotaFailure reconhece 402/429 e não confunde com 403/404/5xx", () => {
    for (const r of [
      REASON_402,
      "HTTP 429 Too Many Requests",
      "status: 429",
      "rate limit exceeded",
      'error: {"status":429}',
    ]) {
      assert.equal(isSearchQuotaFailure(r), true, r);
    }
    for (const r of [
      "consecutive_fetch_errors (403)",
      "consecutive_fetch_errors (403 Forbidden)",
      "consecutive_fetch_errors (5xx/404)",
      "HTTP 404",
      "HTTP 522",
      "timeout_fetch",
      null,
      undefined,
      "",
    ]) {
      assert.equal(isSearchQuotaFailure(r), false, String(r));
    }
  });

  it("3 rodadas só com 402 → streak 0 (rodada neutra)", () => {
    const quota: OutcomeLike[] = ["260826", "260827", "260828"].map((ed) => ({
      outcome: "fail",
      timestamp: `t-${ed}`,
      edition: ed,
      reason: REASON_402,
    }));
    assert.deepEqual(groupOutcomesIntoRounds(quota).map((r) => r.verdict), ["quota", "quota", "quota"]);
    assert.equal(roundFailureStreak(quota).consecutive_failures, 0);
    assert.equal(roundDryStreak(quota), 0);
    const signals = signalsFromSourceHealth({
      sources: { [NON_PRIMARY]: { successes: 0, recent_outcomes: quota as never } },
    });
    assert.deepEqual(signals, []);
  });

  it("3 rodadas só com 429 (via flag search_quota gravada) → streak 0", () => {
    const quota: OutcomeLike[] = ["a", "b", "c"].map((t) => ({ outcome: "fail", timestamp: t, search_quota: true }));
    assert.equal(roundFailureStreak(quota).consecutive_failures, 0);
  });

  it("rodada de cota não zera o streak: fail, 402, fail, fail → 3", () => {
    const mixed: OutcomeLike[] = [
      { outcome: "fail", timestamp: "t1", reason: "HTTP 404" },
      { outcome: "fail", timestamp: "t2", reason: REASON_402 },
      { outcome: "fail", timestamp: "t3", reason: "HTTP 404" },
      { outcome: "fail", timestamp: "t4", reason: "HTTP 404" },
    ];
    assert.equal(roundFailureStreak(mixed).consecutive_failures, 3);
  });

  it("402 + falha de outro caminho (404) na mesma rodada → a rodada conta", () => {
    const r = groupOutcomesIntoRounds([
      { outcome: "fail", timestamp: "t1", reason: REASON_402 },
      { outcome: "fail", timestamp: "t1", reason: "consecutive_fetch_errors (404)" },
    ]);
    assert.equal(r[0].verdict, "fail");
  });

  it("linha sem `outcome` (registro malformado do histórico) é ignorada", () => {
    const r = groupOutcomesIntoRounds([
      { outcome: "fail", timestamp: "t1", reason: REASON_402 },
      { timestamp: "t1" },
    ]);
    assert.equal(r[0].verdict, "quota");
  });
});

describe("#9652 — o que vai pro recent_outcomes", () => {
  it("buildOutcomeEntry grava edição, reason truncado e flag de cota só em falha dura", () => {
    const e = buildOutcomeEntry("fail", "t", "260828", REASON_402 + "x".repeat(500));
    assert.equal(e.edition, "260828");
    assert.equal(e.search_quota, true);
    assert.equal(e.reason?.length, OUTCOME_REASON_MAX);
    const ok = buildOutcomeEntry("ok", "t", "260828", "ignorado");
    assert.deepEqual(ok, { outcome: "ok", timestamp: "t", edition: "260828" });
    assert.deepEqual(buildOutcomeEntry("fail", "t"), { outcome: "fail", timestamp: "t" });
  });

  it("applyRun usa buildOutcomeEntry", () => {
    const next = applyRun(emptyEntry(), { source: "X", edition: "260828", outcome: "fail", reason: "HTTP 429" }, "t");
    assert.deepEqual(next.recent_outcomes, [
      { outcome: "fail", timestamp: "t", edition: "260828", reason: "HTTP 429", search_quota: true },
    ]);
  });
});
