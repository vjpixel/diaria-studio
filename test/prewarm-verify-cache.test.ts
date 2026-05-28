/**
 * test/prewarm-verify-cache.test.ts (#1554 P1)
 *
 * Tests the URL extraction logic. The subprocess invocation of
 * verify-accessibility is not covered (integration concern).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUrls } from "../scripts/prewarm-verify-cache.ts";

describe("extractUrls", () => {
  it("extracts URLs from researcher-results shape (array of RunRecord)", () => {
    const data = [
      { articles: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }] },
      { articles: [{ url: "https://example.com/c" }] },
    ];
    const urls = extractUrls(data);
    assert.equal(urls.length, 3);
    assert.ok(urls.includes("https://example.com/a"));
    assert.ok(urls.includes("https://example.com/c"));
  });

  it("deduplicates URLs across records", () => {
    const data = [
      { articles: [{ url: "https://example.com/x" }] },
      { articles: [{ url: "https://example.com/x" }, { url: "https://example.com/y" }] },
    ];
    const urls = extractUrls(data);
    assert.equal(urls.length, 2);
  });

  it("filters non-http URLs (mailto, relative, malformed)", () => {
    const data = [
      {
        articles: [
          { url: "https://example.com/ok" },
          { url: "mailto:foo@bar.com" },
          { url: "/relative/path" },
          { url: "" },
          { url: null as unknown as string },
        ],
      },
    ];
    const urls = extractUrls(data);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://example.com/ok");
  });

  it("handles object shape with top-level articles", () => {
    const data = { articles: [{ url: "https://example.com/a" }] };
    const urls = extractUrls(data);
    assert.equal(urls.length, 1);
  });

  it("returns empty for empty input", () => {
    assert.equal(extractUrls([]).length, 0);
    assert.equal(extractUrls({}).length, 0);
    assert.equal(extractUrls(null).length, 0);
  });

  it("skips records without articles array", () => {
    const data = [{ error: "fetch failed" }, { articles: [{ url: "https://example.com/a" }] }];
    const urls = extractUrls(data);
    assert.equal(urls.length, 1);
  });
});
