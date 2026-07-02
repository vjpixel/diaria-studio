/**
 * clarice-2798-observability.test.ts (#2798)
 *
 * Regression tests for the "cortex endpoint timeout" recurrence:
 *   - #2320 (260616) already fixed retry/backoff, but the issue reappeared
 *     in #2798 (260702) on secondary sections >5k chars.
 *   - This PR adds per-attempt observability (`onAttempt` callback → CLI wires
 *     it to `data/run-log.jsonl` via `scripts/lib/run-log.ts`) so future
 *     recurrences can be diagnosed (elapsed time, payload size, outcome) per
 *     attempt instead of just the final skip.
 *
 * Coverage (per #633 bugfix regression requirement):
 *   1. Library level (`withClariceRetry`): timeout on first 2 attempts,
 *      success on 3rd → retry works AND onAttempt logs each attempt with the
 *      right outcome/attempt number.
 *   2. Library level: 4xx → fast-fail, onAttempt logs a single "fatal_failure"
 *      attempt (never retried).
 *   3. Library level: timeout on ALL attempts → withClariceRetry rejects with
 *      a normal, catchable Error (never crashes the process) and onAttempt
 *      logs every attempt as "retryable_failure" — this is exactly the
 *      condition the CLI (`main`) turns into `process.exit(3)`, which the
 *      orchestrator then turns into the graceful "clarice_skip" fallback
 *      (never a pipeline crash).
 *   4. CLI end-to-end: `main()` with `--retry --max-attempts 1 --edition ...`
 *      against an always-failing mocked global fetch → exits gracefully with
 *      code 3 (not an uncaught crash) AND writes the expected
 *      `clarice_rest_attempt` event to `data/run-log.jsonl` in the temp cwd,
 *      proving the CLI wiring (not just the library function) logs attempts.
 *
 * All tests are deterministic — no real network, no real sleep (noSleep /
 * FAST_POLICY), and CLI test runs in an isolated temp cwd so it never touches
 * the real repo's data/run-log.jsonl.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  withClariceRetry,
  main,
  type AttemptLogEntry,
  type RetryPolicy,
} from "../scripts/clarice-correct.ts";

const noSleep = async (_ms: number): Promise<void> => {};

function makeFetch(responses: Array<{ status?: number; body?: unknown; throws?: string }>): {
  fetchImpl: typeof fetch;
  callCount: () => number;
} {
  let count = 0;
  const fetchImpl: typeof fetch = async () => {
    const r = responses[count] ?? responses[responses.length - 1];
    count++;
    if (r.throws) throw new Error(r.throws);
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? []),
      { status: r.status ?? 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetchImpl, callCount: () => count };
}

const FAST_POLICY: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 5_000,
  baseBackoffMs: 0, // sem sleep real nos testes
};

// ---------------------------------------------------------------------------
// 1. Timeout nas 2 primeiras tentativas, sucesso na 3ª
// ---------------------------------------------------------------------------

describe("#2798 — onAttempt observability: retry após timeout + sucesso", () => {
  it("2 timeouts + sucesso na 3ª tentativa → retry funciona E cada tentativa é logada", async () => {
    const { fetchImpl } = makeFetch([
      { throws: "operation timed out" },
      { throws: "operation timed out" },
      { status: 200, body: [{ from: "a", to: "b" }] },
    ]);
    const attempts: AttemptLogEntry[] = [];
    const result = await withClariceRetry(
      { apiKey: "k", text: "texto de teste", fetchImpl, onAttempt: (e) => attempts.push(e) },
      FAST_POLICY,
      noSleep,
    );

    // Retry funciona: sucesso na 3ª tentativa.
    assert.equal(result.attempts, 3);
    assert.equal(result.suggestions.length, 1);

    // Observabilidade: 3 entradas logadas, uma por tentativa, na ordem certa.
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].attempt, 1);
    assert.equal(attempts[0].outcome, "retryable_failure");
    assert.equal(attempts[0].errorMessage, "operation timed out");
    assert.equal(attempts[1].attempt, 2);
    assert.equal(attempts[1].outcome, "retryable_failure");
    assert.equal(attempts[2].attempt, 3);
    assert.equal(attempts[2].outcome, "success");
    assert.equal(attempts[2].suggestionsCount, 1);

    // Cada entrada carrega elapsed/payload pra diagnosticar payloads grandes (#2798).
    for (const a of attempts) {
      assert.equal(a.maxAttempts, 3);
      assert.equal(typeof a.elapsedMs, "number");
      assert.ok(a.elapsedMs >= 0);
      assert.equal(a.payloadBytes, Buffer.byteLength("texto de teste", "utf8"));
    }
  });

  it("sem onAttempt (default) → nenhum efeito colateral, retry continua funcionando", async () => {
    const { fetchImpl } = makeFetch([
      { throws: "timeout" },
      { status: 200, body: [] },
    ]);
    // Não passar onAttempt não deve quebrar nada (callback é opcional).
    const result = await withClariceRetry({ apiKey: "k", text: "t", fetchImpl }, FAST_POLICY, noSleep);
    assert.equal(result.attempts, 2);
  });
});

// ---------------------------------------------------------------------------
// 2. 4xx → fast-fail, log como fatal_failure (nunca retry)
// ---------------------------------------------------------------------------

describe("#2798 — onAttempt observability: 4xx é fatal_failure sem retry", () => {
  it("HTTP 401 → 1 tentativa logada como fatal_failure, sem retry", async () => {
    const { fetchImpl, callCount } = makeFetch([{ status: 401, body: "unauthorized" }]);
    const attempts: AttemptLogEntry[] = [];
    await assert.rejects(
      () =>
        withClariceRetry(
          { apiKey: "k", text: "t", fetchImpl, onAttempt: (e) => attempts.push(e) },
          FAST_POLICY,
          noSleep,
        ),
      /HTTP 401/,
    );
    assert.equal(callCount(), 1, "4xx não deve reintentar a chamada de rede");
    assert.equal(attempts.length, 1, "4xx deve logar exatamente 1 tentativa (fast-fail)");
    assert.equal(attempts[0].outcome, "fatal_failure");
    assert.equal(attempts[0].status, 401);
  });
});

// ---------------------------------------------------------------------------
// 3. Timeout em TODAS as tentativas → skip gracioso (nunca crash)
// ---------------------------------------------------------------------------

describe("#2798 — timeout em todas as tentativas: skip gracioso, nunca crash", () => {
  it("todas as tentativas esgotadas por timeout → rejeita com Error normal (catchable) e loga cada tentativa como retryable_failure", async () => {
    const { fetchImpl, callCount } = makeFetch([
      { throws: "operation timed out" },
      { throws: "operation timed out" },
      { throws: "operation timed out" },
    ]);
    const attempts: AttemptLogEntry[] = [];

    // A promise rejeita normalmente — não há crash do processo, exceção não
    // tratada, nem swallow silencioso. O caller (CLI main / orchestrator)
    // decide o fallback (exit 3 → skip consciente), preservando o
    // comportamento atual de SKIP como último recurso.
    let caught: Error | undefined;
    try {
      await withClariceRetry(
        { apiKey: "k", text: "t", fetchImpl, onAttempt: (e) => attempts.push(e) },
        FAST_POLICY,
        noSleep,
      );
    } catch (e) {
      caught = e as Error;
    }

    assert.ok(caught instanceof Error, "deve rejeitar com um Error normal, não crashar");
    assert.match(caught!.message, /operation timed out/);
    assert.equal(callCount(), 3, "exatamente maxAttempts tentativas de rede");
    assert.equal(attempts.length, 3, "todas as 3 tentativas devem ser logadas");
    for (const a of attempts) {
      assert.equal(a.outcome, "retryable_failure");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. CLI end-to-end: main() com --retry --edition → exit(3) gracioso + log real
// ---------------------------------------------------------------------------

// Same pattern as test/clarice-retry-skip.test.ts's withMockedExit helper —
// duplicated locally to keep this file self-contained (helper isn't exported).
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

describe("#2798 — CLI end-to-end: main() loga tentativas e sai gracioso em exit(3)", () => {
  it("--retry --max-attempts 1 com fetch sempre falhando → exit(3) (nunca crash) + clarice_rest_attempt no run-log", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "clarice-2798-"));
    const inPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.json");
    writeFileSync(inPath, "texto de teste do stage 2");

    const originalFetch = globalThis.fetch;
    const originalCwd = process.cwd();
    const originalArgv = process.argv;
    const originalApiKey = process.env.CLARICE_API_KEY;

    globalThis.fetch = (async () => {
      throw new Error("cortex REST unreachable (mock)");
    }) as typeof fetch;
    process.env.CLARICE_API_KEY = "test-key";
    process.chdir(tmpDir);
    process.argv = [
      "node",
      "clarice-correct.ts",
      "--in", inPath,
      "--out", outPath,
      "--retry",
      "--max-attempts", "1",
      "--edition", "999999",
      "--agent", "test-clarice-correct",
    ];

    try {
      const exitCode = await withMockedExit(() => main());
      assert.equal(exitCode, 3, "todas as tentativas esgotadas deve sair com exit(3) — nunca crashar o stage");

      const logPath = join(tmpDir, "data", "run-log.jsonl");
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const attemptEvents = events.filter((e) => e.message === "clarice_rest_attempt");

      assert.equal(attemptEvents.length, 1, "1 tentativa logada (--max-attempts 1)");
      const details = attemptEvents[0].details as AttemptLogEntry;
      assert.equal(details.outcome, "retryable_failure");
      assert.equal(details.attempt, 1);
      assert.equal(attemptEvents[0].edition, "999999");
      assert.equal(attemptEvents[0].agent, "test-clarice-correct");
      assert.equal(attemptEvents[0].level, "warn");
    } finally {
      globalThis.fetch = originalFetch;
      process.chdir(originalCwd);
      process.argv = originalArgv;
      if (originalApiKey === undefined) delete process.env.CLARICE_API_KEY;
      else process.env.CLARICE_API_KEY = originalApiKey;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
