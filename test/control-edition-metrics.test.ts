/**
 * test/control-edition-metrics.test.ts (#5547 item 1)
 *
 * Cobre `scripts/lib/control-edition-metrics.ts` — extrator das 4 métricas
 * por stage (tokens de entrada, turnos, contexto médio por turno,
 * subagent_tokens) para o instrumento de medição da edição de controle
 * (#5419). Regressão principal: `subagent_tokens_in`/`out` NUNCA viram `0`
 * quando indisponíveis — sempre `null` explícito, repassado sem alteração
 * de `stage-status.json` (#5413).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractStageMetrics, buildControlEditionMeasurement } from "../scripts/lib/control-edition-metrics.ts";
import { makeInitialDoc, applyUpdate } from "../scripts/update-stage-status.ts";

function usageLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-14T08:35:00.000Z",
    message: {
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    },
    ...overrides,
  });
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "control-edition-metrics-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("extractStageMetrics", () => {
  it("turns null com motivo quando faltam start/end", () => {
    const row = { stage: 1, status: "done" as const, tokens_in: 500, tokens_out: 20 };
    const m = extractStageMetrics(row, false, "/nope", null);
    assert.equal(m.turns, null);
    assert.equal(m.turns_source, "unavailable");
    assert.equal(m.turns_reason, "missing_stage_timestamps");
    // tokens_in persistido continua repassado mesmo sem turnos derivados
    assert.equal(m.tokens_in, 500);
  });

  it("turns null quando não há diretório de transcripts local", () => {
    const row = {
      stage: 1,
      status: "done" as const,
      start: "2026-08-14T08:00:00.000Z",
      end: "2026-08-14T09:00:00.000Z",
    };
    const m = extractStageMetrics(row, false, "/does/not/exist", null);
    assert.equal(m.turns, null);
    assert.equal(m.turns_reason, "no_local_transcripts_dir");
  });

  it("re-deriva turnos + avg_context_per_turn do transcript local", () => {
    withTmpDir((dir) => {
      writeFileSync(
        join(dir, "sessao.jsonl"),
        [usageLine(), usageLine({ timestamp: "2026-08-14T08:40:00.000Z" })].join("\n"),
        "utf8",
      );
      const row = {
        stage: 2,
        status: "done" as const,
        start: "2026-08-14T08:00:00.000Z",
        end: "2026-08-14T09:00:00.000Z",
        tokens_in: 20_000, // persistido por #5413 — usado como denominador preferencial
      };
      const m = extractStageMetrics(row, true, dir, null);
      assert.equal(m.turns, 2);
      assert.equal(m.turns_source, "session_transcript_rederived");
      assert.equal(m.turns_tokens_in, 20_000); // 2 × 10.000
      assert.equal(m.avg_context_per_turn, 10_000); // 20.000 tokens_in / 2 turnos
      assert.equal(m.token_count_mismatch, false);
    });
  });

  it("sinaliza token_count_mismatch quando tokens_in persistido diverge do re-derivado", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "sessao.jsonl"), usageLine(), "utf8");
      const row = {
        stage: 2,
        status: "done" as const,
        start: "2026-08-14T08:00:00.000Z",
        end: "2026-08-14T09:00:00.000Z",
        tokens_in: 99_999, // divergente do que o transcript realmente tem (10.000)
      };
      const m = extractStageMetrics(row, true, dir, null);
      assert.equal(m.turns, 1);
      assert.equal(m.turns_tokens_in, 10_000);
      assert.equal(m.token_count_mismatch, true);
    });
  });

  it("subagent_tokens_in/out são null explícito, NUNCA 0, quando ausentes do row — regressão #5413", () => {
    const row = { stage: 3, status: "done" as const };
    const m = extractStageMetrics(row, false, "/nope", null);
    assert.equal(m.subagent_tokens_in, null);
    assert.equal(m.subagent_tokens_out, null);
    assert.notEqual(m.subagent_tokens_in, 0);
  });

  it("repassa subagent_tokens_in/out quando presentes no row (mesmo 0 explícito)", () => {
    const row = {
      stage: 3,
      status: "done" as const,
      subagent_tokens_in: 0,
      subagent_tokens_out: 0,
    };
    const m = extractStageMetrics(row, false, "/nope", null);
    assert.equal(m.subagent_tokens_in, 0);
    assert.equal(m.subagent_tokens_out, 0);
  });
});

describe("buildControlEditionMeasurement", () => {
  it("agrega totals somando só os stages com dado presente (nulls não contam como 0)", () => {
    let doc = makeInitialDoc("260814");
    doc = applyUpdate(
      doc,
      { stage: 1, status: "done", tokens_in: 1000, tokens_out: 100, subagent_tokens_in: null, subagent_tokens_out: null },
      "2026-08-14T08:00:00.000Z",
    );
    doc = applyUpdate(
      doc,
      { stage: 2, status: "done", tokens_in: 2000, tokens_out: 200, subagent_tokens_in: 50, subagent_tokens_out: 5 },
      "2026-08-14T09:00:00.000Z",
    );
    const measurement = buildControlEditionMeasurement(doc, "/nope", false, null);
    assert.equal(measurement.totals.tokens_in, 3000);
    assert.equal(measurement.totals.tokens_out, 300);
    // subagent: só stage 2 tem dado real (50) — stage 1 é null, não conta como 0
    assert.equal(measurement.totals.subagent_tokens_in, 50);
  });

  it("totals.subagent_tokens_in é null quando NENHUM stage tem dado — nunca vira 0 fabricado", () => {
    const doc = makeInitialDoc("260814"); // todas rows pending, sem captura
    const measurement = buildControlEditionMeasurement(doc, "/nope", false, null);
    assert.equal(measurement.totals.subagent_tokens_in, null);
    assert.equal(measurement.totals.tokens_in, null);
  });
});
