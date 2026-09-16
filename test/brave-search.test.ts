/**
 * test/brave-search.test.ts (#1555)
 *
 * Tests for the Brave Search API wrapper using a mock fetch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { braveSearch, freshnessForWindow, parseRateLimitCsvHeader } from "../scripts/lib/brave-search.ts";

function mockFetch(
  responseFactory: (url: string) => { ok: boolean; status: number; body: unknown; headers?: Record<string, string> },
) {
  return async (url: string | URL) => {
    const { ok, status, body, headers } = responseFactory(url.toString());
    return {
      ok,
      status,
      headers: new Headers(headers ?? {}),
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      json: async () => body,
    } as unknown as Response;
  };
}

describe("braveSearch", () => {
  it("parses valid response and returns results", async () => {
    const fetchFn = mockFetch(() => ({
      ok: true,
      status: 200,
      body: {
        web: {
          results: [
            {
              title: "OpenAI launches GPT-7",
              url: "https://openai.com/blog/gpt-7",
              description: "New flagship model",
              page_age: "2026-05-27T10:00:00Z",
            },
          ],
        },
      },
    }));
    const result = await braveSearch("site:openai.com", {
      apiKey: "fake",
      fetchFn,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].title, "OpenAI launches GPT-7");
  });

  it("returns empty results when web.results is missing", async () => {
    const fetchFn = mockFetch(() => ({
      ok: true,
      status: 200,
      body: { query: { original: "x" } },
    }));
    const result = await braveSearch("x", { apiKey: "fake", fetchFn });
    assert.equal(result.status, "ok");
    assert.equal(result.results.length, 0);
  });

  it("handles 429 rate limit gracefully", async () => {
    const fetchFn = mockFetch(() => ({
      ok: false,
      status: 429,
      body: "Rate limit exceeded",
    }));
    const result = await braveSearch("x", { apiKey: "fake", fetchFn });
    assert.equal(result.status, "rate_limited");
    assert.equal(result.http_status, 429);
    assert.equal(result.results.length, 0);
  });

  it("handles HTTP errors with error_message", async () => {
    const fetchFn = mockFetch(() => ({
      ok: false,
      status: 500,
      body: "Server error",
    }));
    const result = await braveSearch("x", { apiKey: "fake", fetchFn });
    assert.equal(result.status, "error");
    assert.equal(result.http_status, 500);
    assert.match(result.error_message ?? "", /Server error/);
  });

  it("handles network errors (thrown fetch)", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await braveSearch("x", { apiKey: "fake", fetchFn });
    assert.equal(result.status, "error");
    assert.match(result.error_message ?? "", /ECONNREFUSED/);
  });

  it("includes freshness in URL when provided", async () => {
    let capturedUrl = "";
    const fetchFn = mockFetch((url) => {
      capturedUrl = url;
      return { ok: true, status: 200, body: { web: { results: [] } } };
    });
    await braveSearch("x", { apiKey: "k", freshness: "pw", fetchFn });
    assert.match(capturedUrl, /freshness=pw/);
  });

  it("sets X-Subscription-Token header", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ web: { results: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await braveSearch("x", { apiKey: "MY_KEY_123", fetchFn });
    assert.deepEqual(capturedHeaders, {
      "X-Subscription-Token": "MY_KEY_123",
      Accept: "application/json",
    });
  });

  // (#7943) Regressão: X-RateLimit-Remaining/Limit são CSV "<per-second>,
  // <monthly>" — `parseInt` ingênuo lia só o 1º valor (per-second, quase
  // constante) como se fosse o contador mensal. Sem este teste, reintroduzir
  // `parseInt(header, 10)` direto passaria verde (o 1º token de "1, 850" é
  // "1", que também "parseia" sem erro — só é o valor ERRADO).
  it("reads quota_remaining from the MONTHLY (2nd) token of a CSV X-RateLimit-Remaining, not the per-second one", async () => {
    const fetchFn = mockFetch(() => ({
      ok: true,
      status: 200,
      body: { web: { results: [] } },
      headers: { "X-RateLimit-Remaining": "1, 850", "X-RateLimit-Limit": "1, 1000" },
    }));
    const result = await braveSearch("x", { apiKey: "k", fetchFn });
    assert.equal(result.quota_remaining, 850);
    assert.equal(result.quota_limit_monthly, 1000);
  });

  // (#7943, achado ao vivo 260915) Conta Postpaid: a janela mensal reporta
  // limite 0 (sem cap) e remaining também vem 0 — não "0 restantes de um plano
  // esgotado". braveSearch só precisa repassar os dois valores tal como vêm;
  // é `computeBraveCreditStats` (brave-credits.test.ts) quem decide que isso é
  // "sem sinal", não "uso zero" — mas o parsing em si tem que preservar o 0
  // literal, nunca descartá-lo como falsy.
  it("passes through the literal 0/0 sentinel for unlimited (Postpaid) monthly windows", async () => {
    const fetchFn = mockFetch(() => ({
      ok: true,
      status: 200,
      body: { web: { results: [] } },
      headers: { "X-RateLimit-Remaining": "49, 0", "X-RateLimit-Limit": "50, 0" },
    }));
    const result = await braveSearch("x", { apiKey: "k", fetchFn });
    assert.equal(result.quota_remaining, 0);
    assert.equal(result.quota_limit_monthly, 0);
  });

  it("returns undefined (never the wrong window) when the header has no comma", async () => {
    const fetchFn = mockFetch(() => ({
      ok: true,
      status: 200,
      body: { web: { results: [] } },
      headers: { "X-RateLimit-Remaining": "1847" },
    }));
    const result = await braveSearch("x", { apiKey: "k", fetchFn });
    // windowIndex=1 (monthly) sobre um único token → ausente, não o valor errado
    assert.equal(result.quota_remaining, undefined);
  });

  it("leaves quota_remaining/quota_limit_monthly undefined when headers are absent", async () => {
    const fetchFn = mockFetch(() => ({ ok: true, status: 200, body: { web: { results: [] } } }));
    const result = await braveSearch("x", { apiKey: "k", fetchFn });
    assert.equal(result.quota_remaining, undefined);
    assert.equal(result.quota_limit_monthly, undefined);
  });
});

describe("parseRateLimitCsvHeader", () => {
  it("returns the value at the requested window index", () => {
    assert.equal(parseRateLimitCsvHeader("1, 850", 0), 1);
    assert.equal(parseRateLimitCsvHeader("1, 850", 1), 850);
  });

  it("returns undefined for a missing index (single-value header, monthly requested)", () => {
    assert.equal(parseRateLimitCsvHeader("1847", 1), undefined);
    assert.equal(parseRateLimitCsvHeader("1847", 0), 1847);
  });

  it("returns undefined for garbage input", () => {
    assert.equal(parseRateLimitCsvHeader("", 0), undefined);
    assert.equal(parseRateLimitCsvHeader("not-a-number", 0), undefined);
  });

  it("preserves a literal 0", () => {
    assert.equal(parseRateLimitCsvHeader("49, 0", 1), 0);
  });
});

describe("freshnessForWindow", () => {
  it("returns 'pd' for windowDays <= 1", () => {
    assert.equal(freshnessForWindow(1), "pd");
  });
  it("returns 'pw' for windowDays 2-7", () => {
    assert.equal(freshnessForWindow(3), "pw");
    assert.equal(freshnessForWindow(7), "pw");
  });
  it("returns 'pm' for windowDays 8-31", () => {
    assert.equal(freshnessForWindow(15), "pm");
    assert.equal(freshnessForWindow(31), "pm");
  });
  it("returns 'py' for windowDays > 31", () => {
    assert.equal(freshnessForWindow(60), "py");
  });
});
