import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePricing,
  estimateCallCostUsd,
  estimateAggregateCostUsd,
  editionDateMs,
  shortModelName,
  OPUS_PRICING,
  SONNET_PRICING_STANDARD,
  SONNET_PRICING_INTRO,
  HAIKU_PRICING,
} from "../scripts/lib/pricing.ts";

describe("resolvePricing", () => {
  it("resolve opus por substring, case-insensitive", () => {
    assert.deepEqual(resolvePricing("claude-Opus-4-8", null), OPUS_PRICING);
  });

  it("resolve haiku por substring", () => {
    assert.deepEqual(resolvePricing("claude-haiku-4-5-20251001", null), HAIKU_PRICING);
  });

  it("resolve sonnet intro antes do corte 2026-08-31", () => {
    const beforeCutoff = Date.UTC(2026, 5, 1); // June 2026
    assert.deepEqual(resolvePricing("claude-sonnet-5", beforeCutoff), SONNET_PRICING_INTRO);
  });

  it("resolve sonnet standard depois do corte", () => {
    const afterCutoff = Date.UTC(2026, 8, 15); // Sept 2026
    assert.deepEqual(resolvePricing("claude-sonnet-5", afterCutoff), SONNET_PRICING_STANDARD);
  });

  it("resolve sonnet standard quando dateMs é null (sem info de data)", () => {
    assert.deepEqual(resolvePricing("sonnet-4-6", null), SONNET_PRICING_STANDARD);
  });

  it("retorna null pra modelo não-Claude (ex: gemini)", () => {
    assert.equal(resolvePricing("gemini-2.5-flash", null), null);
  });
});

describe("editionDateMs", () => {
  it("parseia AAMMDD válido", () => {
    const ms = editionDateMs("260424");
    assert.ok(ms !== null);
    const d = new Date(ms!);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 3); // April = index 3
    assert.equal(d.getUTCDate(), 24);
  });

  it("retorna null pra formato inválido", () => {
    assert.equal(editionDateMs("not-a-date"), null);
    assert.equal(editionDateMs("2604"), null);
  });
});

describe("estimateCallCostUsd", () => {
  it("computa custo de uma chamada Opus com input/output puro (sem cache)", () => {
    const cost = estimateCallCostUsd(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      "claude-opus-4-8",
      null,
    );
    // $5 input + $25 output = $30
    assert.equal(cost, 30);
  });

  it("aplica multiplicador de cache read (0.1x) e cache write (1.25x)", () => {
    const cost = estimateCallCostUsd(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      },
      "claude-opus-4-8",
      null,
    );
    // cache write: $5 * 1.25 = $6.25; cache read: $5 * 0.1 = $0.5 → total $6.75
    assert.equal(cost, 6.75);
  });

  it("retorna null pra modelo não-Claude — não fabrica custo", () => {
    const cost = estimateCallCostUsd({ input_tokens: 1000, output_tokens: 1000 }, "gemini-2.5", null);
    assert.equal(cost, null);
  });

  it("trata campos ausentes como zero (não lança)", () => {
    const cost = estimateCallCostUsd({}, "claude-haiku-4-5", null);
    assert.equal(cost, 0);
  });
});

describe("estimateAggregateCostUsd", () => {
  it("estima quando exatamente 1 modelo Claude presente", () => {
    const cost = estimateAggregateCostUsd(1_000_000, 100_000, ["haiku-4-5"], null);
    // $1 input + $0.5 output = $1.5
    assert.equal(cost, 1.5);
  });

  it("retorna undefined com 0 modelos", () => {
    assert.equal(estimateAggregateCostUsd(1000, 100, [], null), undefined);
  });

  it("retorna undefined com 2+ modelos (não dá pra atribuir tokens por tier)", () => {
    assert.equal(estimateAggregateCostUsd(1000, 100, ["haiku-4-5", "sonnet-5"], null), undefined);
  });

  it("retorna undefined pra modelo não-Claude", () => {
    assert.equal(estimateAggregateCostUsd(1000, 100, ["gemini"], null), undefined);
  });
});

describe("shortModelName", () => {
  it("remove prefixo claude- e sufixo de data", () => {
    assert.equal(shortModelName("claude-haiku-4-5-20251001"), "haiku-4-5");
  });

  it("remove só o prefixo quando não há sufixo de data", () => {
    assert.equal(shortModelName("claude-opus-4-8"), "opus-4-8");
  });

  it("preserva string sem prefixo claude-", () => {
    assert.equal(shortModelName("gemini-2.5-flash"), "gemini-2.5-flash");
  });
});
