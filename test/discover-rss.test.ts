import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Papa from "papaparse";
import {
  generateCandidates,
  extractFeedsFromHtml,
  shouldSkipHost,
} from "../scripts/discover-rss.ts";

describe("generateCandidates", () => {
  it("gera candidatos a partir de URL com path (tag/categoria)", () => {
    const c = generateCandidates(
      "https://canaltech.com.br/inteligencia-artificial/",
    );
    assert.ok(c.includes("https://canaltech.com.br/inteligencia-artificial/feed"));
    assert.ok(c.includes("https://canaltech.com.br/inteligencia-artificial/feed/"));
    assert.ok(c.includes("https://canaltech.com.br/feed"));
    assert.ok(c.includes("https://canaltech.com.br/feed/"));
  });

  it("gera candidatos a partir de URL apenas com origin", () => {
    const c = generateCandidates("https://example.com/");
    assert.ok(c.includes("https://example.com/feed"));
    assert.ok(c.includes("https://example.com/atom.xml"));
    assert.ok(c.includes("https://example.com/index.xml"));
  });

  it("ordena tag-page candidates antes de origin candidates", () => {
    const c = generateCandidates(
      "https://exame.com/inteligencia-artificial/",
    );
    const tagFeedIdx = c.indexOf("https://exame.com/inteligencia-artificial/feed");
    const originFeedIdx = c.indexOf("https://exame.com/feed");
    assert.ok(tagFeedIdx !== -1);
    assert.ok(originFeedIdx !== -1);
    assert.ok(
      tagFeedIdx < originFeedIdx,
      "tag-page candidates devem vir antes de origin candidates",
    );
  });

  it("URL inválida → array vazio", () => {
    assert.deepEqual(generateCandidates("not-a-url"), []);
  });

  it("dedup preserva ordem", () => {
    const c = generateCandidates("https://example.com/");
    assert.equal(new Set(c).size, c.length, "sem duplicatas");
  });
});

describe("extractFeedsFromHtml", () => {
  it("extrai feed RSS announced via <link rel=alternate>", () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Feed">
      </head></html>
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/blog/");
    assert.deepEqual(feeds, ["https://example.com/feed.xml"]);
  });

  it("extrai feed Atom também", () => {
    const html = `
      <link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.deepEqual(feeds, ["https://example.com/atom.xml"]);
  });

  it("extrai múltiplos feeds (RSS + Atom + per-category)", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/feed">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="/category/ai/feed">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.equal(feeds.length, 3);
    assert.ok(feeds.includes("https://example.com/feed"));
    assert.ok(feeds.includes("https://example.com/atom.xml"));
    assert.ok(feeds.includes("https://example.com/category/ai/feed"));
  });

  it("ignora links que não são feed (rel=stylesheet etc)", () => {
    const html = `
      <link rel="stylesheet" type="text/css" href="/style.css">
      <link rel="canonical" href="/page">
    `;
    assert.deepEqual(extractFeedsFromHtml(html, "https://example.com/"), []);
  });

  it("ignora <link> sem href", () => {
    const html = `<link rel="alternate" type="application/rss+xml">`;
    assert.deepEqual(extractFeedsFromHtml(html, "https://example.com/"), []);
  });

  it("href absoluto é preservado", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="https://feeds.feedburner.com/example">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.deepEqual(feeds, ["https://feeds.feedburner.com/example"]);
  });

  it("dedup feeds duplicados", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/feed">
      <link rel="alternate" type="application/rss+xml" href="/feed">
    `;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.equal(feeds.length, 1);
  });

  it("atributos em ordem inversa funciona (href antes de rel)", () => {
    const html = `<link href="/feed.xml" type="application/rss+xml" rel="alternate">`;
    const feeds = extractFeedsFromHtml(html, "https://example.com/");
    assert.deepEqual(feeds, ["https://example.com/feed.xml"]);
  });
});

describe("shouldSkipHost", () => {
  it("pula twitter/x/linkedin/instagram/facebook/tiktok", () => {
    for (const url of [
      "https://twitter.com/user",
      "https://x.com/user",
      "https://www.linkedin.com/company/x/",
      "https://instagram.com/x",
      "https://facebook.com/x",
      "https://tiktok.com/@x",
    ]) {
      assert.equal(shouldSkipHost(url), true, `should skip ${url}`);
    }
  });

  it("não pula domínios normais", () => {
    for (const url of [
      "https://canaltech.com.br/",
      "https://exame.com/",
      "https://anthropic.com/news/",
    ]) {
      assert.equal(shouldSkipHost(url), false);
    }
  });

  it("URL inválida → skip (defensivo)", () => {
    assert.equal(shouldSkipHost("not-a-url"), true);
  });
});

