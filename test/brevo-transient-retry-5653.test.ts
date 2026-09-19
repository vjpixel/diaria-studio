import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withBrevoTransient5xxRetry, isBrevoTransient5xx } from "../scripts/lib/brevo-transient-retry.ts";
import { formatBrevoApiError } from "../scripts/lib/brevo-error-classify.ts";

const err = (status: number) => new Error(formatBrevoApiError("POST", "/contacts/import", status, "{}"));

describe("withBrevoTransient5xxRetry (#5653)", () => {
  it("reconhece 5xx do formatBrevoApiError e ignora 4xx", () => {
    assert.equal(isBrevoTransient5xx(err(500)), true);
    assert.equal(isBrevoTransient5xx(err(503)), true);
    assert.equal(isBrevoTransient5xx(err(401)), false);
    assert.equal(isBrevoTransient5xx(new Error("outra coisa")), false);
  });

  it("500 pontual: retenta e devolve o sucesso (regressão 19/09/2026)", async () => {
    let calls = 0;
    const slept: number[] = [];
    const r = await withBrevoTransient5xxRetry(async () => {
      if (++calls === 1) throw err(500);
      return "ok";
    }, { sleep: async (ms) => { slept.push(ms); } });
    assert.equal(r, "ok");
    assert.equal(calls, 2);
    assert.deepEqual(slept, [5000]);
  });

  it("5xx persistente: desiste após esgotar tentativas e propaga o erro", async () => {
    let calls = 0;
    await assert.rejects(
      withBrevoTransient5xxRetry(async () => { calls++; throw err(502); }, { sleep: async () => {} }),
      /502/,
    );
    assert.equal(calls, 3);
  });

  it("4xx não é retentado", async () => {
    let calls = 0;
    await assert.rejects(
      withBrevoTransient5xxRetry(async () => { calls++; throw err(401); }, { sleep: async () => {} }),
    );
    assert.equal(calls, 1);
  });
});
