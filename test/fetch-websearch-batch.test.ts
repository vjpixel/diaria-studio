/**
 * test/fetch-websearch-batch.test.ts (#1555)
 *
 * Tests for the pure helpers in fetch-websearch-batch.ts.
 * The full main() with rate-limited dispatch is not tested in unit (integration concern).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  processResult,
  buildSourceQuery,
  shouldRecordBraveResponse,
} from "../scripts/fetch-websearch-batch.ts";

describe("processResult", () => {
  const cutoff = "2026-05-25";

  it("keeps AI-relevant result within date window", () => {
    const r = processResult(
      {
        title: "OpenAI launches new GPT model",
        url: "https://openai.com/blog/new-gpt",
        description: "An update on our language model lineup",
        page_age: "2026-05-27T10:00:00Z",
      },
      "OpenAI",
      cutoff,
    );
    assert.ok(r.kept, "should keep AI-relevant recent article");
    assert.equal(r.kept?.source, "OpenAI");
    assert.equal(r.kept?.url, "https://openai.com/blog/new-gpt");
    assert.equal(r.kept?.date, "2026-05-27");
  });

  it("filters by date when page_age is before cutoff", () => {
    const r = processResult(
      {
        title: "OpenAI launches GPT model",
        url: "https://openai.com/blog/x",
        description: "AI thing",
        page_age: "2026-05-20T10:00:00Z",
      },
      "OpenAI",
      cutoff,
    );
    assert.equal(r.kept, null);
    assert.equal(r.reason, "date");
  });

  it("filters out aggregator URLs", () => {
    const r = processResult(
      {
        title: "AI roundup of the week",
        url: "https://flipboard.com/article/123",
        description: "Top AI stories about LLM and machine learning",
      },
      "WebSearch",
      cutoff,
    );
    assert.equal(r.kept, null);
    assert.equal(r.reason, "aggregator");
  });

  it("filters out non-AI-relevant results", () => {
    const r = processResult(
      {
        title: "Restaurant review: New Italian place opens",
        url: "https://example.com/food",
        description: "The pasta was great and the wine list extensive",
      },
      "WebSearch",
      cutoff,
    );
    assert.equal(r.kept, null);
    assert.equal(r.reason, "relevance");
  });

  it("strips Brave's <strong> highlight tags from title and summary", () => {
    const r = processResult(
      {
        title: "<strong>OpenAI</strong> launches AI model",
        url: "https://openai.com/x",
        description: "New <strong>LLM</strong> announcement",
        page_age: "2026-05-27T10:00:00Z",
      },
      "OpenAI",
      cutoff,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.title, "OpenAI launches AI model");
    assert.equal(r.kept?.summary, "New LLM announcement");
  });

  it("allows article through when page_age missing (verify-dates handles downstream)", () => {
    const r = processResult(
      {
        title: "AI model update",
        url: "https://openai.com/x",
        description: "GPT changes",
        // no page_age
      },
      "OpenAI",
      cutoff,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.date, undefined);
  });

  it("marks discovered_source=true when discovered=true", () => {
    const r = processResult(
      {
        title: "AI breakthrough in LLM research",
        url: "https://example.com/x",
        description: "New transformer architecture",
        page_age: "2026-05-27T10:00:00Z",
      },
      "discovery: LLM",
      cutoff,
      true,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.discovered_source, true);
  });

  it("does NOT set discovered_source when discovered=false", () => {
    const r = processResult(
      {
        title: "AI breakthrough in LLM",
        url: "https://example.com/x",
        description: "transformer",
        page_age: "2026-05-27T10:00:00Z",
      },
      "OpenAI",
      cutoff,
      false,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.discovered_source, undefined);
  });
});

// (#3389) REGRESSÃO: raiz do falso-positivo persistente do alarme critical
// (#3002/#3122/#3271/#3307/#3389). Antes deste fix, o guard em runQuery só
// gravava crédito para status ok/rate_limited — uma resposta 402 "usage limit
// exceeded" (free tier esgotado) descartava o header quota_remaining mesmo
// quando presente, congelando `quota_remaining_last_seen` no último valor
// pré-exaustão pelo resto do mês. Este teste caracteriza a decisão correta:
// gravar (sem contar como query real — ver test/brave-credits.test.ts) sempre
// que o header vier junto do erro.
describe("shouldRecordBraveResponse (#3389)", () => {
  it("grava sempre que status é ok", () => {
    assert.equal(shouldRecordBraveResponse({ status: "ok" }), true);
  });

  it("grava sempre que status é rate_limited (429), mesmo sem quota_remaining", () => {
    assert.equal(shouldRecordBraveResponse({ status: "rate_limited" }), true);
  });

  it("grava quando status é error MAS o header quota_remaining veio preenchido (402 com header) — o fix do #3389", () => {
    assert.equal(shouldRecordBraveResponse({ status: "error", quota_remaining: 0 }), true);
    assert.equal(shouldRecordBraveResponse({ status: "error", quota_remaining: 49 }), true);
  });

  it("NÃO grava quando status é error e não há quota_remaining (comportamento pré-#3389 preservado)", () => {
    assert.equal(shouldRecordBraveResponse({ status: "error" }), false);
    assert.equal(shouldRecordBraveResponse({ status: "error", quota_remaining: undefined }), false);
  });
});

describe("buildSourceQuery", () => {
  it("prefixes site: when site_query lacks it", () => {
    const q = buildSourceQuery({ name: "OpenAI", site_query: "openai.com" });
    assert.match(q, /^site:openai\.com /);
    assert.match(q, /artificial intelligence/);
  });

  it("preserves site: prefix when already present", () => {
    const q = buildSourceQuery({ name: "OpenAI", site_query: "site:openai.com" });
    assert.match(q, /^site:openai\.com /);
    assert.doesNotMatch(q, /site:site:/);
  });

  it("includes AI terms in PT and EN", () => {
    const q = buildSourceQuery({ name: "X", site_query: "x.com" });
    assert.match(q, /inteligência artificial/i);
    assert.match(q, /artificial intelligence/i);
  });
});