// ─── Regressão #2241: Papa.unparse deve preservar TODAS as colunas ────────────
//
// Bug: Papa.unparse era chamado com columns: ["Nome","Tipo","URL","RSS"] — lista
// hardcoded de 4 colunas que descartava topic_filter, use_melhor, low_cadence (e
// quaisquer colunas futuras) de todas as linhas. Fix: derivar as colunas do header
// real do CSV parseado.
//
// Este teste valida a invariante via round-trip direto do Papa.parse→unparse:
// parse um CSV com colunas extras, simula o unparse usando os campos reais,
// e garante que NENHUMA coluna seja descartada — incluindo futuras colunas
// adicionadas ao CSV que não conhecemos hoje.

describe("Papa.unparse round-trip: preserva todas as colunas (#2241)", () => {
  it("round-trip parse→unparse preserva todas as colunas e valores com colunas extras", () => {
    // Simula seed/sources.csv com 7 colunas (igual ao real: Nome,Tipo,URL,RSS,topic_filter,use_melhor,low_cadence)
    const csvInput = [
      "Nome,Tipo,URL,RSS,topic_filter,use_melhor,low_cadence",
      'Fonte A,Brasil,https://a.com/,https://a.com/feed,"AI,IA",,',
      'Fonte B,Internacional,https://b.com/,,,"true",low',
    ].join("\n");

    const parsed = Papa.parse<Record<string, string>>(csvInput, {
      header: true,
      skipEmptyLines: true,
    });
    assert.equal(parsed.errors.length, 0, "CSV sem erros de parse");

    // Fix: usar os campos reais do CSV, não uma lista hardcoded.
    const allColumns = parsed.meta.fields ?? Object.keys(parsed.data[0] ?? {});

    // Verificar que TODAS as colunas do input estão presentes (inclui extras)
    const expectedColumns = ["Nome", "Tipo", "URL", "RSS", "topic_filter", "use_melhor", "low_cadence"];
    for (const col of expectedColumns) {
      assert.ok(allColumns.includes(col), `coluna "${col}" deve estar em allColumns`);
    }

    const unparsed = Papa.unparse(parsed.data, { columns: allColumns, newline: "\n" });

    // Re-parseia o output para comparação estrutural
    const reparsed = Papa.parse<Record<string, string>>(unparsed, {
      header: true,
      skipEmptyLines: true,
    });

    // Todas as colunas preservadas no header
    for (const col of expectedColumns) {
      assert.ok(
        reparsed.meta.fields?.includes(col),
        `coluna "${col}" deve estar no output do unparse`,
      );
    }

    // Valores preservados para todas as colunas de cada row
    assert.equal(reparsed.data.length, 2, "2 linhas de dados preservadas");
    assert.equal(reparsed.data[0]["Nome"], "Fonte A");
    assert.equal(reparsed.data[0]["topic_filter"], "AI,IA");
    assert.equal(reparsed.data[0]["use_melhor"], "");
    assert.equal(reparsed.data[0]["low_cadence"], "");
    assert.equal(reparsed.data[1]["Nome"], "Fonte B");
    assert.equal(reparsed.data[1]["topic_filter"], "");
    assert.equal(reparsed.data[1]["use_melhor"], "true");
    assert.equal(reparsed.data[1]["low_cadence"], "low");
  });

  it("round-trip com coluna desconhecida futura também é preservada", () => {
    // Garante que colunas adicionadas no futuro ao sources.csv não sejam
    // descartadas — a invariante é: ALL columns, not a known set.
    const csvInput = [
      "Nome,Tipo,URL,RSS,topic_filter,use_melhor,low_cadence,nova_coluna_futura",
      'Fonte Z,Brasil,https://z.com/,https://z.com/feed,"AI",,,valor_futuro',
    ].join("\n");

    const parsed = Papa.parse<Record<string, string>>(csvInput, {
      header: true,
      skipEmptyLines: true,
    });
    const allColumns = parsed.meta.fields ?? Object.keys(parsed.data[0] ?? {});
    assert.ok(allColumns.includes("nova_coluna_futura"), "coluna futura detectada do header");

    const unparsed = Papa.unparse(parsed.data, { columns: allColumns, newline: "\n" });
    const reparsed = Papa.parse<Record<string, string>>(unparsed, { header: true, skipEmptyLines: true });

    assert.ok(
      reparsed.meta.fields?.includes("nova_coluna_futura"),
      "coluna futura preservada no output",
    );
    assert.equal(reparsed.data[0]["nova_coluna_futura"], "valor_futuro");
  });
});
