import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  hasSummary,
  extractArticles,
  findSummaryLossViolations,
} from "../scripts/verify-summary-integrity.ts";

const ROOT = resolve(import.meta.dirname, "..");
const TMP_DIR = resolve(ROOT, ".tmp-test-verify-summary-integrity");

describe("hasSummary", () => {
  it("true só para string não-vazia (trim)", () => {
    assert.equal(hasSummary({ summary: "resumo real" }), true);
    assert.equal(hasSummary({ summary: "" }), false);
    assert.equal(hasSummary({ summary: "   " }), false);
    assert.equal(hasSummary({}), false);
    assert.equal(hasSummary({ summary: undefined }), false);
    assert.equal(hasSummary({ summary: null }), false);
  });
});

describe("extractArticles — shapes conhecidos do Stage 1", () => {
  it("array flat (tmp-kept.json)", () => {
    const out = extractArticles([{ url: "https://a.com", summary: "x" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://a.com");
  });

  it("bucketed { lancamento, radar, use_melhor, video } (tmp-categorized.json)", () => {
    const out = extractArticles({
      lancamento: [{ url: "https://l.com", summary: "l" }],
      radar: [{ url: "https://r.com", summary: "r" }],
      use_melhor: [],
      video: [],
    });
    assert.equal(out.length, 2);
    assert.ok(out.some((a) => a.url === "https://l.com"));
    assert.ok(out.some((a) => a.url === "https://r.com"));
  });

  it("{ categorized: {...} } (tmp-dates-reviewed.json)", () => {
    const out = extractArticles({
      categorized: { lancamento: [{ url: "https://l.com", summary: "l" }], radar: [], use_melhor: [], video: [] },
      stats: { date_corrected: 0 },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://l.com");
  });

  it("{ finalists: [{ url, article }] } (tmp-finalists.json)", () => {
    const out = extractArticles({
      finalists: [
        { url: "https://f.com", score: 90, bucket: "radar", article: { url: "https://f.com", title: "T", summary: "s" } },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://f.com");
    assert.equal(out[0].title, "T");
    assert.equal(out[0].summary, "s");
  });

  it("shape desconhecido → []", () => {
    assert.deepEqual(extractArticles({ foo: "bar" }), []);
    assert.deepEqual(extractArticles(null), []);
    assert.deepEqual(extractArticles(42), []);
  });
});

describe("findSummaryLossViolations — regressão #4986/#4988", () => {
  it("flag artigo que tinha summary no raw e perdeu no downstream", () => {
    const raw = [{ url: "https://a.com", summary: "resumo original" }];
    const downstream = [{ url: "https://a.com", title: "A" }]; // summary sumiu
    const violations = findSummaryLossViolations(raw, downstream);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].url, "https://a.com");
    assert.equal(violations[0].title, "A");
  });

  it("não flag artigo que preservou summary", () => {
    const raw = [{ url: "https://a.com", summary: "resumo original" }];
    const downstream = [{ url: "https://a.com", summary: "resumo original" }];
    assert.deepEqual(findSummaryLossViolations(raw, downstream), []);
  });

  it("não flag artigo que NUNCA teve summary (fora de escopo deste checkpoint)", () => {
    const raw = [{ url: "https://a.com" }]; // sem summary desde a origem
    const downstream = [{ url: "https://a.com" }];
    assert.deepEqual(findSummaryLossViolations(raw, downstream), []);
  });

  it("não flag URL ausente do raw (fora do escopo do pool bruto)", () => {
    const raw: ReturnType<typeof extractArticles> = [];
    const downstream = [{ url: "https://novo.com" }];
    assert.deepEqual(findSummaryLossViolations(raw, downstream), []);
  });

  it("dedup de violação por URL repetida no downstream", () => {
    const raw = [{ url: "https://a.com", summary: "s" }];
    const downstream = [{ url: "https://a.com" }, { url: "https://a.com" }];
    assert.equal(findSummaryLossViolations(raw, downstream).length, 1);
  });
});

describe("verify-summary-integrity.ts CLI", () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("exit 0 sem violação", () => {
    const rawPath = resolve(TMP_DIR, "tmp-articles-raw.json");
    const checkPath = resolve(TMP_DIR, "tmp-finalists.json");
    writeFileSync(rawPath, JSON.stringify([{ url: "https://a.com", summary: "resumo" }]), "utf8");
    writeFileSync(
      checkPath,
      JSON.stringify({ finalists: [{ url: "https://a.com", article: { url: "https://a.com", summary: "resumo" } }] }),
      "utf8",
    );
    const out = execSync(
      `npx tsx scripts/verify-summary-integrity.ts --raw "${rawPath}" --check "${checkPath}"`,
      { cwd: ROOT, encoding: "utf8" },
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.violations_count, 0);
  });

  it("exit 1 + violação reportada quando summary some no checkpoint downstream", () => {
    const rawPath = resolve(TMP_DIR, "tmp-articles-raw.json");
    const checkPath = resolve(TMP_DIR, "tmp-finalists.json");
    writeFileSync(rawPath, JSON.stringify([{ url: "https://a.com", summary: "resumo original" }]), "utf8");
    writeFileSync(
      checkPath,
      JSON.stringify({
        finalists: [{ url: "https://a.com", article: { url: "https://a.com", title: "Título A" } }],
      }),
      "utf8",
    );

    let threw = false;
    let stdout = "";
    try {
      stdout = execSync(
        `npx tsx scripts/verify-summary-integrity.ts --raw "${rawPath}" --check "${checkPath}" --label finalists --log-root-dir "${TMP_DIR}"`,
        { cwd: ROOT, encoding: "utf8" },
      );
    } catch (e) {
      threw = true;
      stdout = (e as { stdout?: string }).stdout ?? "";
    }
    assert.equal(threw, true, "exit code deve ser != 0 quando há violação");
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.violations_count, 1);
    assert.equal(parsed.violations[0].url, "https://a.com");
  });
});
