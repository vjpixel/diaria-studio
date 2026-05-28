/**
 * test/extract-date.test.ts (#1554 P2)
 *
 * Tests for the shared date extraction lib. The logic was originally in
 * verify-dates.ts and now lives in scripts/lib/extract-date.ts so it can
 * be reused by verify-accessibility.ts (eliminating refetch in step 1p1).
 *
 * Coverage of all 7 strategies + normalizeDate edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDateFromBody, normalizeDate } from "../scripts/lib/extract-date.ts";

describe("normalizeDate", () => {
  it("normalizes ISO 8601 to YYYY-MM-DD in BR timezone", () => {
    assert.equal(normalizeDate("2026-05-27T15:00:00Z"), "2026-05-27");
  });

  it("handles late-night UTC publishing as previous day in BR", () => {
    // 02:00 UTC = 23:00 BRT do dia anterior
    assert.equal(normalizeDate("2026-05-28T02:00:00Z"), "2026-05-27");
  });

  it("returns null for invalid input", () => {
    assert.equal(normalizeDate("not a date"), null);
    assert.equal(normalizeDate(""), null);
  });

  it("handles date-only format", () => {
    assert.equal(normalizeDate("2026-05-27"), "2026-05-26"); // midnight UTC → previous day in BRT
  });
});

describe("extractDateFromBody — strategy 1: JSON-LD", () => {
  it("extracts datePublished from JSON-LD script", () => {
    const body = `<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-05-27T10:00:00Z"}</script>`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-27");
    assert.equal(result.note, "json-ld:datePublished");
  });

  it("handles JSON-LD @graph structure", () => {
    const body = `<script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2026-05-26T12:00:00Z"}]}</script>`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-26");
  });

  it("skips malformed JSON-LD without throwing", () => {
    const body = `<script type="application/ld+json">{ not valid json </script><meta property="article:published_time" content="2026-05-25T10:00:00Z">`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-25");
    assert.equal(result.note, "og:article:published_time");
  });
});

describe("extractDateFromBody — strategy 2-7: fallbacks", () => {
  it("strategy 2: og:article:published_time", () => {
    const body = `<meta property="article:published_time" content="2026-05-20T15:00:00Z">`;
    assert.equal(extractDateFromBody(body).note, "og:article:published_time");
  });

  it("strategy 3: meta pubdate", () => {
    const body = `<meta name="pubdate" content="2026-05-20T15:00:00Z">`;
    assert.equal(extractDateFromBody(body).note, "meta:pubdate");
  });

  it("strategy 4: citation_date (YYYY/MM/DD format)", () => {
    const body = `<meta name="citation_date" content="2026/05/20">`;
    const result = extractDateFromBody(body);
    assert.ok(result.date);
    assert.equal(result.note, "meta:citation_date");
  });

  it("strategy 5: time itemprop=datePublished", () => {
    const body = `<time itemprop="datePublished" datetime="2026-05-20T15:00:00Z">May 20</time>`;
    assert.equal(extractDateFromBody(body).note, "time[itemprop=datePublished]");
  });

  it("strategy 6a: explicit datePublished in JSON", () => {
    const body = `<script>var data = {"dateModified":"2026-05-22","datePublished":"2026-05-20T10:00:00Z"};</script>`;
    const result = extractDateFromBody(body);
    assert.equal(result.note, "json:datePublished-explicit");
  });

  it("strategy 7: first time datetime as fallback", () => {
    const body = `<time datetime="2026-05-20T15:00:00Z">May 20</time>`;
    assert.equal(extractDateFromBody(body).note, "time:first");
  });

  it("returns no-date-found when nothing matches", () => {
    const body = `<html><body>No dates here</body></html>`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, null);
    assert.equal(result.note, "no-date-found");
  });
});
