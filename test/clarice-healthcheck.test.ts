import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkClariceHealth } from "../scripts/clarice-healthcheck.ts";

describe("checkClariceHealth", () => {
  it("retorna ok=true em 200 com latency_ms preenchido", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("[]", { status: 200 });
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(typeof result.latency_ms, "number");
    assert.equal(result.error, undefined);
  });

  it("retorna ok=false em 401", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /HTTP 401/);
  });

  it("retorna ok=false em network error (fetch lança)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /ECONNREFUSED/);
  });

  it("respeita timeout — aborta se demora demais", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const result = await checkClariceHealth({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 50,
    });
    assert.equal(result.ok, false);
  });
});
