import { test } from "node:test";
import assert from "node:assert/strict";
import { owningSessionId, recomputeRowCost } from "../scripts/recompute-stage-costs.ts";
import type { UsageEntry } from "../scripts/lib/session-transcript.ts";
import type { StageRow } from "../scripts/update-stage-status.ts";

function entry(p: Partial<UsageEntry> & { sessionFile: string }): UsageEntry {
  return {
    timestamp: "2026-09-10T12:00:00Z",
    model: "claude-sonnet-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    isSidechain: false,
    ...p,
  };
}

test("owningSessionId resolve arquivo principal e de subagente", () => {
  assert.equal(owningSessionId("/t/abc.jsonl"), "abc");
  assert.equal(owningSessionId("/t/abc/subagents/agent-1.jsonl"), "abc");
});

test("recalcula com a tabela atual a sessão cujos tokens batem (Sonnet 2/10)", () => {
  const mine = [
    entry({ sessionFile: "/t/me.jsonl", inputTokens: 1_000_000, outputTokens: 100_000 }),
    entry({ sessionFile: "/t/me/subagents/agent-x.jsonl", inputTokens: 0, cacheReadInputTokens: 1_000_000, isSidechain: true }),
  ];
  const other = [entry({ sessionFile: "/t/other.jsonl", inputTokens: 5, outputTokens: 5 })];
  // cost antigo (tabela 3/15) — valor qualquer inflado
  const row: StageRow = { stage: 2, status: "done", cost_usd: 99, tokens_in: 2_000_000, tokens_out: 100_000, session_filter: "current_session" };
  const out = recomputeRowCost(row, [...other, ...mine], null);
  assert.equal(out.status, "recomputed");
  if (out.status !== "recomputed") return;
  assert.equal(out.sessionId, "me");
  // 1M in * 2 + 0.1M out * 10 + 1M cache read * 2 * 0.1 = 2 + 1 + 0.2
  assert.equal(out.newCost, 3.2);
  assert.equal(out.oldCost, 99);
});

test("idempotente: row já recalculado produz o mesmo valor", () => {
  const es = [entry({ sessionFile: "/t/me.jsonl", model: "claude-opus-5-5", inputTokens: 0, cacheReadInputTokens: 1_000_000 })];
  const row: StageRow = { stage: 1, status: "done", cost_usd: 0.2, tokens_in: 1_000_000, tokens_out: 0, session_filter: "current_session" };
  const a = recomputeRowCost(row, es, null);
  assert.equal(a.status === "recomputed" && a.newCost, 0.2); // 4 * 0.05
  const b = recomputeRowCost({ ...row, cost_usd: a.status === "recomputed" ? a.newCost : 0 }, es, null);
  assert.deepEqual(a.status === "recomputed" && a.newCost, b.status === "recomputed" && b.newCost);
});

test("pula cli_json, tokens que não batem e casamento ambíguo", () => {
  const base: StageRow = { stage: 1, status: "done", cost_usd: 1, tokens_in: 10, tokens_out: 1 };
  assert.deepEqual(recomputeRowCost({ ...base, session_filter: "cli_json" }, [], null), { status: "skipped", reason: "cli_json_priced_by_cli" });
  const e = (f: string) => entry({ sessionFile: f, inputTokens: 10, outputTokens: 1 });
  assert.deepEqual(recomputeRowCost({ ...base, tokens_in: 11 }, [e("/t/a.jsonl")], null), { status: "skipped", reason: "tokens_not_matched_in_transcripts" });
  assert.deepEqual(recomputeRowCost(base, [e("/t/a.jsonl"), e("/t/b.jsonl")], null), { status: "skipped", reason: "ambiguous_session_match" });
});

test("all_sessions usa a janela inteira", () => {
  const es = [entry({ sessionFile: "/t/a.jsonl", inputTokens: 500_000 }), entry({ sessionFile: "/t/b.jsonl", inputTokens: 500_000 })];
  const out = recomputeRowCost({ stage: 1, status: "done", cost_usd: 3, tokens_in: 1_000_000, tokens_out: 0, session_filter: "all_sessions" }, es, null);
  assert.equal(out.status === "recomputed" && out.newCost, 2);
});
