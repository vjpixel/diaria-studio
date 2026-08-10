import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  isOkRun,
  flattenRunRecords,
  type RunRecordLike,
} from "../scripts/assemble-research-pool.ts";

const ROOT = resolve(import.meta.dirname, "..");
const TMP_DIR = resolve(ROOT, ".tmp-test-assemble-research-pool");

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("isOkRun", () => {
  it("aceita outcome ok/empty", () => {
    assert.equal(isOkRun({ source: "x", outcome: "ok" }), true);
    assert.equal(isOkRun({ source: "x", outcome: "empty" }), true);
  });

  it("rejeita outcome fail/timeout", () => {
    assert.equal(isOkRun({ source: "x", outcome: "fail" }), false);
    assert.equal(isOkRun({ source: "x", outcome: "timeout" }), false);
  });

  it("cai pro campo status quando outcome ausente (shape cru dos agents Haiku)", () => {
    assert.equal(isOkRun({ source: "x", status: "ok" }), true);
    assert.equal(isOkRun({ source: "x", status: "fail" }), false);
  });

  it("sem outcome nem status: false", () => {
    assert.equal(isOkRun({ source: "x" }), false);
  });
});

describe("flattenRunRecords — #4955 regressão: summary sobrevive verbatim", () => {
  it("preserva TODOS os campos do artigo, inclusive summary, sem reconstrução", () => {
    const runs: RunRecordLike[] = [
      {
        source: "MIT Technology Review",
        outcome: "ok",
        articles: [
          {
            title: "Título real",
            url: "https://example.com/a",
            published_at: "2026-08-10",
            author: "Fulano",
            summary: "Resumo não-vazio em PT-BR.",
            type_hint: "noticia",
          },
        ],
      },
    ];

    const pool = flattenRunRecords(runs);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].url, "https://example.com/a");
    assert.equal(
      pool[0].summary,
      "Resumo não-vazio em PT-BR.",
      "summary deve sobreviver intacto do RunRecord até o pool — regressão do #4955",
    );
    assert.equal(pool[0].title, "Título real");
    assert.equal(pool[0].author, "Fulano");
    assert.equal(pool[0].type_hint, "noticia");
    assert.equal(pool[0].source, "MIT Technology Review");
  });

  it("injeta source do RunRecord quando o artigo não já tiver o seu (Path B / agents Haiku)", () => {
    const runs: RunRecordLike[] = [
      {
        source: "discovery:ai-regulation-brazil",
        outcome: "ok",
        articles: [{ url: "https://example.com/b", title: "B", summary: "resumo b" }],
      },
    ];
    const pool = flattenRunRecords(runs);
    assert.equal(pool[0].source, "discovery:ai-regulation-brazil");
  });

  it("preserva source já presente no artigo (Path A / Brave) em vez de sobrescrever", () => {
    const runs: RunRecordLike[] = [
      {
        source: "discovery:ai-regulation-brazil",
        outcome: "ok",
        articles: [
          {
            url: "https://example.com/c",
            title: "C",
            summary: "resumo c",
            source: "discovery:ai-regulation-brazil",
            discovered_source: true,
          },
        ],
      },
    ];
    const pool = flattenRunRecords(runs);
    assert.equal(pool[0].source, "discovery:ai-regulation-brazil");
    assert.equal(pool[0].discovered_source, true);
  });

  it("exclui artigos de runs com outcome fail/timeout", () => {
    const runs: RunRecordLike[] = [
      {
        source: "Fonte quebrada",
        outcome: "fail",
        reason: "timeout",
        articles: [{ url: "https://example.com/never", summary: "não deveria aparecer" }],
      } as RunRecordLike,
    ];
    assert.equal(flattenRunRecords(runs).length, 0);
  });

  it("tolera articles ausente/null e artigos sem url (defensive)", () => {
    const runs: RunRecordLike[] = [
      { source: "x", outcome: "ok" },
      { source: "y", outcome: "ok", articles: null },
      { source: "z", outcome: "ok", articles: [{ title: "sem url" } as Record<string, unknown>] },
    ];
    assert.equal(flattenRunRecords(runs).length, 0);
  });
});

// ---------------------------------------------------------------------------
// CLI round-trip
// ---------------------------------------------------------------------------

