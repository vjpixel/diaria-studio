/**
 * #9291 — 429 da Kit API: retry respeitando `Retry-After` (fetch-retry +
 * kit-client) e 429 esgotado em poucos contatos não derrubando a unit
 * (evaluate-brevo-diaria `resolveEvaluateExitCode`). Fetch sempre mockado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, parseRetryAfterMs } from "../scripts/lib/fetch-retry.ts";
import { kitFetch, KitApiError, KIT_RETRY_DEFAULTS } from "../scripts/lib/kit-client.ts";
import {
  resolveEvaluateExitCode,
  isKitRateLimitError,
  KIT_RATE_LIMIT_TOLERATED_MAX,
  PARTIAL_FAILURE_EXIT_CODE,
} from "../scripts/evaluate-brevo-diaria.ts";

const resp = (status: number, headers: Record<string, string> = {}, body = "{}") =>
  new Response(body, { status, headers });

describe("parseRetryAfterMs (#9291)", () => {
  it("segundos, data HTTP, ausente/inválido", () => {
    assert.equal(parseRetryAfterMs("7"), 7000);
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs("abc"), null);
    const now = Date.parse("2026-10-01T00:00:00Z");
    assert.equal(parseRetryAfterMs("Thu, 01 Oct 2026 00:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfterMs("Thu, 01 Oct 2025 00:00:05 GMT", now), 0);
  });
});

describe("fetchWithRetry honorRetryAfter (#9291)", () => {
  it("espera max(backoff, Retry-After) e limita ao teto", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const res = await fetchWithRetry(
      async () => (++n === 1 ? resp(429, { "retry-after": "12" }) : n === 2 ? resp(429, { "retry-after": "999" }) : resp(200)),
      {
        attempts: 3,
        backoffMs: [1000],
        honorRetryAfter: true,
        maxRetryAfterMs: 30_000,
        isRetriableStatus: (s) => s === 429,
        sleep: async (ms) => void sleeps.push(ms),
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(sleeps, [12_000, 30_000]);
  });

  it("sem opt-in, Retry-After é ignorado (comportamento antigo preservado)", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await fetchWithRetry(async () => (++n === 1 ? resp(503, { "retry-after": "50" }) : resp(200)), {
      backoffMs: [1000],
      sleep: async (ms) => void sleeps.push(ms),
    });
    assert.deepEqual(sleeps, [1000]);
  });
});

describe("kitFetch 429 (#9291)", () => {
  it("defaults: 4 tentativas e Retry-After respeitado; recupera após 429s seguidos", async () => {
    assert.equal(KIT_RETRY_DEFAULTS.attempts, 4);
    assert.equal(KIT_RETRY_DEFAULTS.honorRetryAfter, true);
    const orig = globalThis.fetch;
    const sleeps: number[] = [];
    let n = 0;
    globalThis.fetch = (async () => (++n <= 3 ? resp(429, { "retry-after": "4" }) : resp(200, {}, '{"ok":true}'))) as typeof fetch;
    try {
      const out = await kitFetch<{ ok: boolean }>("/subscribers/1", {
        config: { apiKey: "k" } as never,
        retry: { sleep: async (ms) => void sleeps.push(ms) },
      });
      assert.deepEqual(out, { ok: true });
      assert.equal(n, 4);
      assert.deepEqual(sleeps, [4000, 4000, 9000]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("evaluate-brevo-diaria exit code com 429 (#9291)", () => {
  it("isKitRateLimitError: KitApiError 429 direto ou em cause; outros não", () => {
    const e429 = new KitApiError("/x", 429, "Retry later");
    assert.equal(isKitRateLimitError(e429), true);
    assert.equal(isKitRateLimitError(new Error("wrap", { cause: e429 })), true);
    assert.equal(isKitRateLimitError(new KitApiError("/x", 500, "")), false);
    assert.equal(isKitRateLimitError(new Error("Kit API /x -> 429")), false);
  });

  it("caso real do #6786: 12 falhas, todas 429 → exit 0 (não derruba a unit)", () => {
    assert.equal(resolveEvaluateExitCode({ failed: 12, kitAutoConfirmSkipped: 0, kitRateLimited: 12 }), 0);
  });

  it("qualquer falha não-429 junto mantém exit 3 (não mascara)", () => {
    assert.equal(
      resolveEvaluateExitCode({ failed: 13, kitAutoConfirmSkipped: 0, kitRateLimited: 12 }),
      PARTIAL_FAILURE_EXIT_CODE,
    );
    assert.equal(
      resolveEvaluateExitCode({ failed: 1, kitAutoConfirmSkipped: 1, kitRateLimited: 1 }),
      PARTIAL_FAILURE_EXIT_CODE,
    );
  });

  it("429 em massa (acima do teto) mantém exit 3", () => {
    const n = KIT_RATE_LIMIT_TOLERATED_MAX + 1;
    assert.equal(resolveEvaluateExitCode({ failed: n, kitAutoConfirmSkipped: 0, kitRateLimited: n }), PARTIAL_FAILURE_EXIT_CODE);
  });

  it("sem kitRateLimited (callers antigos) o comportamento #8686 é o mesmo", () => {
    assert.equal(resolveEvaluateExitCode({ failed: 1, kitAutoConfirmSkipped: 0 }), PARTIAL_FAILURE_EXIT_CODE);
    assert.equal(resolveEvaluateExitCode({ failed: 0, kitAutoConfirmSkipped: 0 }), 0);
  });
});
