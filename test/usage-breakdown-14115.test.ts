/**
 * test/usage-breakdown-14115.test.ts (#14115)
 *
 * Itens 1 e 2 da issue: `stage-status.json` passa a guardar o uso POR MODELO
 * (`model_usage`, do `modelUsage` do envelope `claude --print` e do model de
 * cada resposta do transcript) e os turnos/contexto da sessão interativa
 * (`turn_stats`). Formato aditivo: linha antiga sem os campos segue legível.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliJsonUsage } from "../scripts/lib/cli-usage-json.ts";
import { accumulateCliRun } from "../scripts/lib/edition-stage-runner.ts";
import { mergeModelUsage, parseCliModelUsage, summarizeTurnStats } from "../scripts/lib/usage-breakdown.ts";
import { captureUsageForWindow } from "../scripts/capture-stage-usage.ts";
import { applyUpdate, makeInitialDoc, type StageRow } from "../scripts/update-stage-status.ts";
import type { UsageEntry } from "../scripts/lib/session-transcript.ts";

/** Envelope `claude --print --output-format json` com 2 modelos (coordenador opus + subagente sonnet). */
const TWO_MODEL_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  num_turns: 42,
  total_cost_usd: 3.5,
  usage: { input_tokens: 30, cache_creation_input_tokens: 2000, cache_read_input_tokens: 90000, output_tokens: 700 },
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 10,
      outputTokens: 500,
      cacheReadInputTokens: 80000,
      cacheCreationInputTokens: 1500,
      webSearchRequests: 0,
      costUSD: 3,
      contextWindow: 200000,
    },
    "claude-sonnet-5-5": {
      inputTokens: 20,
      outputTokens: 200,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 500,
      costUSD: 0.5,
    },
  },
  result: "ok",
});

describe("#14115 item 1 — model_usage do envelope CLI", () => {
  it("parseCliJsonUsage devolve os 2 modelos separados, com custo de cada um", () => {
    const u = parseCliJsonUsage(TWO_MODEL_ENVELOPE);
    assert.ok(u);
    assert.deepEqual(u.models, ["opus-5-5", "sonnet-5-5"]);
    assert.deepEqual(u.modelUsage, {
      "opus-5-5": { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 80000, cache_creation_input_tokens: 1500, cost_usd: 3 },
      "sonnet-5-5": { input_tokens: 20, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 500, cost_usd: 0.5 },
    });
    // O total segue o mesmo de antes (compat).
    assert.equal(u.costUsd, 3.5);
    assert.equal(u.tokensIn, 30 + 2000 + 90000);
  });

  it("modelUsage ausente: sem chave modelUsage (forma antiga do retorno)", () => {
    const u = parseCliJsonUsage(JSON.stringify({ total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 } }));
    assert.ok(u);
    assert.equal("modelUsage" in u, false);
    assert.equal(parseCliModelUsage(undefined), null);
    assert.equal(parseCliModelUsage([]), null);
  });

  it("ids que colapsam no mesmo nome curto somam; custo some se um lado não tem", () => {
    const m = parseCliModelUsage({
      "claude-haiku-4-5-20251001": { inputTokens: 1, outputTokens: 2, costUSD: 0.1 },
      "claude-haiku-4-5": { inputTokens: 3, outputTokens: 4 },
    });
    assert.deepEqual(m, {
      "haiku-4-5": { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  });

  it("accumulateCliRun grava model_usage na 1ª execução e soma por modelo na 2ª (#9312)", () => {
    const usage = parseCliJsonUsage(TWO_MODEL_ENVELOPE);
    const first = accumulateCliRun({ stage: 2, status: "running" }, usage, { numTurns: 42 });
    assert.equal(first.model_usage?.["opus-5-5"].cost_usd, 3);
    assert.equal(first.cli_run_log?.[0].model_usage?.["sonnet-5-5"].output_tokens, 200);

    const row = { stage: 2, status: "running", ...first } as StageRow;
    const second = accumulateCliRun(row, usage, { numTurns: 10 });
    assert.equal(second.model_usage?.["opus-5-5"].cost_usd, 6);
    assert.equal(second.model_usage?.["sonnet-5-5"].input_tokens, 40);
    assert.equal(second.cost_usd, 7);
    assert.equal(second.cli_run_log?.length, 2);
  });

  it("compat: linha cli_json ANTIGA (sem model_usage) não ganha um mapa que só cobre a execução nova", () => {
    const legacy: StageRow = {
      stage: 2,
      status: "done",
      cost_usd: 4,
      tokens_in: 1000,
      tokens_out: 10,
      models: ["opus-5-5"],
      session_filter: "cli_json",
      num_turns: 50,
      cli_runs: 1,
    };
    const out = accumulateCliRun(legacy, parseCliJsonUsage(TWO_MODEL_ENVELOPE), { numTurns: 1 });
    assert.equal(out.model_usage, undefined);
    assert.equal(out.cost_usd, 7.5); // total continua somando como antes
  });

  it("envelope sem modelUsage: saída de accumulateCliRun igual à de antes (sem chave model_usage)", () => {
    const raw = JSON.stringify({ total_cost_usd: 1, num_turns: 3, usage: { input_tokens: 5, output_tokens: 2 } });
    const out = accumulateCliRun({ stage: 1, status: "running" }, parseCliJsonUsage(raw), { numTurns: 3 });
    assert.equal("model_usage" in out, false);
    assert.deepEqual(out.cli_run_log, [{ num_turns: 3, cost_usd: 1 }]);
  });

  it("mergeModelUsage soma modelos em comum e preserva os exclusivos", () => {
    const a = { x: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, cost_usd: 0.1 } };
    const b = { x: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, cost_usd: 0.2 }, y: a.x };
    const m = mergeModelUsage(a, b);
    assert.equal(m.x.cost_usd, 0.3);
    assert.equal(m.x.input_tokens, 2);
    assert.deepEqual(m.y, a.x);
  });

  it("applyUpdate preserva model_usage/turn_stats e lê doc antigo sem os campos", () => {
    let doc = makeInitialDoc("261126", "2026-11-26T00:00:00.000Z");
    doc = applyUpdate(doc, { stage: 2, status: "done", cost_usd: 1 }, "2026-11-26T01:00:00.000Z");
    const legacyRow = doc.rows.find((r) => r.stage === 2)!;
    assert.equal(legacyRow.model_usage, undefined);
    assert.equal(legacyRow.cost_usd, 1);

    const mu = parseCliJsonUsage(TWO_MODEL_ENVELOPE)!.modelUsage!;
    doc = applyUpdate(doc, { stage: 2, status: "done", model_usage: mu }, "2026-11-26T01:01:00.000Z");
    // Update posterior sem o campo não apaga.
    doc = applyUpdate(doc, { stage: 2, status: "done", cost_usd: 2 }, "2026-11-26T01:02:00.000Z");
    const row = doc.rows.find((r) => r.stage === 2)!;
    assert.deepEqual(row.model_usage, mu);
    assert.equal(row.cost_usd, 2);
  });
});

