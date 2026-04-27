import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitConcatenatedHighlightHeader,
  splitConcatenatedSectionItem,
  normalizeNewsletter,
} from "../scripts/normalize-newsletter.ts";

describe("splitConcatenatedHighlightHeader", () => {
  it("quebra header + 3 títulos colados", () => {
    const line =
      "DESTAQUE 1 | GEOPOLÍTICA Brasil entra no jogo dos pacotes de IA dos EUA EUA oferecem pacote de IA ao Brasil para barrar China Pacotes de IA dos EUA colocam Brasil no centro";
    const r = splitConcatenatedHighlightHeader(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 4);
    assert.equal(r.lines[0], "DESTAQUE 1 | GEOPOLÍTICA");
    // Cada título tem comprimento razoável
    for (let i = 1; i <= 3; i++) {
      assert.ok(r.lines[i].length > 5);
      assert.ok(r.lines[i].length <= 70);
    }
  });

  it("header válido (apenas 1 linha) passa intacto", () => {
    const line = "DESTAQUE 2 | PRODUTO";
    const r = splitConcatenatedHighlightHeader(line);
    assert.equal(r.split, false);
    assert.deepEqual(r.lines, [line]);
  });

  it("linha que não é header de destaque passa intacta", () => {
    const line = "Algum título qualquer";
    const r = splitConcatenatedHighlightHeader(line);
    assert.equal(r.split, false);
  });
});

describe("splitConcatenatedSectionItem", () => {
  it("quebra item legacy com markdown link [url](url) no fim → ordem nova (#172)", () => {
    const line =
      "GPT-5.5 chega com Codex Superapp. OpenAI publica System Card e abre Codex como app standalone. [https://openai.com/index/introducing-gpt-5-5](https://openai.com/index/introducing-gpt-5-5)";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 3);
    assert.equal(r.lines[0], "GPT-5.5 chega com Codex Superapp.");
    // Pós-#172: URL na linha 2 (entre título e descrição)
    assert.equal(r.lines[1], "https://openai.com/index/introducing-gpt-5-5");
    assert.equal(
      r.lines[2],
      "OpenAI publica System Card e abre Codex como app standalone.",
    );
  });

  it("quebra item legacy com bare URL no fim → ordem nova (#172)", () => {
    const line =
      "Anthropic abre marketplace. Plataforma permite agentes negociarem. https://techcrunch.com/anthropic-marketplace";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 3);
    assert.equal(r.lines[0], "Anthropic abre marketplace.");
    assert.equal(r.lines[1], "https://techcrunch.com/anthropic-marketplace");
    assert.equal(r.lines[2], "Plataforma permite agentes negociarem.");
  });

  it("quebra item novo com URL no meio (#172) → ordem nova", () => {
    // LLM colapsou na ordem nova: título + URL + descrição em 1 linha
    const line =
      "GPT-5.5 chega com Codex Superapp https://openai.com/x OpenAI publica o System Card e abre Codex como app.";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 3);
    assert.equal(r.lines[0], "GPT-5.5 chega com Codex Superapp");
    assert.equal(r.lines[1], "https://openai.com/x");
    assert.equal(
      r.lines[2],
      "OpenAI publica o System Card e abre Codex como app.",
    );
  });

  it("sem ponto pra separar título/descrição: 2 linhas + warning", () => {
    const line =
      "Título sem pontuação clara https://example.com";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 2);
    assert.ok(r.warning);
  });

  it("linha sem URL passa intacta", () => {
    const line = "Apenas um título normal sem link";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, false);
  });
});

describe("normalizeNewsletter — integração", () => {
  it("normaliza newsletter com bug nos destaques + seção (caso real 260426)", () => {
    const input = [
      "DESTAQUE 1 | GEOPOLÍTICA Brasil entra no jogo dos pacotes de IA dos EUA EUA oferecem pacote de IA ao Brasil para barrar China Pacotes de IA dos EUA colocam Brasil no centro",
      "",
      "Parágrafo do destaque normal.",
      "",
      "https://example.com/destaque-1",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "GPT-5.5 chega. OpenAI publica System Card. https://openai.com/x",
      "",
      "DeepSeek v4 lançado. Modelo open-source. https://hf.co/deepseek",
      "",
      "---",
    ].join("\n");

    const r = normalizeNewsletter(input);
    assert.equal(r.report.highlight_headers_split, 1);
    assert.equal(r.report.section_items_split, 2);

    const lines = r.text.split("\n");
    // Header destaque agora em 4 linhas
    assert.equal(lines[0], "DESTAQUE 1 | GEOPOLÍTICA");
    assert.ok(lines[1].length > 5); // título 1
    assert.ok(lines[2].length > 5); // título 2
    assert.ok(lines[3].length > 5); // título 3

    // Itens de seção quebrados
    assert.ok(r.text.includes("https://openai.com/x\n"));
    assert.ok(r.text.includes("https://hf.co/deepseek"));
  });

  it("newsletter já bem formatada (ordem nova #172) passa sem mudanças", () => {
    const input = [
      "DESTAQUE 1 | PRODUTO",
      "Título único",
      "https://example.com/x",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item título",
      "https://example.com/item",
      "Item descrição.",
    ].join("\n");

    const r = normalizeNewsletter(input);
    assert.equal(r.report.highlight_headers_split, 0);
    assert.equal(r.report.section_items_split, 0);
    assert.equal(r.text, input);
  });

  it("URL no meio do parágrafo de destaque NÃO é tocada", () => {
    const input = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "",
      "Corpo com link inline https://example.com/x no meio.",
      "",
      "---",
    ].join("\n");

    const r = normalizeNewsletter(input);
    // Não estamos em seção, então não tenta split
    assert.equal(r.report.section_items_split, 0);
    assert.ok(r.text.includes("link inline https://example.com/x no meio."));
  });
});
