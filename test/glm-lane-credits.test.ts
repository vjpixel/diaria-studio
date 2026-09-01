import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchOpenRouterCredits } from "../scripts/glm-lane-credits.ts";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as typeof fetch;
}

describe("fetchOpenRouterCredits (#6930)", () => {
  it("apiKey ausente → ok:false, nunca lança, nunca fabrica número", async () => {
    const result = await fetchOpenRouterCredits(undefined);
    assert.equal(result.ok, false);
    assert.match(result.warning ?? "", /ausente/);
    assert.equal(result.totalCreditsUsd, undefined);
  });

  it("resposta 200 com data.total_credits/total_usage numéricos → ok:true", async () => {
    const result = await fetchOpenRouterCredits("fake-key", fakeFetch(200, { data: { total_credits: 100, total_usage: 42.5 } }));
    assert.equal(result.ok, true);
    assert.equal(result.totalCreditsUsd, 100);
    assert.equal(result.totalUsageUsd, 42.5);
    assert.ok(result.timestampIso);
  });

  it("resposta 401 → ok:false, aviso menciona aspas/key (achado do #6930)", async () => {
    const result = await fetchOpenRouterCredits("fake-key", fakeFetch(401, {}));
    assert.equal(result.ok, false);
    assert.match(result.warning ?? "", /401/);
  });

  it("resposta 403 → ok:false", async () => {
    const result = await fetchOpenRouterCredits("fake-key", fakeFetch(403, {}));
    assert.equal(result.ok, false);
  });

  it("resposta 500 → ok:false, sem o hint de 401/403", async () => {
    const result = await fetchOpenRouterCredits("fake-key", fakeFetch(500, {}));
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.warning ?? "", /aspas/);
  });

  it("corpo sem data.total_credits/total_usage numéricos → ok:false", async () => {
    const result = await fetchOpenRouterCredits("fake-key", fakeFetch(200, { data: {} }));
    assert.equal(result.ok, false);
  });

  it("corpo com total_credits como string (não número) → ok:false, nunca aceita tipo errado", async () => {
    const result = await fetchOpenRouterCredits("fake-key", fakeFetch(200, { data: { total_credits: "100", total_usage: 1 } }));
    assert.equal(result.ok, false);
  });

  it("fetch lança (rede indisponível) → ok:false, nunca propaga a exceção", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchOpenRouterCredits("fake-key", throwingFetch);
    assert.equal(result.ok, false);
    assert.match(result.warning ?? "", /ECONNREFUSED/);
  });
});
