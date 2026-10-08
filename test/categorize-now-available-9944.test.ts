/**
 * #9944 — a exceção `lancamento-new-platform-availability` (#9882) aceitava
 * qualquer complemento depois de "now available for|on" / "now works with|in"
 * e retornava `lancamento` antes das checagens de relatório/explainer/notícia.
 * Os 4 títulos da issue (reproduzidos com `categorizeWithRule` em domínio
 * oficial) caíam em LANÇAMENTOS; devem voltar a `noticias`/`lancamento-update`
 * (bucket radar). Os casos reais do #9882 seguem em
 * `categorize-bucket-move-9882.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeWithRule, categoryToBucket, isNewPlatformAvailabilityTitle } from "../scripts/lib/launch-heuristics.ts";
import { startsWithGeoComplement } from "../scripts/lib/launch-vs-news.ts";

const bucketAndRule = (a: Parameters<typeof categorizeWithRule>[0]) => {
  const r = categorizeWithRule(a);
  return { bucket: categoryToBucket(r.category), rule: r.rule };
};

describe("#9944 — 'now available for/works with' amplo demais não vira LANÇAMENTOS", () => {
  const cases: Array<{ url: string; title: string }> = [
    {
      url: "https://openai.com/index/state-of-enterprise-ai-2026",
      title: "The 2026 State of Enterprise AI report is now available for download",
    },
    { url: "https://blog.google/products/gemini/release-notes-gmail/", title: "Release notes: Gemini now works with Gmail" },
    { url: "https://www.anthropic.com/news/claude-brazil", title: "Claude is now available for Brazil" },
    { url: "https://openai.com/index/economic-blueprint-brazil", title: "Our economic blueprint is now available for Brazil" },
  ];
  for (const c of cases) {
    it(`'${c.title}' → não é lancamento`, () => {
      assert.equal(isNewPlatformAvailabilityTitle(c), false);
      const r = bucketAndRule(c);
      assert.notEqual(r.bucket, "lancamento", JSON.stringify(r));
      assert.notEqual(r.rule, "lancamento-new-platform-availability");
    });
  }

  it("complemento geográfico (país/região) e 'download' não disparam a exceção", () => {
    for (const title of [
      "Gemini now available for download",
      "ChatGPT now works in the EU",
      "Copilot is now available on more countries",
      "Claude now available for Japan",
    ]) {
      assert.equal(isNewPlatformAvailabilityTitle({ url: "https://example.com", title }), false, title);
    }
  });

  it("startsWithGeoComplement: país/região sim, superfície/app não", () => {
    assert.equal(startsWithGeoComplement(" Brazil"), true);
    assert.equal(startsWithGeoComplement(" the EU"), true);
    assert.equal(startsWithGeoComplement(" Windows"), false);
    assert.equal(startsWithGeoComplement(" Google Docs, Sheets, and Slides"), false);
  });

  it("superfícies/apps seguem disparando (Windows, Mac, iOS, Android, app)", () => {
    for (const title of [
      "The Gemini app is now available for Windows",
      "ChatGPT is now available on Mac",
      "Claude now available on iOS and Android",
      "Claude now works with Google Docs, Sheets, and Slides",
    ]) {
      assert.equal(isNewPlatformAvailabilityTitle({ url: "https://example.com", title }), true, title);
    }
  });
});