function entry(o: Partial<UsageEntry>): UsageEntry {
  return {
    timestamp: "2026-11-26T10:00:00.000Z",
    model: "claude-opus-5-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    sessionFile: "/t/s.jsonl",
    isSidechain: false,
    ...o,
  };
}

describe("#14115 item 2 — turn_stats do transcript", () => {
  it("conta turnos do thread principal, contexto do 1º turno, mediana, máximo e cache", () => {
    const stats = summarizeTurnStats([
      // fora de ordem de propósito: o 1º turno é o de menor timestamp
      entry({ timestamp: "2026-11-26T10:02:00.000Z", inputTokens: 5, cacheReadInputTokens: 30000, cacheCreationInputTokens: 1000 }),
      entry({ timestamp: "2026-11-26T10:00:00.000Z", inputTokens: 3, cacheCreationInputTokens: 25000 }),
      entry({ timestamp: "2026-11-26T10:01:00.000Z", inputTokens: 2, cacheReadInputTokens: 25000, cacheCreationInputTokens: 3000 }),
      entry({ timestamp: "2026-11-26T10:01:30.000Z", isSidechain: true, model: "claude-sonnet-5-5", inputTokens: 1, cacheReadInputTokens: 9000 }),
    ]);
    assert.deepEqual(stats, {
      num_turns: 3,
      subagent_turns: 1,
      context_first: 25003,
      context_median: 28002,
      context_max: 31005,
      cache_read_tokens: 64000,
      cache_creation_tokens: 29000,
      uncached_input_tokens: 11,
    });
  });

  it("sem turno principal: contextos null, nunca zero", () => {
    const stats = summarizeTurnStats([entry({ isSidechain: true, inputTokens: 1 })]);
    assert.equal(stats.num_turns, 0);
    assert.equal(stats.context_first, null);
    assert.equal(stats.context_median, null);
    assert.equal(stats.context_max, null);
  });

  it("captureUsageForWindow devolve model_usage (opus + sonnet) e turn_stats de um transcript real-like", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-breakdown-14115-"));
    try {
      const line = (ts: string, model: string, id: string, u: Record<string, number>, side = false) =>
        JSON.stringify({ type: "assistant", timestamp: ts, isSidechain: side, message: { id, model, usage: u } });
      writeFileSync(
        join(dir, "sess.jsonl"),
        [
          line("2026-11-26T10:00:00.000Z", "claude-opus-5-5", "m1", { input_tokens: 10, cache_creation_input_tokens: 20000, output_tokens: 100 }),
          // mesma resposta em 2 linhas (bloco de texto + tool_use): conta 1 turno (#10481)
          line("2026-11-26T10:00:05.000Z", "claude-opus-5-5", "m2", { input_tokens: 5, cache_read_input_tokens: 20000, output_tokens: 50 }),
          line("2026-11-26T10:00:05.000Z", "claude-opus-5-5", "m2", { input_tokens: 5, cache_read_input_tokens: 20000, output_tokens: 50 }),
          line("2026-11-26T10:00:09.000Z", "claude-sonnet-5-5", "m3", { input_tokens: 1, cache_read_input_tokens: 5000, output_tokens: 10 }, true),
        ].join("\n"),
        "utf8",
      );
      const r = captureUsageForWindow(dir, "2026-11-26T09:59:00.000Z", "2026-11-26T10:01:00.000Z", "261126", { sessionId: "sess" });
      assert.equal(r.source, "session_transcript");
      assert.deepEqual(Object.keys(r.model_usage ?? {}).sort(), ["opus-5-5", "sonnet-5-5"]);
      assert.equal(r.model_usage?.["opus-5-5"].cache_read_input_tokens, 20000);
      assert.equal(r.model_usage?.["sonnet-5-5"].output_tokens, 10);
      // soma dos custos por modelo fecha com o total
      const sum = Object.values(r.model_usage!).reduce((a, m) => a + (m.cost_usd ?? 0), 0);
      assert.ok(Math.abs(sum - (r.cost_usd ?? 0)) < 1e-5, `${sum} vs ${r.cost_usd}`);
      assert.equal(r.turn_stats?.num_turns, 2);
      assert.equal(r.turn_stats?.subagent_turns, 1);
      assert.equal(r.turn_stats?.context_first, 20010);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
