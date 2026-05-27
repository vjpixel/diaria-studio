import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderHtmlReport,
  buildSummary,
  type HighlightSummary,
} from "../scripts/send-edition-report.ts";
import type { StageStatusDoc } from "../scripts/update-stage-status.ts";

const MINIMAL_DOC: StageStatusDoc = {
  edition: "260525",
  generated_at: "2026-05-25T20:00:00Z",
  rows: [
    { stage: 0, status: "done", start: "2026-05-25T18:00:00Z", end: "2026-05-25T18:01:00Z", duration_ms: 60_000, models: ["haiku"] },
    { stage: 1, status: "done", start: "2026-05-25T18:01:00Z", end: "2026-05-25T18:10:00Z", duration_ms: 540_000, pipeline_ms: 300_000, models: ["haiku", "sonnet"] },
    { stage: 2, status: "done", start: "2026-05-25T18:10:00Z", end: "2026-05-25T18:25:00Z", duration_ms: 900_000, models: ["sonnet"] },
    { stage: 3, status: "done", start: "2026-05-25T18:25:00Z", end: "2026-05-25T18:30:00Z", duration_ms: 300_000, models: [] },
    { stage: 4, status: "done", start: "2026-05-25T18:30:00Z", end: "2026-05-25T18:35:00Z", duration_ms: 300_000, models: ["sonnet"] },
  ],
};

const HIGHLIGHTS: HighlightSummary[] = [
  { title: "OpenAI lanca GPT-5", url: "https://openai.com/gpt-5" },
  { title: "Google Gemini 3", url: "https://blog.google/gemini-3" },
  { title: "Meta Llama 5", url: "https://ai.meta.com/llama-5" },
];

describe("renderHtmlReport", () => {
  it("produces valid HTML with all sections", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, [], []);
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes("260525"));
    assert.ok(html.includes("OpenAI lanca GPT-5"));
    assert.ok(html.includes("https://openai.com/gpt-5"));
  });

  it("shows pipeline_ms when available", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, [], []);
    assert.ok(html.includes("+gate:"), "should show gate annotation for stages with pipeline_ms");
    assert.ok(html.includes("5m"), "pipeline_ms of 300000 should render as 5m");
  });

  it("omits cost column", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, [], []);
    assert.ok(!html.includes("Custo"), "cost column header should not appear");
    assert.ok(!html.includes("not available"), "hardcoded 'not available' should be gone");
  });

  it("escapes single quotes in HTML", () => {
    const xssHighlights: HighlightSummary[] = [
      { title: "It's a test", url: "https://example.com" },
    ];
    const html = renderHtmlReport("260525", MINIMAL_DOC, xssHighlights, null, null, [], []);
    assert.ok(!html.includes("It's"), "single quote should be escaped");
    assert.ok(html.includes("It&#39;s"), "single quote should become &#39;");
  });

  it("shows warnings and errors", () => {
    const warnings = [{ level: "warn", message: "timeout", agent: "researcher", stage: 1, edition: "260525" }];
    const errors = [{ level: "error", message: "crash", agent: "writer", stage: 2, edition: "260525" }];
    const html = renderHtmlReport("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, warnings, errors);
    assert.ok(html.includes("Warnings (1)"));
    assert.ok(html.includes("Errors (1)"));
    assert.ok(html.includes("timeout"));
    assert.ok(html.includes("crash"));
  });

  it("renders social posts table", () => {
    const social = {
      posts: [
        { platform: "facebook", destaque: "d1", status: "published", scheduled_at: "2026-05-25T20:00:00Z" },
        { platform: "linkedin", destaque: "d1", status: "scheduled", scheduled_at: "2026-05-26T20:00:00Z" },
      ],
    };
    const html = renderHtmlReport("260525", MINIMAL_DOC, HIGHLIGHTS, null, social, [], []);
    assert.ok(html.includes("facebook"));
    assert.ok(html.includes("linkedin"));
    assert.ok(html.includes("BRT"));
  });
});

describe("buildSummary", () => {
  it("computes total duration from all stages", () => {
    const summary = buildSummary("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, 2, 1);
    assert.equal(summary.total_duration_ms, 2_100_000);
    assert.equal(summary.warnings_count, 2);
    assert.equal(summary.errors_count, 1);
  });

  it("includes pipeline_ms when present", () => {
    const summary = buildSummary("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, 0, 0);
    const stage1 = summary.stages.find((s) => s.stage === 1);
    assert.equal(stage1?.pipeline_ms, 300_000);
    const stage0 = summary.stages.find((s) => s.stage === 0);
    assert.equal(stage0?.pipeline_ms, undefined);
  });

  it("maps social posts", () => {
    const social = {
      posts: [
        { platform: "facebook", destaque: "d1", status: "published" },
      ],
    };
    const summary = buildSummary("260525", MINIMAL_DOC, HIGHLIGHTS, null, social, 0, 0);
    assert.equal(summary.social_posts.length, 1);
    assert.equal(summary.social_posts[0].platform, "facebook");
  });

  it("defaults newsletter status when not available", () => {
    const summary = buildSummary("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, 0, 0);
    assert.equal(summary.newsletter_status, "not_available");
  });
});
