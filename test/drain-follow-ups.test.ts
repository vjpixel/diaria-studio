/**
 * drain-follow-ups.test.ts — tests for issues #665, #667, #666
 *
 * #665: searchThreads failure returns skipped:true / reason:"search_failed"
 * #667: DrainResult exposes errors count from getThread failures
 * #666: resolveCoverageLine pure function — 5 paths
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSearchFailedResult } from "../scripts/inbox-drain.ts";
import { resolveCoverageLine } from "../scripts/render-categorized-md.ts";

// ---------------------------------------------------------------------------
// #665 — searchThreads failure structure
// ---------------------------------------------------------------------------

describe("buildSearchFailedResult (#665)", () => {
  it("retorna DrainResult com skipped:true e reason:search_failed", () => {
    const result = buildSearchFailedResult("ZodError: payload.headers required");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "search_failed");
    assert.equal(result.new_entries, 0);
    assert.deepEqual(result.urls, []);
    assert.deepEqual(result.topics, []);
    assert.equal(result.most_recent_iso, null);
  });

  it("inclui errors:1 e error_samples", () => {
    const result = buildSearchFailedResult("Gmail API error (503)");
    assert.equal(result.errors, 1);
    assert.ok(Array.isArray(result.error_samples));
    assert.equal(result.error_samples![0], "Gmail API error (503)");
  });

  it("trunca erro longo a 200 chars", () => {
    const longMsg = "x".repeat(500);
    const result = buildSearchFailedResult(longMsg);
    assert.equal(result.error_samples![0].length, 200);
  });

  it("resultado diferenciado de drain vazio normal (drain vazio tem skipped:false)", () => {
    const result = buildSearchFailedResult("oops");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "search_failed");
  });
});

// ---------------------------------------------------------------------------
// #667 — DrainResult interface: campos errors e error_samples são opcionais
// ---------------------------------------------------------------------------

describe("DrainResult errors fields (#667)", () => {
  it("buildSearchFailedResult inclui errors e error_samples", () => {
    const r = buildSearchFailedResult("err");
    assert.ok("errors" in r);
    assert.ok("error_samples" in r);
    assert.equal(r.errors, 1);
  });

  it("campos são opcionais — resultado de drain limpo não precisa ter errors", () => {
    // Garante que o tipo aceita ausência dos campos
    const clean: ReturnType<typeof buildSearchFailedResult> = {
      new_entries: 1,
      urls: [],
      topics: [],
      most_recent_iso: "2026-05-05T10:00:00Z",
      skipped: false,
    };
    assert.equal(clean.errors, undefined);
    assert.equal(clean.error_samples, undefined);
  });
});

// ---------------------------------------------------------------------------
// #666 — resolveCoverageLine pure function
// ---------------------------------------------------------------------------

describe("resolveCoverageLine (#666)", () => {
  const fallback = () => "fallback line";

  it("path 1a — cliIn é 01-approved.json com inputCoverage.line", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: { line: "Para esta edição, eu (o editor) enviei 5 submissões..." },
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "Para esta edição, eu (o editor) enviei 5 submissões...");
  });

  it("path 1b — cliIn é 01-approved.json sem inputCoverage → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: undefined,
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("path 1c — cliIn é 01-approved.json com inputCoverage sem line → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: {},
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("path 2 — cliIn é outro arquivo, siblingCoverage tem line", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-categorized.json",
      inputCoverage: undefined,
      siblingCoverage: { line: "Para esta edição, eu (o editor) enviei 26 submissões..." },
      fallback,
    });
    assert.equal(line, "Para esta edição, eu (o editor) enviei 26 submissões...");
  });

  it("path 3 — cliIn é outro arquivo, siblingCoverage é null → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-categorized.json",
      inputCoverage: undefined,
      siblingCoverage: null,
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("path 4 — cliIn é outro arquivo, siblingCoverage sem line → fallback", () => {
    const line = resolveCoverageLine({
      cliInBasename: "01-categorized.json",
      inputCoverage: undefined,
      siblingCoverage: {},
      fallback,
    });
    assert.equal(line, "fallback line");
  });

  it("siblingCoverage não é consultada quando cliIn é approved.json", () => {
    // Garante que path 1 não lê sibling mesmo que exista (evitar re-read de disco)
    let siblingCalled = false;
    const line = resolveCoverageLine({
      cliInBasename: "01-approved.json",
      inputCoverage: { line: "from input" },
      get siblingCoverage() {
        siblingCalled = true;
        return { line: "from sibling" };
      },
      fallback,
    });
    assert.equal(line, "from input");
    assert.equal(siblingCalled, false);
  });
});
