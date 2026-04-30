import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLancamentoUrls,
  validateLancamentos,
} from "../scripts/validate-lancamentos.ts";

describe("extractLancamentoUrls", () => {
  it("captura URLs dentro da seção LANÇAMENTOS", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://outside-section.com/x",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item 1",
      "https://openai.com/index/x",
      "",
      "Item 2",
      "https://blog.google/y",
      "",
      "---",
      "",
      "PESQUISAS",
      "https://arxiv.org/abs/2501",
    ].join("\n");

    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 2);
    assert.equal(urls[0].url, "https://openai.com/index/x");
    assert.equal(urls[1].url, "https://blog.google/y");
  });

  it("ignora URLs fora da seção (DESTAQUE / PESQUISAS / OUTRAS NOTÍCIAS)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://destaque.com/x",
      "",
      "---",
      "",
      "PESQUISAS",
      "https://arxiv.org/abs/x",
    ].join("\n");

    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 0);
  });

  it("limpa pontuação trailing das URLs", () => {
    const md = [
      "LANÇAMENTOS",
      "Item",
      "Veja em https://openai.com/x.",
    ].join("\n");

    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].url, "https://openai.com/x");
  });

  it("seção LANCAMENTOS sem cedilha também funciona", () => {
    const md = ["LANCAMENTOS", "https://openai.com/x"].join("\n");
    const urls = extractLancamentoUrls(md);
    assert.equal(urls.length, 1);
  });
});

describe("validateLancamentos", () => {
  it("status ok quando todas URLs são oficiais", () => {
    const md = [
      "LANÇAMENTOS",
      "Item 1",
      "https://openai.com/index/gpt-5",
      "",
      "Item 2",
      "https://blog.google/technology/gemini-update",
    ].join("\n");

    const r = validateLancamentos(md);
    assert.equal(r.status, "ok");
    assert.equal(r.lancamento_count, 2);
    assert.equal(r.invalid_urls.length, 0);
  });

  it("status error quando há URL não-oficial (TechCrunch, blog pessoal)", () => {
    const md = [
      "LANÇAMENTOS",
      "GPT-5.5 chega",
      "https://openai.com/index/gpt-5-5",
      "",
      "Análise do Simon",
      "https://simonwillison.net/2026/Apr/25/gpt-5-5/",
      "",
      "Anthropic marketplace",
      "https://techcrunch.com/2026/04/25/anthropic-marketplace/",
    ].join("\n");

    const r = validateLancamentos(md);
    assert.equal(r.status, "error");
    assert.equal(r.lancamento_count, 3);
    assert.equal(r.invalid_urls.length, 2);
    assert.ok(r.invalid_urls.some((u) => u.url.includes("simonwillison.net")));
    assert.ok(r.invalid_urls.some((u) => u.url.includes("techcrunch.com")));
  });

  it("seção LANÇAMENTOS vazia passa ok", () => {
    const md = ["LANÇAMENTOS", "", "---"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.status, "ok");
    assert.equal(r.lancamento_count, 0);
  });

  it("MD sem seção LANÇAMENTOS passa ok", () => {
    const md = ["DESTAQUE 1 | PRODUTO", "https://openai.com/x"].join("\n");
    const r = validateLancamentos(md);
    assert.equal(r.status, "ok");
    assert.equal(r.lancamento_count, 0);
  });

  it("dedup URL repetida (markdown link [url](url) duplica a URL no source)", () => {
    const md = [
      "LANÇAMENTOS",
      "Item",
      "[https://openai.com/index/x](https://openai.com/index/x)",
    ].join("\n");
    const r = validateLancamentos(md);
    // Mesma URL aparece 2x no markdown link mas conta como 1
    assert.equal(r.lancamento_count, 1);
    assert.equal(r.status, "ok");
  });
});
