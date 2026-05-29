import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unescapeMarkdown } from "../scripts/lib/markdown-unescape.ts";

/**
 * Tests pra unescapeMarkdown (#1188).
 *
 * Cobertura:
 *   - Escapes observados na edição 260513 (hashtag, underscore, autolink)
 *   - Edge cases: \\ literal, [text](url) com text != url, conteúdo sem escapes
 *   - Newlines preservados
 *   - Idempotência: chamar 2× produz mesmo resultado
 */

describe("unescapeMarkdown — casos reais da edição 260513", () => {
  it("desfaz hashtag escapada: \\# → #", () => {
    const input = "\\#InteligenciaArtificial \\#Brasil \\#Startups";
    const expected = "#InteligenciaArtificial #Brasil #Startups";
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("desfaz underscore escapado: comment\\_diaria → comment_diaria", () => {
    const input = "### comment\\_diaria\n\nEdição completa em {edition\\_url}";
    const expected = "### comment_diaria\n\nEdição completa em {edition_url}";
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("colapsa autolink: [https://diar.ia.br](https://diar.ia.br) → https://diar.ia.br", () => {
    const input = "Receba notícias em [https://diar.ia.br](https://diar.ia.br).";
    const expected = "Receba notícias em https://diar.ia.br.";
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("combina vários escapes no mesmo input", () => {
    const input =
      "\\#InteligenciaArtificial\n### comment\\_pixel\n\nVisite [https://x.com](https://x.com)";
    const expected =
      "#InteligenciaArtificial\n### comment_pixel\n\nVisite https://x.com";
    assert.equal(unescapeMarkdown(input), expected);
  });
});

describe("unescapeMarkdown — chars escapados canônicos", () => {
  const cases: Array<[string, string, string]> = [
    ["backtick", "\\`code\\`", "`code`"],
    ["asterisco", "\\*bold\\*", "*bold*"],
    ["underscore", "\\_italic\\_", "_italic_"],
    ["chaves", "\\{var\\}", "{var}"],
    ["colchetes", "\\[link\\]", "[link]"],
    ["parênteses", "\\(text\\)", "(text)"],
    ["hashtag", "\\# heading", "# heading"],
    ["plus", "\\+ item", "+ item"],
    ["hífen", "\\- list", "- list"],
    ["ponto", "1\\. item", "1. item"],
    ["exclamação", "\\!important", "!important"],
    ["pipe", "col\\|col", "col|col"],
    ["blockquote", "\\> quote", "> quote"],
  ];

  for (const [label, input, expected] of cases) {
    it(`desescapa ${label}`, () => {
      assert.equal(unescapeMarkdown(input), expected);
    });
  }
});

describe("unescapeMarkdown — edge cases", () => {
  it("preserva [text](url) quando text !== url (link real)", () => {
    const input = "Veja o [post original](https://example.com/post-x).";
    assert.equal(unescapeMarkdown(input), input);
  });

  it("preserva conteúdo sem escapes (no-op)", () => {
    const input = "Texto normal sem nada especial.\n\nOutro parágrafo.";
    assert.equal(unescapeMarkdown(input), input);
  });

  it("preserva newlines (não normaliza whitespace)", () => {
    const input = "linha 1\n\nlinha 2\n\\#linha 3";
    const expected = "linha 1\n\nlinha 2\n#linha 3";
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("idempotente: aplicar 2× produz mesmo resultado", () => {
    const input = "\\#tag\\_test [https://x.com](https://x.com)";
    const once = unescapeMarkdown(input);
    const twice = unescapeMarkdown(once);
    assert.equal(twice, once);
  });

  it("string vazia retorna vazia", () => {
    assert.equal(unescapeMarkdown(""), "");
  });

  it("não desescapa chars fora da lista canônica (\\X → \\X)", () => {
    // \\a, \\b, \\z não são markdown-significativos — preservar literal.
    const input = "path\\foo\\bar";
    assert.equal(unescapeMarkdown(input), input);
  });

  it("dupla backslash + canon: \\\\# → \\# (documenta trade-off, ver source comment)", () => {
    // Input `\\#` (literal backslash + escaped hashtag). Regex matcheia o segundo
    // pair `\#` → `#`, deixando primeira backslash sozinha. Resultado `\#`.
    // Em prática o pipeline não gera `\\#` source, então isso é informativo.
    const input = "\\\\#tag";
    const expected = "\\#tag";
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("autolink multi-linha: [text\\n](url) NÃO bate (proteção)", () => {
    // Regex AUTOLINK_RE exclui \n no character class — links não atravessam linhas.
    const input = "[texto\nquebrado](url)";
    assert.equal(unescapeMarkdown(input), input);
  });
});

describe("unescapeMarkdown — bold-link nesting flip (#1582)", () => {
  it("normaliza [**Title**](url) → **[Title](url)** (Drive roundtrip flip)", () => {
    const input = "[**Modelos se replicam sozinhos**](https://theguardian.com/x)";
    const expected = "**[Modelos se replicam sozinhos](https://theguardian.com/x)**";
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("preserva **[Title](url)** quando já no formato canônico (no-op)", () => {
    const input = "**[Título canônico](https://example.com)**";
    assert.equal(unescapeMarkdown(input), input);
  });

  it("não toca [Title](url) sem bold dentro", () => {
    const input = "[Texto plain](https://example.com)";
    assert.equal(unescapeMarkdown(input), input);
  });

  it("não toca quando bold só de um lado dentro: [**Title](url) preserva", () => {
    const input = "[**Title sem fechar](https://example.com)";
    assert.equal(unescapeMarkdown(input), input);
  });

  it("idempotente: 2x não duplica os asteriscos", () => {
    const input = "[**Título**](https://example.com)";
    const once = unescapeMarkdown(input);
    const twice = unescapeMarkdown(once);
    assert.equal(twice, once);
    assert.equal(once, "**[Título](https://example.com)**");
  });

  it("múltiplos items na mesma string normalizam todos", () => {
    const input = [
      "[**Item 1**](https://a.com) desc 1",
      "[**Item 2**](https://b.com) desc 2",
    ].join("\n");
    const expected = [
      "**[Item 1](https://a.com)** desc 1",
      "**[Item 2](https://b.com)** desc 2",
    ].join("\n");
    assert.equal(unescapeMarkdown(input), expected);
  });

  it("não toca em emoji prefix [📰 …](…) — não tem ** dentro", () => {
    const input = "[📰 Section](https://example.com)";
    assert.equal(unescapeMarkdown(input), input);
  });
});

describe("unescapeMarkdown — caso real edição 260513 (snippet integral)", () => {
  it("desescapa bloco LinkedIn completo", () => {
    const input = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Foo bar baz.",
      "",
      "\\#InteligenciaArtificial \\#Brasil \\#Startups",
      "",
      "### comment\\_diaria",
      "",
      "Edição em {edition\\_url}",
      "",
      "Receba em diar.ia.br",
    ].join("\n");

    const expected = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Foo bar baz.",
      "",
      "#InteligenciaArtificial #Brasil #Startups",
      "",
      "### comment_diaria",
      "",
      "Edição em {edition_url}",
      "",
      "Receba em diar.ia.br",
    ].join("\n");

    assert.equal(unescapeMarkdown(input), expected);
  });
});
