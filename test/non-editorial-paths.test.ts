/**
 * test/non-editorial-paths.test.ts (#1559 part A)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNonEditorialPath } from "../scripts/lib/non-editorial-paths.ts";

describe("isNonEditorialPath", () => {
  it("rejects help.* subdomain", () => {
    assert.equal(isNonEditorialPath("https://help.openai.com/articles/12345-faq"), true);
  });

  it("rejects support.* subdomain", () => {
    assert.equal(isNonEditorialPath("https://support.anthropic.com/article/x"), true);
  });

  it("rejects docs.* subdomain", () => {
    assert.equal(isNonEditorialPath("https://docs.anthropic.com/reference"), true);
  });

  it("rejects developers.* subdomain", () => {
    assert.equal(isNonEditorialPath("https://developers.openai.com/api/docs/changelog"), true);
  });

  it("rejects /help/ path", () => {
    assert.equal(isNonEditorialPath("https://example.com/help/article"), true);
  });

  it("rejects /faq/ path", () => {
    assert.equal(isNonEditorialPath("https://example.com/faq/subscription"), true);
  });

  it("rejects /about/, /legal/, /privacy/, /terms/, /careers/, /jobs/", () => {
    for (const p of ["about", "legal", "privacy", "terms", "careers", "jobs"]) {
      assert.equal(
        isNonEditorialPath(`https://example.com/${p}/x`),
        true,
        `should reject /${p}/`,
      );
    }
  });

  it("EDITORIAL OVERRIDE: /blog/ wins over docs subdomain", () => {
    assert.equal(isNonEditorialPath("https://docs.huggingface.co/blog/new-model"), false);
  });

  it("EDITORIAL OVERRIDE: /news/ wins over help subdomain", () => {
    assert.equal(isNonEditorialPath("https://help.example.com/news/changelog"), false);
  });

  it("EDITORIAL OVERRIDE: /research/ wins over docs subdomain", () => {
    assert.equal(isNonEditorialPath("https://docs.anthropic.com/research/paper"), false);
  });

  it("keeps regular editorial URLs", () => {
    assert.equal(isNonEditorialPath("https://openai.com/blog/gpt-5"), false);
    assert.equal(isNonEditorialPath("https://blogs.nvidia.com/blog/ai-factories"), false);
    assert.equal(isNonEditorialPath("https://anthropic.com/news/claude-4"), false);
    assert.equal(isNonEditorialPath("https://exame.com/inteligencia-artificial/x"), false);
  });

  it("returns false for malformed URLs (defensive)", () => {
    assert.equal(isNonEditorialPath("not-a-url"), false);
    assert.equal(isNonEditorialPath(""), false);
  });

  it("260529 regression: help.openai.com FAQ pages", () => {
    assert.equal(
      isNonEditorialPath(
        "https://help.openai.com/it-it/articles/12677804-what-is-chatgpt-faq",
      ),
      true,
    );
    assert.equal(
      isNonEditorialPath(
        "https://help.openai.com/de-de/articles/8381046-faq-zu-chatgpt",
      ),
      true,
    );
  });
});
