import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { evaluateCaptureYield } from "../scripts/lib/newsletter-capture-yield.ts";

describe("#9368 — evaluateCaptureYield", () => {
  it("caso 260921: 11 threads, artigos [] → empty", () => {
    const threads = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ thread_id: String(i) })));
    assert.deepEqual(evaluateCaptureYield(threads, "[]"), { threads: 11, articles: 0, empty: true });
  });

  it("artigos ausentes com threads > 0 também é empty", () => {
    assert.equal(evaluateCaptureYield('[{"thread_id":"a"}]', null).empty, true);
  });

  it("artigos ilegíveis com threads > 0 é empty", () => {
    assert.equal(evaluateCaptureYield('[{"thread_id":"a"}]', "{corrompido").empty, true);
  });

  it("sem threads (0 ou ausente) nunca dispara", () => {
    assert.equal(evaluateCaptureYield("[]", "[]").empty, false);
    assert.equal(evaluateCaptureYield(null, null).empty, false);
  });

  it("threads e artigos > 0 não dispara", () => {
    assert.equal(evaluateCaptureYield('[{"thread_id":"a"}]', '[{"url":"https://x.ai"}]').empty, false);
  });
});
