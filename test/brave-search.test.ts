/**
 * test/brave-search.test.ts (#1555)
 *
 * Tests for the Brave Search API wrapper using a mock fetch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { braveSearch, freshnessForWindow } from "../scripts/lib/brave-search.ts";

function mockFetch(
  responseFactory: (url: string) => { ok: boolean; status: number; body: unknown },
) {
  return async (url: string | URL) => {
    const { ok, status, body } = responseFactory(url.toString());
    return {
      ok,
      status,
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
