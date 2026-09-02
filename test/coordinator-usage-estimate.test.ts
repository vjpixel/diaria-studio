/**
 * test/coordinator-usage-estimate.test.ts (#6634)
 *
 * Cobre `scripts/coordinator-usage-estimate.ts` — a implementação do fallback
 * `context_size_proxy` do contrato `coordinator_tokens_estimate` (#3453 Rec
 * 1/#4815). Antes deste script, o evento saiu `unavailable` em 9/9 ocorrências
 * reais porque derivar o usage da PRÓPRIA sessão coordenadora não é possível
 * por tool call — só pelo transcript local. Fixture de transcript em tmpdir
 * (mesmo padrão de `test/aggregate-session-tokens.test.ts`) — nunca toca
 * `~/.claude/projects/` real nem `data/run-log.jsonl` de produção.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeCheckpointDelta,
  lastFiniteCoordinatorTokens,
  decideEstimate,
  estimateToDetails,
  estimateCoordinatorUsage,
  COORDINATOR_ESTIMATE_MESSAGE,
} from "../scripts/coordinator-usage-estimate.ts";
import { encodeProjectDirName } from "../scripts/lib/session-transcript.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "coordinator-usage-estimate-"));
}

/** Grava um transcript mínimo com `usage` real no formato que o harness escreve. */
function writeTranscript(root: string, sessionId: string, turns: { input: number; cacheRead: number; output: number; timestamp?: string }[]): void {
  const dir = join(root, ".claude-home", ".claude", "projects", encodeProjectDirName(root));
  mkdirSync(dir, { recursive: true });
  const lines = turns.map((t) =>
    JSON.stringify({
      type: "assistant",
      timestamp: t.timestamp ?? "2026-01-01T12:00:00.000Z",
      isSidechain: false,
      message: {
        model: "claude-sonnet-5",
        usage: {
          input_tokens: t.input,
          output_tokens: t.output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: t.cacheRead,
        },
      },
    }),
  );
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

function writeRunLog(root: string, events: unknown[]): void {
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "run-log.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

describe("computeCheckpointDelta (#6634 — delta, não cumulativo: o aggregate SOMA eventos)", () => {
  it("sem base (nenhum evento numerado ainda) → o cumulativo inteiro vira delta", () => {
    assert.equal(computeCheckpointDelta(120_000, null), 120_000);
  });
  it("com base anterior → só o trecho novo da fase", () => {
    assert.equal(computeCheckpointDelta(120_000, 40_000), 80_000);
  });
  it("cumulativo < base (sessão reiniciou entre checkpoints) → cumulativo da sessão nova, nunca negativo", () => {
    assert.equal(computeCheckpointDelta(5_000, 40_000), 5_000);
    assert.equal(computeCheckpointDelta(40_000, 40_000), 0);
  });
});

describe("lastFiniteCoordinatorTokens (#6634)", () => {
  it("pega o ÚLTIMO evento com tokens finito da mesma edition+agent; ignora outros kinds, editions e unavailable", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260901", message: COORDINATOR_ESTIMATE_MESSAGE, details: { phase: "fase_0", tokens: 10_000 } }),
      JSON.stringify({ agent: "develop", edition: "260901", message: COORDINATOR_ESTIMATE_MESSAGE, details: { phase: "fase_0", tokens: 999_999 } }),
      JSON.stringify({ agent: "overnight", edition: "260901", message: COORDINATOR_ESTIMATE_MESSAGE, details: { phase: "fase_1", tokens: null, source: "unavailable" } }),
      JSON.stringify({ agent: "overnight", edition: "260902", message: COORDINATOR_ESTIMATE_MESSAGE, details: { phase: "fase_0", tokens: 888_888 } }),
      JSON.stringify({ agent: "overnight", edition: "260901", message: "subagent_metrics", details: { subagent_tokens: 123 } }),
      "linha truncada {",
    ];
    assert.equal(lastFiniteCoordinatorTokens(lines, "260901", "overnight"), 10_000);
    assert.equal(lastFiniteCoordinatorTokens(lines, "260901", "develop"), 999_999);
    assert.equal(lastFiniteCoordinatorTokens(lines, "260903", "overnight"), null);
  });
});

