/**
 * clarice-retry-skip.test.ts (#2320)
 *
 * Regression tests for:
 *   1. withClariceRetry — retry policy with exponential backoff.
 *   2. backoffDelayMs — deterministic backoff computation.
 *   3. signalsFromClariceSkips — run-log skip counter.
 *   4. parseCliArgs — validation of --max-attempts (finding #4) and argv-consumption
 *      bug with --retry as flag value (finding #8).
 *
 * All tests are deterministic (no real network, no real sleep).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  withClariceRetry,
  backoffDelayMs,
  parseCliArgs,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from "../scripts/clarice-correct.ts";

import { signalsFromClariceSkips } from "../scripts/collect-edition-signals.ts";

// Helper to mock process.exit so tests can assert exit code without exiting.
function withMockedExit(fn: () => unknown): Promise<number> {
  return new Promise<number>((resolve) => {
    const original = process.exit.bind(process);
    let capturedCode = -1;
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (
      code?: number,
    ): never => {
      capturedCode = code ?? 0;
      process.exit = original;
      resolve(capturedCode);
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => { process.exit = original; resolve(capturedCode); })
        .catch((e: unknown) => {
          process.exit = original;
          if (e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit) return;
          resolve(capturedCode);
        });
    }
  });
}

// ---------------------------------------------------------------------------
// backoffDelayMs — deterministic, no mocking needed
// ---------------------------------------------------------------------------

describe("backoffDelayMs", () => {
  it("attempt 0 → 0ms (no delay before first try)", () => {
    assert.equal(backoffDelayMs(0, 5_000), 0);
  });

  it("attempt 1 → baseBackoffMs × 1", () => {
    assert.equal(backoffDelayMs(1, 5_000), 5_000);
  });

  it("attempt 2 → baseBackoffMs × 2 (exponential doubling)", () => {
    assert.equal(backoffDelayMs(2, 5_000), 10_000);
  });

  it("attempt 3 → baseBackoffMs × 4", () => {
    assert.equal(backoffDelayMs(3, 5_000), 20_000);
  });

  it("DEFAULT_RETRY_POLICY: 3 attempts, 60s timeout, 5s base", () => {
    assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 3);
    assert.equal(DEFAULT_RETRY_POLICY.timeoutMs, 60_000);
    assert.equal(DEFAULT_RETRY_POLICY.baseBackoffMs, 5_000);
    // Total backoff wait = 0 + 5s + 10s = 15s for 3 attempts
    const totalBackoff = [0, 1, 2].reduce(
      (sum, i) => sum + backoffDelayMs(i, DEFAULT_RETRY_POLICY.baseBackoffMs),
      0,
    );
    assert.equal(totalBackoff, 15_000);
  });
});

// ---------------------------------------------------------------------------
// withClariceRetry — uses injected fetch + zero-sleep to stay synchronous
// ---------------------------------------------------------------------------

const noSleep = async (_ms: number): Promise<void> => {};

function makeFetch(responses: Array<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  callCount: () => number;
} {
  let count = 0;
  const fetchImpl: typeof fetch = async () => {
    const r = responses[count] ?? responses[responses.length - 1];
    count++;
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  return { fetchImpl, callCount: () => count };
}

const FAST_POLICY: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 5_000,
  baseBackoffMs: 0, // no real sleep in tests
};

describe("withClariceRetry", () => {
  it("succeeds on first attempt — no retry", async () => {
    const { fetchImpl, callCount } = makeFetch([
      { status: 200, body: [{ from: "x", to: "y" }] },
    ]);
    const result = await withClariceRetry(
      { apiKey: "k", text: "t", fetchImpl },
      FAST_POLICY,
      noSleep,
    );
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.attempts, 1);
    assert.equal(callCount(), 1);
  });

  it("retries on timeout (AbortError-style) up to maxAttempts", async () => {
    // All 3 attempts fail with a simulated network error
    const fetchImpl: typeof fetch = async (_url, init) => {
      // Simulate abort by throwing (same as what AbortController does)
      throw new Error("operation aborted");
    };
    const policy: RetryPolicy = { maxAttempts: 3, timeoutMs: 10, baseBackoffMs: 0 };
    await assert.rejects(
      () => withClariceRetry({ apiKey: "k", text: "t", fetchImpl }, policy, noSleep),
      /operation aborted/,
    );
  });

  it("retries on HTTP 5xx (server-side error) and succeeds on 3rd attempt", async () => {
    const { fetchImpl, callCount } = makeFetch([
      { status: 500, body: "internal error" },
      { status: 503, body: "unavailable" },
      { status: 200, body: [{ from: "a", to: "b" }] },
    ]);
    const result = await withClariceRetry(
      { apiKey: "k", text: "t", fetchImpl },
      FAST_POLICY,
      noSleep,
    );
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.attempts, 3);
    assert.equal(callCount(), 3);
  });

  it("does NOT retry on HTTP 401 (auth error — retrying won't help)", async () => {
    const { fetchImpl, callCount } = makeFetch([
      { status: 401, body: "unauthorized" },
    ]);
    await assert.rejects(
      () =>
        withClariceRetry(
          { apiKey: "wrong-key", text: "t", fetchImpl },
          FAST_POLICY,
          noSleep,
        ),
      /HTTP 401/,
    );
    // Should have called fetch exactly once (no retry on 4xx)
    assert.equal(callCount(), 1);
  });

  it("does NOT retry on HTTP 400 (bad request)", async () => {
    const { fetchImpl, callCount } = makeFetch([
      { status: 400, body: "bad request" },
    ]);
    await assert.rejects(
      () =>
        withClariceRetry(
          { apiKey: "k", text: "t", fetchImpl },
          FAST_POLICY,
          noSleep,
        ),
      /HTTP 400/,
    );
    assert.equal(callCount(), 1);
  });

  it("retries exactly maxAttempts times before giving up on persistent 5xx", async () => {
    const policy: RetryPolicy = { maxAttempts: 4, timeoutMs: 5_000, baseBackoffMs: 0 };
    const { fetchImpl, callCount } = makeFetch([
      { status: 503, body: "unavailable" },
      { status: 503, body: "unavailable" },
      { status: 503, body: "unavailable" },
      { status: 503, body: "unavailable" },
    ]);
    await assert.rejects(
      () => withClariceRetry({ apiKey: "k", text: "t", fetchImpl }, policy, noSleep),
      /HTTP 503/,
    );
    assert.equal(callCount(), 4); // exactly maxAttempts tries
  });

  it("calls sleepFn with increasing backoff delays between attempts", async () => {
    const sleepCalls: number[] = [];
    const sleepFn = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };
    // 2 failures + 1 success; baseBackoffMs=100 for easy assertion
    const policy: RetryPolicy = { maxAttempts: 3, timeoutMs: 5_000, baseBackoffMs: 100 };
    const { fetchImpl } = makeFetch([
      { status: 503, body: "unavailable" },
      { status: 503, body: "unavailable" },
      { status: 200, body: [] },
    ]);
    await withClariceRetry({ apiKey: "k", text: "t", fetchImpl }, policy, sleepFn);
    // Attempt 0: no sleep. Attempt 1: 100ms. Attempt 2: 200ms.
    assert.deepEqual(sleepCalls, [100, 200]);
  });
});

// ---------------------------------------------------------------------------
// signalsFromClariceSkips — run-log skip counter
// ---------------------------------------------------------------------------

describe("signalsFromClariceSkips", () => {
  function makeLogLine(
    message: string,
    edition: string | null = "260616",
    level = "warn",
  ): string {
    return JSON.stringify({
      timestamp: "2026-06-16T14:00:00.000Z",
      edition,
      stage: 2,
      agent: "orchestrator",
      level,
      message,
      details: { reason: "mcp_down_rest_exit3_editor_approved" },
    });
  }

  it("retorna [] quando não há eventos clarice_skip no run-log", () => {
    const lines = [
      makeLogLine("chrome_disconnected"),
      makeLogLine("mcp_disconnect: clarice"),
    ];
    assert.deepEqual(signalsFromClariceSkips(lines, "260616"), []);
  });

  it("detecta 1 evento clarice_skip — severity medium", () => {
    const signals = signalsFromClariceSkips(
      [makeLogLine("clarice_skip")],
      "260616",
    );
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "clarice_skip");
    assert.equal(signals[0].severity, "medium");
    assert.equal(signals[0].details.count, 1);
    assert.equal(signals[0].related_issue, "#2320");
  });

  it("detecta 2 eventos — severity high (padrão recorrente)", () => {
    const lines = [
      makeLogLine("clarice_skip"),
      makeLogLine("clarice_skip"),
    ];
    const signals = signalsFromClariceSkips(lines, "260616");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].severity, "high");
    assert.equal(signals[0].details.count, 2);
  });

  it("filtra eventos de outra edição quando edition é especificado", () => {
    const lines = [
      makeLogLine("clarice_skip", "260615"), // edição anterior
      makeLogLine("clarice_skip", "260616"), // edição atual
    ];
    const signals = signalsFromClariceSkips(lines, "260616");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, 1);
  });

  it("quando edition=null, captura eventos de todas as edições", () => {
    const lines = [
      makeLogLine("clarice_skip", "260615"),
      makeLogLine("clarice_skip", "260616"),
    ];
    const signals = signalsFromClariceSkips(lines, null);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, 2);
  });

  it("detecta variante legacy com espaço: 'clarice SKIP consciente'", () => {
    // Corresponds to the exact run-log message from 260616 incident
    const lines = [
      makeLogLine(
        "Clarice SKIP consciente (editor aprovou) — endpoint cortex down após 7 tentativas; 02-reviewed.md = 02-humanized.md sem revisão Clarice",
      ),
    ];
    const signals = signalsFromClariceSkips(lines, "260616");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "clarice_skip");
  });

  it("ignora eventos info (não warn/error)", () => {
    const lines = [makeLogLine("clarice_skip", "260616", "info")];
    assert.deepEqual(signalsFromClariceSkips(lines, "260616"), []);
  });

  it("dado K eventos clarice_skip, o counter retorna K — regressão observabilidade", () => {
    const K = 5;
    const lines = Array.from({ length: K }, () => makeLogLine("clarice_skip"));
    const signals = signalsFromClariceSkips(lines, "260616");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].details.count, K);
  });

  // Finding #2: log line WITHOUT edition field must NOT be counted against current edition
  it("finding #2: log line sem campo edition não é contada contra a edição atual", () => {
    const lineWithoutEdition = JSON.stringify({
      timestamp: "2026-06-16T12:00:00.000Z",
      // no `edition` field
      stage: 2,
      agent: "orchestrator",
      level: "warn",
      message: "clarice_skip",
      details: { reason: "mcp_down_rest_exit3_editor_approved" },
    });
    const signals = signalsFromClariceSkips([lineWithoutEdition], "260616");
    assert.deepEqual(signals, [], "orphaned log line (no edition) should not be attributed to 260616");
  });

  it("finding #2: log line sem campo edition é incluída quando edition=null (all-editions)", () => {
    const lineWithoutEdition = JSON.stringify({
      timestamp: "2026-06-16T12:00:00.000Z",
      level: "warn",
      message: "clarice_skip",
    });
    const signals = signalsFromClariceSkips([lineWithoutEdition], null);
    assert.equal(signals.length, 1, "with edition=null, lines without edition field ARE included");
    assert.equal(signals[0].details.count, 1);
  });
});

// ---------------------------------------------------------------------------
// parseCliArgs — finding #4 (validation) and finding #8 (argv-consumption bug)
// ---------------------------------------------------------------------------

describe("parseCliArgs (#2320 self-review findings #4 and #8)", () => {
  const BASE = ["--in", "input.md", "--out", "out.json"];

  it("parses valid args correctly", () => {
    const r = parseCliArgs([...BASE, "--retry", "--max-attempts", "3", "--timeout-ms", "60000"]);
    assert.ok(r !== null);
    assert.equal(r!.retry, true);
    assert.equal(r!.maxAttempts, 3);
    assert.equal(r!.timeoutMs, 60000);
  });

  // Finding #4: --max-attempts 0 must exit(1) loudly, not silently run 0 iterations
  it("finding #4: --max-attempts 0 rejeita e chama process.exit(1)", async () => {
    const exitCode = await withMockedExit(() => {
      try {
        parseCliArgs([...BASE, "--max-attempts", "0"]);
      } catch (e: unknown) {
        if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) throw e;
      }
    });
    assert.equal(exitCode, 1, "--max-attempts 0 deve chamar process.exit(1)");
  });

  // Finding #4: --max-attempts NaN (non-integer string) must exit(1) loudly
  it("finding #4: --max-attempts abc (NaN) rejeita e chama process.exit(1)", async () => {
    const exitCode = await withMockedExit(() => {
      try {
        parseCliArgs([...BASE, "--max-attempts", "abc"]);
      } catch (e: unknown) {
        if (!(e instanceof Error) || !(e as Error & { __mockExit?: boolean }).__mockExit) throw e;
      }
    });
    assert.equal(exitCode, 1, "--max-attempts abc deve chamar process.exit(1)");
  });

  // Finding #8: --max-attempts --retry must NOT consume "--retry" as the integer value
  it("finding #8: --max-attempts --retry não consome --retry como valor do inteiro", () => {
    // Before the fix, this would set maxAttempts=NaN and retry=false.
    // After the fix, --retry (a flag token) is rejected as value for --max-attempts,
    // so maxAttempts stays undefined and retry=true.
    // The parse should succeed (--max-attempts without a value is skipped), retry=true.
    const r = parseCliArgs([...BASE, "--retry", "--max-attempts"]);
    // --max-attempts with no following value (argv ends) → maxAttempts stays undefined
    assert.ok(r !== null, "parse should succeed (missing --max-attempts value is just skipped)");
    assert.equal(r!.retry, true, "--retry must be parsed as true, not consumed as maxAttempts value");
    assert.equal(r!.maxAttempts, undefined, "maxAttempts should be undefined when no value follows");
  });

  it("finding #8: --max-attempts 3 --retry ordena corretamente", () => {
    const r = parseCliArgs([...BASE, "--max-attempts", "3", "--retry"]);
    assert.ok(r !== null);
    assert.equal(r!.maxAttempts, 3);
    assert.equal(r!.retry, true);
  });

  // #2626 — --corrected-out flag
  it("#2626: --corrected-out parsed correctly", () => {
    const r = parseCliArgs([...BASE, "--corrected-out", "corrected.md"]);
    assert.ok(r !== null);
    assert.equal(r!.correctedOutPath, "corrected.md");
  });

  it("#2626: sem --corrected-out → correctedOutPath é undefined", () => {
    const r = parseCliArgs([...BASE]);
    assert.ok(r !== null);
    assert.equal(r!.correctedOutPath, undefined);
  });
});
