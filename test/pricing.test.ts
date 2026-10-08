import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePricing,
  estimateCallCostUsd,
  estimateAggregateCostUsd,
  editionDateMs,
  shortModelName,
  OPUS_PRICING,
  OPUS_5_5_PRICING,
  SONNET_PRICING,
  HAIKU_PRICING,
} from "../scripts/lib/pricing.ts";

describe("resolvePricing", () => {
  it("resolve opus por substring, case-insensitive", () => {
    assert.deepEqual(resolvePricing("claude-Opus-4-8", null), OPUS_PRICING);
  });

  // #4042: Opus 5 tem o MESMO preço do 4.8 ($5/$25 por MTok), então o tier
  // resolvido tem que ser o mesmo objeto. Trava o ID sem sufixo de data
  // (`claude-opus-5`), que é a forma canônica — não `claude-opus-5-AAAAMMDD`.
  it("resolve opus 5 no mesmo tier do 4.8 (custo idêntico)", () => {
    assert.deepEqual(resolvePricing("claude-opus-5", null), OPUS_PRICING);
    assert.deepEqual(
      resolvePricing("claude-opus-5", null),
      resolvePricing("claude-opus-4-8", null),
    );
  });

  it("resolve haiku por substring", () => {
    assert.deepEqual(resolvePricing("claude-haiku-4-5-20251001", null), HAIKU_PRICING);
  });

  // #9003: a virada para $3/$15 em 01/09 foi cancelada — Sonnet é $2/$10 em qualquer data.
  it("resolve sonnet a $2/$10 independente da data (sem virada de 01/09)", () => {
    for (const d of [Date.UTC(2026, 5, 1), Date.UTC(2026, 8, 15), null]) {
      assert.deepEqual(resolvePricing("claude-sonnet-5", d), SONNET_PRICING);
    }
    assert.equal(SONNET_PRICING.inputPer1M, 2);
    assert.equal(SONNET_PRICING.outputPer1M, 10);
  });

  it("sonnet 5.5 tem o mesmo preço do Sonnet 5", () => {
    assert.deepEqual(resolvePricing("claude-sonnet-5-5", null), SONNET_PRICING);
  });

  it("opus 5.5 casa antes do genérico opus: $4/$20, leitura 0,05x", () => {
    assert.deepEqual(resolvePricing("claude-opus-5-5", null), OPUS_5_5_PRICING);
    assert.equal(OPUS_5_5_PRICING.inputPer1M, 4);
    assert.equal(OPUS_5_5_PRICING.outputPer1M, 20);
    assert.equal(OPUS_5_5_PRICING.cacheReadMultiplier, 0.05);
    // opus 5 (sem .5) continua no tier antigo
    assert.deepEqual(resolvePricing("claude-opus-5", null), OPUS_PRICING);
  });

  it("retorna null pra modelo não-Claude (ex: gemini)", () => {
    assert.equal(resolvePricing("gemini-2.5-flash", null), null);
  });

  // #9876: o casamento por substring dava o preço do Haiku 4.5 a qualquer ID
  // com "haiku" — `claude-haiku-5-5` (já presente em transcripts reais) saía
  // a $1/$5 em silêncio. Versão sem preço conferido → null, nunca o tier da família.
  it("versão Claude desconhecida → null, nunca o preço de outra versão da família (#9876)", () => {
    for (const id of [
      "claude-haiku-5-5",
      "claude-haiku-5",
      "claude-sonnet-6",
      "claude-opus-6",
      "claude-opus-4-1",
      "claude-sonnet-4-6",
      "claude-fable-5-1",
    ]) {
      assert.equal(resolvePricing(id, null), null, id);
      assert.equal(estimateCallCostUsd({ input_tokens: 1000, output_tokens: 1000 }, id, null), null, id);
    }
  });

  it("alias sem versão (sonnet/haiku/opus) → null: não diz qual preço (#9876)", () => {
    for (const id of ["sonnet", "haiku", "opus", "claude-sonnet"]) {
      assert.equal(resolvePricing(id, null), null, id);
    }
  });

  it("formas equivalentes de ID conhecido resolvem igual (#9876)", () => {
    assert.deepEqual(resolvePricing("haiku-4-5", null), HAIKU_PRICING);
    assert.deepEqual(resolvePricing("claude-haiku-4-5", null), HAIKU_PRICING);
    assert.deepEqual(resolvePricing("us.anthropic.claude-haiku-4-5-20251001", null), HAIKU_PRICING);
    assert.deepEqual(resolvePricing("claude-opus-5.5", null), OPUS_5_5_PRICING);
    assert.deepEqual(resolvePricing("claude-opus-5-5[1m]", null), OPUS_5_5_PRICING);
    assert.deepEqual(resolvePricing("opus-4-7", null), OPUS_PRICING);
    assert.deepEqual(resolvePricing("sonnet-5", null), SONNET_PRICING);
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

  // #9003: multiplicador de cache por modelo, não global.
  it("custo por modelo: sonnet 5.5, opus 5.5 e opus 5 (cache read/write)", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    // Sonnet 5.5: 2 + 10 + 2*1.25 + 2*0.1 = 14.7
    assert.ok(Math.abs(estimateCallCostUsd(usage, "claude-sonnet-5-5", null)! - 14.7) < 1e-9);
    // Opus 5.5: 4 + 20 + 4*1.25 + 4*0.05 = 29.2
    assert.ok(Math.abs(estimateCallCostUsd(usage, "claude-opus-5-5", null)! - 29.2) < 1e-9);
    // Opus 5: 5 + 25 + 5*1.25 + 5*0.1 = 36.75
    assert.ok(Math.abs(estimateCallCostUsd(usage, "claude-opus-5", null)! - 36.75) < 1e-9);
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

  // #4042: o "-5" final NÃO pode ser confundido com sufixo de data pela regex
  // `-\d{8}$` — o nome curto que aparece nos relatórios de custo é "opus-5".
  it("preserva o sufixo de versão do opus 5 (não é sufixo de data)", () => {
    assert.equal(shortModelName("claude-opus-5"), "opus-5");
  });

  it("preserva string sem prefixo claude-", () => {
    assert.equal(shortModelName("gemini-2.5-flash"), "gemini-2.5-flash");
  });
});
