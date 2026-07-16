import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureUsageForWindow } from "../scripts/capture-stage-usage.ts";
import { makeInitialDoc, applyUpdate, saveDoc, loadDoc } from "../scripts/update-stage-status.ts";

function usageLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-08T08:35:00.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    },
    ...overrides,
  });
}

describe("captureUsageForWindow", () => {
  it("retorna unavailable quando start/end ausentes", () => {
    const result = captureUsageForWindow("/whatever", undefined, undefined, "260508");
    assert.equal(result.source, "unavailable");
    assert.equal(result.reason, "missing_stage_timestamps");
  });

  it("retorna unavailable quando o diretório de transcripts não existe", () => {
    const result = captureUsageForWindow(
      "/does/not/exist",
      "2026-05-08T08:30:00.000Z",
      "2026-05-08T08:48:00.000Z",
      "260508",
    );
    assert.equal(result.source, "unavailable");
    assert.equal(result.reason, "no_local_transcripts_dir");
  });

  it("retorna unavailable quando não há entradas de usage na janela", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-stage-test-"));
    try {
      writeFileSync(join(dir, "session.jsonl"), usageLine({ timestamp: "2026-05-08T05:00:00.000Z" }), "utf8");
      const result = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
      );
      assert.equal(result.source, "unavailable");
      assert.equal(result.reason, "no_usage_records_in_window");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captura tokens + custo reais quando há entradas na janela", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-stage-test-"));
    try {
      writeFileSync(join(dir, "session.jsonl"), usageLine(), "utf8");
      const result = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
      );
      assert.equal(result.source, "session_transcript");
      assert.equal(result.tokens_in, 1_000_000);
      assert.equal(result.tokens_out, 100_000);
      // opus: $5/1M input + $25/1M output = $5 + $2.5 = $7.5
      assert.equal(result.cost_usd, 7.5);
      assert.deepEqual(result.models, ["opus-4-8"]);
      assert.equal(result.cost_partial, false);
      assert.equal(result.entries_matched, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marca cost_partial quando um modelo não é precificável (ex: gemini)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-stage-test-"));
    try {
      writeFileSync(
        join(dir, "session.jsonl"),
        [usageLine(), usageLine({ message: { model: "gemini-2.5-flash", usage: { input_tokens: 500, output_tokens: 50 } } })].join(
          "\n",
        ),
        "utf8",
      );
      const result = captureUsageForWindow(
        dir,
        "2026-05-08T08:30:00.000Z",
        "2026-05-08T08:48:00.000Z",
        "260508",
      );
      assert.equal(result.source, "session_transcript");
      assert.equal(result.cost_partial, true);
      // custo só do opus (gemini não contribui pra $, mas tokens contam)
      assert.equal(result.cost_usd, 7.5);
      assert.equal(result.tokens_in, 1_000_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureUsageForWindow + stage-status.json — integração de escrita", () => {
  it("popula cost_usd/tokens_in/tokens_out/models de uma linha existente sem tocar status/start/end", () => {
    const editionRoot = mkdtempSync(join(tmpdir(), "capture-stage-edition-"));
    try {
      const editionDir = join(editionRoot, "260508");
      mkdirSync(editionDir, { recursive: true });

      let doc = makeInitialDoc("260508", "2026-05-08T08:00:00.000Z");
      doc = applyUpdate(
        doc,
        {
          stage: 1,
          status: "done",
          start: "2026-05-08T08:30:00.000Z",
          end: "2026-05-08T08:48:00.000Z",
        },
        "2026-05-08T08:48:00.000Z",
      );
      saveDoc(editionDir, doc);

      const transcriptsDir = mkdtempSync(join(tmpdir(), "capture-stage-transcripts-"));
      writeFileSync(join(transcriptsDir, "session.jsonl"), usageLine(), "utf8");

      const row = doc.rows.find((r) => r.stage === 1)!;
      const result = captureUsageForWindow(transcriptsDir, row.start, row.end, "260508");
      assert.equal(result.source, "session_transcript");

      // Simula o que main() faz: aplica o resultado de volta ao doc e salva.
      const reloaded = loadDoc(editionDir, "260508");
      const updated = applyUpdate(
        reloaded,
        {
          stage: 1,
          status: "done",
          cost_usd: result.cost_usd,
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          models: result.models,
        },
        "2026-05-08T09:00:00.000Z",
      );
      saveDoc(editionDir, updated);

      const finalDoc = loadDoc(editionDir, "260508");
      const finalRow = finalDoc.rows.find((r) => r.stage === 1)!;
      assert.equal(finalRow.status, "done");
      assert.equal(finalRow.start, "2026-05-08T08:30:00.000Z");
      assert.equal(finalRow.end, "2026-05-08T08:48:00.000Z");
      assert.equal(finalRow.cost_usd, 7.5);
      assert.equal(finalRow.tokens_in, 1_000_000);
      assert.equal(finalRow.tokens_out, 100_000);
      assert.deepEqual(finalRow.models, ["opus-4-8"]);

      // Renderiza a MD e confirma que a linha não fica mais com "-" em custo/tokens.
      const md = readFileSync(join(editionDir, "stage-status.md"), "utf8");
      const line1 = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
      assert.ok(line1.includes("$7.5") || line1.includes("$7.500"));
      assert.ok(!line1.includes("| - | - | - |"));

      rmSync(transcriptsDir, { recursive: true, force: true });
    } finally {
      rmSync(editionRoot, { recursive: true, force: true });
    }
  });
});
