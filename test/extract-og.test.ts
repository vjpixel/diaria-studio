/**
 * test/extract-og.test.ts (#1559 part B)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractOgFromBody, fetchOgMetadata } from "../scripts/lib/extract-og.ts";

describe("extractOgFromBody", () => {
  it("extracts og:title + og:description + og:article:published_time", () => {
    const body = `
      <html>
      <head>
      <meta property="og:title" content="OpenAI launches GPT-7">
      <meta property="og:description" content="New flagship reasoning model">
      <meta property="article:published_time" content="2026-05-28T10:00:00Z">
      </head>
      </html>
    `;
    const r = extractOgFromBody(body);
    assert.equal(r.title, "OpenAI launches GPT-7");
    assert.equal(r.description, "New flagship reasoning model");
    assert.equal(r.publishedTime, "2026-05-28T10:00:00Z");
  });

  it("falls back to <title> when og:title missing", () => {
    const body = `<html><head><title>Fallback Title</title></head></html>`;
    const r = extractOgFromBody(body);
    assert.equal(r.title, "Fallback Title");
  });

  it("falls back to meta description when og:description missing", () => {
    const body = `<meta name="description" content="Description from meta tag">`;
    const r = extractOgFromBody(body);
    assert.equal(r.description, "Description from meta tag");
  });

  it("decodes HTML entities in title/description", () => {
    const body = `
      <meta property="og:title" content="OpenAI &amp; Anthropic partner">
      <meta property="og:description" content="Multi&#8211;company &quot;launch&quot;">
    `;
    const r = extractOgFromBody(body);
    assert.equal(r.title, "OpenAI & Anthropic partner");
    // &#8211; is en-dash (–)
    assert.equal(r.description, 'Multi–company "launch"');
  });

  it("handles content attribute before property attribute (reverse order)", () => {
    const body = `<meta content="Reversed Order" property="og:title">`;
    const r = extractOgFromBody(body);
    assert.equal(r.title, "Reversed Order");
  });

  it("returns null fields when nothing found", () => {
    const body = `<html><body>No metadata here</body></html>`;
    const r = extractOgFromBody(body);
    assert.equal(r.title, null);
    assert.equal(r.description, null);
    assert.equal(r.publishedTime, null);
  });

  it("returns null fields on invalid body (defensive)", () => {
    const r = extractOgFromBody("");
    assert.equal(r.title, null);
    assert.equal(r.description, null);
  });
});

describe("fetchOgMetadata", () => {
  it("fetches and parses OG metadata", async () => {
    const mockBody = `<meta property="og:title" content="Test Article">`;
    const fetchFn = (async () => ({
      status: 200,
      text: async () => mockBody,
    })) as unknown as typeof fetch;
    const r = await fetchOgMetadata("https://example.com/article", { fetchFn });
    assert.ok(r);
    assert.equal(r?.title, "Test Article");
  });

  it("returns null on 4xx status", async () => {
    const fetchFn = (async () => ({
      status: 404,
      text: async () => "Not found",
    })) as unknown as typeof fetch;
    const r = await fetchOgMetadata("https://example.com/missing", { fetchFn });
    assert.equal(r, null);
  });

  it("returns null on network error", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchOgMetadata("https://example.com", { fetchFn });
    assert.equal(r, null);
  });

  it("respects timeout (returns null on abort)", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      // Simulate hang — wait for abort signal
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const r = await fetchOgMetadata("https://example.com", { fetchFn, timeoutMs: 100 });
    assert.equal(r, null);
  });
});
