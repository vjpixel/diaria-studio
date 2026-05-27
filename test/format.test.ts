import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmtTimeBrt, fmtDuration, escapeHtml } from "../scripts/lib/format.ts";

describe("fmtDuration", () => {
  it("returns - for zero/undefined/negative", () => {
    assert.equal(fmtDuration(0), "-");
    assert.equal(fmtDuration(undefined), "-");
    assert.equal(fmtDuration(-1), "-");
  });

  it("formats seconds", () => {
    assert.equal(fmtDuration(5_000), "5s");
    assert.equal(fmtDuration(59_000), "59s");
  });

  it("formats minutes", () => {
    assert.equal(fmtDuration(60_000), "1m");
    assert.equal(fmtDuration(90_000), "1m 30s");
  });

  it("formats hours", () => {
    assert.equal(fmtDuration(3_600_000), "1h");
    assert.equal(fmtDuration(5_400_000), "1h 30m");
  });
});

describe("fmtTimeBrt", () => {
  it("returns - for undefined/invalid", () => {
    assert.equal(fmtTimeBrt(undefined), "-");
    assert.equal(fmtTimeBrt("garbage"), "-");
  });

  it("converts UTC to BRT (UTC-3)", () => {
    assert.equal(fmtTimeBrt("2026-05-25T18:00:00Z"), "15:00");
    assert.equal(fmtTimeBrt("2026-05-25T03:00:00Z"), "00:00");
  });
});

describe("escapeHtml", () => {
  it("escapes all dangerous characters", () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("escapes single quotes", () => {
    assert.equal(escapeHtml("it's"), "it&#39;s");
  });

  it("escapes ampersands", () => {
    assert.equal(escapeHtml("a & b"), "a &amp; b");
  });
});
