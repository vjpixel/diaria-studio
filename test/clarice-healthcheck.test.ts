import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkClariceHealth,
  parseHealthcheckArgs,
  DEFAULT_TIMEOUT_MS,
  OBSERVED_PROBE_LATENCY_MS,
} from "../scripts/clarice-healthcheck.ts";

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

  // Regressão: o default era 5s, mas o cortex leva ~16s até no probe de 3 chars.
  // O healthcheck abortava SEMPRE → Stage 0 marcava CLARICE_REST=false com o REST
  // saudável → Stage 2 pulava o fallback e ia direto pro halt banner.
  // Os testes acima passam timeoutMs explícito, então nenhum exercitava o default.
  it("default tolera a latência real do cortex (~16s)", () => {
    assert.ok(
      DEFAULT_TIMEOUT_MS > OBSERVED_PROBE_LATENCY_MS,
      `DEFAULT_TIMEOUT_MS (${DEFAULT_TIMEOUT_MS}ms) precisa folgar sobre a ` +
        `latência observada (${OBSERVED_PROBE_LATENCY_MS}ms) ou o healthcheck ` +
        `reporta ok=false com o REST saudável`,
    );
  });

  it("usa o default quando timeoutMs é omitido — resposta lenta ainda dá ok=true", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((resolve) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve(new Response("[]", { status: 200 })), OBSERVED_PROBE_LATENCY_MS);
      });

    const pending = checkClariceHealth({ apiKey: "k", fetchImpl }); // sem timeoutMs → default
    t.mock.timers.tick(OBSERVED_PROBE_LATENCY_MS);
    const result = await pending;

    assert.equal(aborted, false, "não deve abortar antes do default");
    assert.equal(result.ok, true);
  });
});

describe("parseHealthcheckArgs", () => {
  it("sem flags → timeoutMs undefined (cai no default)", () => {
    assert.deepEqual(parseHealthcheckArgs([]), {});
  });

  it("--timeout-ms N → timeoutMs numérico", () => {
    assert.deepEqual(parseHealthcheckArgs(["--timeout-ms", "45000"]), {
      timeoutMs: 45000,
    });
  });

  it("--timeout-ms inválido → lança", () => {
    assert.throws(() => parseHealthcheckArgs(["--timeout-ms", "0"]), /número positivo/);
    assert.throws(() => parseHealthcheckArgs(["--timeout-ms", "abc"]), /número positivo/);
  });

  it("não consome a flag seguinte como valor", () => {
    assert.deepEqual(parseHealthcheckArgs(["--timeout-ms", "--outra"]), {});
  });
});
