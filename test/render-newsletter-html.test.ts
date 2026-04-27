import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseListItems, parseSections } from "../scripts/render-newsletter-html.ts";

describe("parseListItems (#172)", () => {
  it("formato novo: Título / URL / Descrição", () => {
    const text = [
      "Item Um",
      "https://example.com/1",
      "Descrição do item um.",
      "",
      "Item Dois",
      "https://example.com/2",
      "Descrição do item dois.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Item Um");
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[0].description, "Descrição do item um.");
    assert.equal(items[1].title, "Item Dois");
    assert.equal(items[1].url, "https://example.com/2");
    assert.equal(items[1].description, "Descrição do item dois.");
  });

  it("formato legacy: Título / Descrição / URL (compat)", () => {
    const text = [
      "Item Um",
      "Descrição do item um.",
      "https://example.com/1",
      "",
      "Item Dois",
      "Descrição do item dois.",
      "https://example.com/2",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Item Um");
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[0].description, "Descrição do item um.");
    assert.equal(items[1].title, "Item Dois");
    assert.equal(items[1].url, "https://example.com/2");
    assert.equal(items[1].description, "Descrição do item dois.");
  });

  it("item sem descrição (formato novo, só título + URL)", () => {
    const text = [
      "Item curto",
      "https://example.com/x",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Item curto");
    assert.equal(items[0].url, "https://example.com/x");
    assert.equal(items[0].description, "");
  });

  it("item sem URL: descrição vazia, URL vazio", () => {
    const text = [
      "Título sem link",
      "Descrição sem link.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Título sem link");
    assert.equal(items[0].url, "");
    assert.equal(items[0].description, "Descrição sem link.");
  });

  it("descrição em múltiplas linhas é concatenada com espaço", () => {
    const text = [
      "Título",
      "https://example.com/x",
      "Linha 1 da descrição.",
      "Linha 2 da descrição.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 1);
    assert.equal(
      items[0].description,
      "Linha 1 da descrição. Linha 2 da descrição.",
    );
  });

  it("M1: 2 items colapsados num único bloco (sem blank) viram 2 items", () => {
    const text = [
      "Item Um",
      "https://example.com/1",
      "Descrição do item um.",
      "Item Dois",
      "https://example.com/2",
      "Descrição do item dois.",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Item Um");
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[1].title, "Item Dois");
    assert.equal(items[1].url, "https://example.com/2");
  });

  it("M1: 3 items legacy colapsados (Título/Desc/URL × 3 sem blanks)", () => {
    const text = [
      "Item Um",
      "Descrição um.",
      "https://example.com/1",
      "Item Dois",
      "Descrição dois.",
      "https://example.com/2",
    ].join("\n");
    const items = parseListItems(text);
    assert.equal(items.length, 2);
    assert.equal(items[0].url, "https://example.com/1");
    assert.equal(items[1].url, "https://example.com/2");
  });
});

describe("parseSections (#172)", () => {
  it("parseia múltiplas seções com formato novo", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título d1",
      "https://destaque.com/d1",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item lançamento",
      "https://lancamento.com/x",
      "Descrição do lançamento.",
      "",
      "---",
      "",
      "PESQUISAS",
      "Paper interessante",
      "https://arxiv.org/abs/1234.5678",
      "Resumo da pesquisa.",
      "",
      "---",
      "",
      "OUTRAS NOTÍCIAS",
      "Notícia genérica",
      "https://news.com/x",
      "Resumo da notícia.",
    ].join("\n");

    const sections = parseSections(md);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].name, "LANÇAMENTOS");
    assert.equal(sections[0].items.length, 1);
    assert.equal(sections[0].items[0].title, "Item lançamento");
    assert.equal(sections[0].items[0].url, "https://lancamento.com/x");
    assert.equal(sections[0].items[0].description, "Descrição do lançamento.");
    assert.equal(sections[1].name, "PESQUISAS");
    assert.equal(sections[2].name, "OUTRAS NOTÍCIAS");
  });
});
