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
  it("produces valid HTML with core sections", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes("260525"));
    assert.ok(html.includes("Tempo por stage"));
    assert.ok(html.includes("Publicacao"));
  });

  it("#1739: renderiza a URL do social preview quando fornecida", () => {
    const url = "https://draft.diaria.workers.dev/260525-social-2a02da";
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], [], null, url);
    assert.ok(html.includes("Preview social"), "deve ter a linha de preview social");
    assert.ok(html.includes(url), "deve conter a URL versionada (com hash)");
  });

  it("#1739: sem URL de social preview → sem bloco (não crasha)", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], [], null, null);
    assert.ok(!html.includes("Preview social"), "sem URL → sem linha de preview social");
    assert.ok(html.includes("<!DOCTYPE html>"), "render normal");
  });

  it("#1739/#1612: preview da newsletter prefere draft_preview_url (com hash) ao hashless", () => {
    const hashed = "https://draft.diaria.workers.dev/260525-796cd4";
    const published = {
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      title: "Edição",
      status: "draft",
      draft_preview_url: hashed,
    } as unknown as Parameters<typeof renderHtmlReport>[2];
    const html = renderHtmlReport("260525", MINIMAL_DOC, published, null, [], []);
    assert.ok(html.includes(hashed), "usa a URL com hash persistida");
    assert.ok(!html.includes(">https://draft.diaria.workers.dev/260525<"), "não usa a versão hashless");
  });

  // #1609: seção "Destaques" removida (redundante — editor já vê no Drive +
  // test email). highlights não é mais argumento de renderHtmlReport.
  it("omits the Destaques section", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    assert.ok(!html.includes("<h2>Destaques</h2>"), "Destaques header should be gone");
  });

  it("shows pipeline_ms when available", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    assert.ok(html.includes("+gate:"), "should show gate annotation for stages with pipeline_ms");
    assert.ok(html.includes("5m"), "pipeline_ms of 300000 should render as 5m");
  });

  it("#1706: stage sem duração medida → '(não medido)', não '-'", () => {
    const docSemDuracao: StageStatusDoc = {
      ...MINIMAL_DOC,
      rows: [
        { stage: 0, status: "done", models: [] }, // sem start/end/duration
        ...MINIMAL_DOC.rows.slice(1),
      ],
    };
    const html = renderHtmlReport("260525", docSemDuracao, null, null, [], []);
    assert.ok(html.includes("(não medido)"), "stage sem dados deve dizer '(não medido)' explícito");
  });

  it("#1706: stage com duration_ms (sem pipeline_ms) renderiza o total, não '(não medido)'", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    // stage 2 tem duration_ms=900000 (15m) e sem pipeline_ms → mostra 15m.
    assert.ok(html.includes("15m"), "duration_ms de 900000 deve renderizar 15m");
  });

  // #1609: total = soma do tempo de pipeline (sem aguardo de gate).
  // MINIMAL_DOC: 60k(s0) + 300k(s1 pipeline) + 900k(s2) + 300k(s3) + 300k(s4)
  // = 1.860.000ms = 31m. Soma de duration_ms (antes) seria 35m.
  it("total duration soma pipeline_ms, nao duration_ms (com aguardo gate)", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    assert.ok(html.includes("31m"), "total deve usar pipeline (31m), nao 35m");
    assert.ok(!html.includes("35m"), "total nao deve incluir aguardo de gate");
  });

  it("marca fallback quando algum stage nao tem pipeline_ms", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    assert.ok(html.includes("pre-#1517"), "deve marcar visualmente o fallback duration_ms");
  });

  it("sem fallback quando todos os stages tem pipeline_ms", () => {
    const allPipeline: StageStatusDoc = {
      ...MINIMAL_DOC,
      rows: MINIMAL_DOC.rows.map((r) => ({ ...r, pipeline_ms: r.pipeline_ms ?? r.duration_ms })),
    };
    const html = renderHtmlReport("260525", allPipeline, null, null, [], []);
    assert.ok(!html.includes("pre-#1517"), "sem fallback, sem marcador");
  });

  it("omits cost column", () => {
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, [], []);
    assert.ok(!html.includes("Custo"), "cost column header should not appear");
    assert.ok(!html.includes("not available"), "hardcoded 'not available' should be gone");
  });

  it("escapes single quotes in HTML", () => {
    const warnings = [{ level: "warn", message: "It's a timeout", agent: "researcher", stage: 1, edition: "260525" }];
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, warnings, []);
    assert.ok(!html.includes("It's a timeout"), "single quote should be escaped");
    assert.ok(html.includes("It&#39;s a timeout"), "single quote should become &#39;");
  });

  it("shows warnings and errors", () => {
    const warnings = [{ level: "warn", message: "timeout", agent: "researcher", stage: 1, edition: "260525" }];
    const errors = [{ level: "error", message: "crash", agent: "writer", stage: 2, edition: "260525" }];
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, null, warnings, errors);
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
    const html = renderHtmlReport("260525", MINIMAL_DOC, null, social, [], []);
    assert.ok(html.includes("facebook"));
    assert.ok(html.includes("linkedin"));
    assert.ok(html.includes("BRT"));
  });
});

describe("buildSummary", () => {
  // #1609: total soma pipeline_ms (fallback duration_ms): 60k+300k+900k+300k+300k.
  it("computes total pipeline duration from all stages (sem aguardo gate)", () => {
    const summary = buildSummary("260525", MINIMAL_DOC, HIGHLIGHTS, null, null, 2, 1);
    assert.equal(summary.total_duration_ms, 1_860_000);
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