describe("assemble-research-pool.ts CLI", () => {
  beforeEach(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("escreve tmp-articles-raw.json com summary intacto ponta-a-ponta a partir de researcher-results.json", () => {
    const runsPath = resolve(TMP_DIR, "researcher-results.json");
    const outPath = resolve(TMP_DIR, "tmp-articles-raw.json");

    const researcherResults = [
      {
        source: "MIT Technology Review",
        outcome: "ok",
        duration_ms: 4500,
        query_used: "site:technologyreview.com",
        articles: [
          {
            title: "Novo modelo de IA anunciado",
            url: "https://technologyreview.com/artigo-1",
            published_at: "2026-08-10",
            author: "Jane Doe",
            summary: "Resumo do artigo em 1-2 frases, sem hype.",
            type_hint: "noticia",
          },
        ],
      },
      {
        source: "discovery:regulacao-ia-brasil",
        outcome: "ok",
        duration_ms: 8000,
        query_used: "regulação IA Brasil",
        articles: [
          {
            url: "https://exemplo.com.br/regulacao",
            title: "Projeto de lei avança",
            summary: "Resumo da descoberta.",
          },
        ],
      },
      {
        source: "Tecnoblog (IA)",
        outcome: "fail",
        duration_ms: 2000,
        reason: "fetch_error",
        articles: [],
      },
    ];
    writeFileSync(runsPath, JSON.stringify(researcherResults), "utf8");

    const result = execSync(
      `npx tsx scripts/assemble-research-pool.ts --runs "${runsPath}" --out "${outPath}"`,
      { cwd: ROOT, encoding: "utf8" },
    );
    const output = JSON.parse(result.trim());
    assert.equal(output.runs_total, 3);
    assert.equal(output.runs_ok, 2);
    assert.equal(output.articles_from_runs, 2);
    assert.equal(output.injected, 2);
    assert.equal(output.total_pool_size, 2);

    const pool = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(pool.length, 2);

    const article1 = pool.find((a: { url: string }) => a.url === "https://technologyreview.com/artigo-1");
    assert.ok(article1, "artigo do RunRecord ok deve estar no pool");
    assert.equal(
      article1.summary,
      "Resumo do artigo em 1-2 frases, sem hype.",
      "#4955: summary deve sobreviver de researcher-results.json até tmp-articles-raw.json",
    );
    assert.equal(article1.source, "MIT Technology Review");

    const article2 = pool.find((a: { url: string }) => a.url === "https://exemplo.com.br/regulacao");
    assert.ok(article2, "artigo de discovery deve estar no pool");
    assert.equal(article2.summary, "Resumo da descoberta.");
    assert.equal(article2.source, "discovery:regulacao-ia-brasil", "source injetado do RunRecord");

    const brokenUrls = pool.map((a: { url: string }) => a.url);
    assert.ok(!brokenUrls.includes(undefined), "sem artigos do run que falhou");
  });

  it("merge-safe: preserva pool existente (ex: já com carry-over/inbox) e só anexa novos", () => {
    const runsPath = resolve(TMP_DIR, "researcher-results.json");
    const outPath = resolve(TMP_DIR, "tmp-articles-raw.json");

    writeFileSync(
      outPath,
      JSON.stringify([{ url: "https://already-here.com/x", summary: "já estava no pool", flag: "carry_over" }]),
      "utf8",
    );
    writeFileSync(
      runsPath,
      JSON.stringify([
        {
          source: "Fonte X",
          outcome: "ok",
          articles: [{ url: "https://novo.com/y", summary: "novo artigo" }],
        },
      ]),
      "utf8",
    );

    const result = execSync(
      `npx tsx scripts/assemble-research-pool.ts --runs "${runsPath}" --out "${outPath}"`,
      { cwd: ROOT, encoding: "utf8" },
    );
    const output = JSON.parse(result.trim());
    assert.equal(output.injected, 1);
    assert.equal(output.total_pool_size, 2);

    const pool = JSON.parse(readFileSync(outPath, "utf8"));
    const urls = pool.map((a: { url: string }) => a.url);
    assert.ok(urls.includes("https://already-here.com/x"), "entry pré-existente preservada");
    assert.ok(urls.includes("https://novo.com/y"), "entry nova anexada");
    const existing = pool.find((a: { url: string }) => a.url === "https://already-here.com/x");
    assert.equal(existing.summary, "já estava no pool", "entry pré-existente não sobrescrita");
  });
});
