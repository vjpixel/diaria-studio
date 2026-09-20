/**
 * test/cli-usage-json.test.ts (#8560)
 *
 * Cobre `scripts/lib/cli-usage-json.ts` — parsing puro do stdout
 * `claude --print --output-format json`, usado por
 * `scripts/lib/edition-stage-runner.ts` para capturar cost_usd/tokens_in/
 * tokens_out/models sem depender do transcript local (que nunca existe pra
 * um processo spawnado com `--no-session-persistence` — ver docstring do
 * módulo sob teste pro porquê disto substitui a hipótese original da issue).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliJsonUsage, resultTextOrRaw } from "../scripts/lib/cli-usage-json.ts";

describe("parseCliJsonUsage", () => {
  it("extrai cost_usd/tokens_in/tokens_out/models de um resultado real do CLI", () => {
    // Fixture capturada ao vivo (20/09/2026): `claude --print --output-format
    // json --max-turns 1 "reply with just the word: pong"`.
    const raw = JSON.stringify({
      duration_api_ms: 3552,
      stop_reason: "end_turn",
      session_id: "f42a4189-3c99-4a57-b36b-c45d37fb2d02",
      total_cost_usd: 0.2783928,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 68420,
        cache_read_input_tokens: 18544,
        output_tokens: 4,
      },
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 900, outputTokens: 12, costUSD: 0.00096 },
        "claude-sonnet-5": { inputTokens: 2, outputTokens: 4, costUSD: 0.2774328 },
      },
      result: "pong",
      type: "result",
    });

    const usage = parseCliJsonUsage(raw);
    assert.ok(usage);
    assert.equal(usage.costUsd, 0.2783928);
    assert.equal(usage.tokensIn, 2 + 68420 + 18544);
    assert.equal(usage.tokensOut, 4);
    // dedup + short name + sorted — mesma convenção de `shortModelName`
    // (usada nas colunas "Modelos" de stage-status.md).
    assert.deepEqual(usage.models, ["haiku-4-5", "sonnet-5"]);
  });

  it("modelUsage ausente: models vazio, mas cost_usd/tokens ainda extraídos", () => {
    const raw = JSON.stringify({
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const usage = parseCliJsonUsage(raw);
    assert.ok(usage);
    assert.equal(usage.tokensIn, 100);
    assert.equal(usage.tokensOut, 50);
    assert.deepEqual(usage.models, []);
  });

  it("dedup de modelUsage: dois model strings que colapsam no mesmo shortModelName contam 1x", () => {
    const raw = JSON.stringify({
      total_cost_usd: 0.02,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-sonnet-5": {},
        "claude-sonnet-5-20260101": {}, // mesmo shortModelName após strip de sufixo datado
      },
    });
    const usage = parseCliJsonUsage(raw);
    assert.deepEqual(usage?.models, ["sonnet-5"]);
  });

  it("JSON inválido → null (nunca fabrica zero)", () => {
    assert.equal(parseCliJsonUsage("não é json nenhum"), null);
    assert.equal(parseCliJsonUsage(""), null);
    assert.equal(parseCliJsonUsage("{"), null);
  });

  it("JSON válido mas sem total_cost_usd numérico → null", () => {
    assert.equal(parseCliJsonUsage(JSON.stringify({ usage: { input_tokens: 1 } })), null);
    assert.equal(
      parseCliJsonUsage(JSON.stringify({ total_cost_usd: "0.5", usage: { input_tokens: 1 } })),
      null,
      "total_cost_usd como string não conta — precisa ser number",
    );
  });

  it("JSON válido mas sem usage objeto → null", () => {
    assert.equal(parseCliJsonUsage(JSON.stringify({ total_cost_usd: 0.1 })), null);
    assert.equal(parseCliJsonUsage(JSON.stringify({ total_cost_usd: 0.1, usage: null })), null);
  });

  it("array JSON (não objeto) → null", () => {
    assert.equal(parseCliJsonUsage("[1,2,3]"), null);
  });

  it("campos de usage ausentes/não-numéricos contam como 0, não quebram", () => {
    const raw = JSON.stringify({ total_cost_usd: 0.001, usage: { input_tokens: "não numérico" } });
    const usage = parseCliJsonUsage(raw);
    assert.ok(usage);
    assert.equal(usage.tokensIn, 0);
    assert.equal(usage.tokensOut, 0);
  });
});

describe("resultTextOrRaw", () => {
  it("extrai o campo result de um JSON --output-format json válido", () => {
    const raw = JSON.stringify({ result: "texto de resposta final", total_cost_usd: 0.1 });
    assert.equal(resultTextOrRaw(raw), "texto de resposta final");
  });

  it("texto puro (não-JSON, ex: stderr de exceção) volta sem alteração", () => {
    const raw = "Error: something failed\nstack trace here";
    assert.equal(resultTextOrRaw(raw), raw);
  });

  it("JSON válido sem campo result string volta o raw original", () => {
    const raw = JSON.stringify({ total_cost_usd: 0.1, usage: {} });
    assert.equal(resultTextOrRaw(raw), raw);
  });

  it("string vazia volta vazia", () => {
    assert.equal(resultTextOrRaw(""), "");
  });
});