describe("decideEstimate (#6634 — fail-soft #6170: nunca contamina, nunca inventa zero)", () => {
  const okBase = { usageEntries: 3, tokensIn: 10_000, tokensOut: 2_000, lastFiniteTokens: null as number | null };

  it("sem session id → unavailable no_session_id", () => {
    assert.deepEqual(
      decideEstimate({ sessionId: null, sessionFilter: "all_sessions", filterReason: "no_session_id", ...okBase }),
      { status: "unavailable", reason: "no_session_id" },
    );
  });
  it("transcript da sessão não encontrado → unavailable session_file_not_found (NUNCA fallback all_sessions)", () => {
    assert.deepEqual(
      decideEstimate({ sessionId: "abc", sessionFilter: "all_sessions", filterReason: "session_file_not_found", ...okBase }),
      { status: "unavailable", reason: "session_file_not_found" },
    );
  });
  it("zero entradas de usage na janela → unavailable no_usage_entries (nunca 0 como consumo real)", () => {
    assert.deepEqual(
      decideEstimate({ sessionId: "abc", sessionFilter: "current_session", usageEntries: 0, tokensIn: 0, tokensOut: 0, lastFiniteTokens: null }),
      { status: "unavailable", reason: "no_usage_entries" },
    );
  });
  it("ok → delta desde a base, com cumulativo preservado", () => {
    const est = decideEstimate({ sessionId: "abc", sessionFilter: "current_session", ...okBase, lastFiniteTokens: 4_000 });
    assert.deepEqual(est, { status: "ok", tokens: 8_000, cumulativeTokens: 12_000, sessionId: "abc" });
  });
});

describe("estimateToDetails (#6634)", () => {
  it("ok → source context_size_proxy + cumulative_tokens", () => {
    assert.deepEqual(estimateToDetails({ status: "ok", tokens: 8_000, cumulativeTokens: 12_000, sessionId: "abc" }, "fase_0"), {
      phase: "fase_0",
      tokens: 8_000,
      source: "context_size_proxy",
      cumulative_tokens: 12_000,
    });
  });
  it("unavailable → tokens null + reason (a lacuna vira telemetria, não buraco)", () => {
    assert.deepEqual(estimateToDetails({ status: "unavailable", reason: "no_session_id" }, "fase_2"), {
      phase: "fase_2",
      tokens: null,
      source: "unavailable",
      reason: "no_session_id",
    });
  });
});

describe("estimateCoordinatorUsage — integração com transcript real em tmpdir (#6634)", () => {
  it("transcript presente → usage REAL somado (input+cache_read+output) e delta desde o run-log", () => {
    const root = tmpRoot();
    try {
      writeTranscript(root, "sess-1", [
        { input: 1000, cacheRead: 5000, output: 200 },
        { input: 1000, cacheRead: 5000, output: 200 },
      ]);
      writeRunLog(root, [
        { agent: "overnight", edition: "260902", message: COORDINATOR_ESTIMATE_MESSAGE, details: { phase: "fase_0", tokens: 4000 } },
      ]);
      const est = estimateCoordinatorUsage({
        edition: "260902",
        agent: "overnight",
        sessionId: "sess-1",
        rootDir: root,
        homeDir: join(root, ".claude-home"),
      });
      // cumulative = 2 turnos × (1000 in + 5000 cache_read + 200 out) = 12400;
      // delta = 12400 − 4000 (base do evento anterior da mesma rodada).
      assert.deepEqual(est, { status: "ok", tokens: 8400, cumulativeTokens: 12400, sessionId: "sess-1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run-log ausente → delta = cumulativo inteiro (primeiro checkpoint da rodada)", () => {
    const root = tmpRoot();
    try {
      writeTranscript(root, "sess-1", [{ input: 1000, cacheRead: 0, output: 500 }]);
      const est = estimateCoordinatorUsage({
        edition: "260902",
        agent: "develop",
        sessionId: "sess-1",
        rootDir: root,
        homeDir: join(root, ".claude-home"),
      });
      assert.deepEqual(est, { status: "ok", tokens: 1500, cumulativeTokens: 1500, sessionId: "sess-1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("transcript ausente → unavailable session_file_not_found; env sem session id → no_session_id", () => {
    const root = tmpRoot();
    try {
      assert.deepEqual(
        estimateCoordinatorUsage({ edition: "260902", agent: "continuo", sessionId: "missing", rootDir: root, homeDir: join(root, ".claude-home") }),
        { status: "unavailable", reason: "session_file_not_found" },
      );
      assert.deepEqual(
        estimateCoordinatorUsage({ edition: "260902", agent: "continuo", env: {}, rootDir: root, homeDir: join(root, ".claude-home") }),
        { status: "unavailable", reason: "no_session_id" },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
