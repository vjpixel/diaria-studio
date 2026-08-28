/**
 * test/highlight-block-edit-6447.test.ts (#6447 Fatia 2)
 *
 * Cobertura do parser/serializer puro de `scripts/lib/lint-checks/highlight-block-edit.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHighlightBlocks,
  applyHighlightEdit,
} from "../scripts/lib/lint-checks/highlight-block-edit.ts";

// Fixture realista, formato pós-#599 (URL embedada no título), 3 destaques —
// D1 com 3 opções de título (pré-gate), D2 já podado a 1 título + bloco
// "Aprofunde:", D3 mínimo (1 título, sem Aprofunde) — + seções secundárias
// pra garantir que a edição nunca vaza pra fora do bloco DESTAQUE tocado.
const FIXTURE = `Para esta edição, eu (o editor) enviei 2 submissões e a diar.ia.br encontrou outros 30 artigos. Selecionamos os 3 mais relevantes para as pessoas que assinam a newsletter.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Primeira opção de título](https://example.com/artigo-1)**

**[Segunda opção de título](https://example.com/artigo-1)**

**[Terceira opção de título](https://example.com/artigo-1)**

Parágrafo 1 do D1 abre a história.

Parágrafo 2 do D1 desenvolve contexto.

Por que isso importa:

Impacto prático do D1 para o público diar.ia.br.

---

**DESTAQUE 2 | 💼 MERCADO**

**[Título único já podado do D2](https://example.com/artigo-2)**

Parágrafo único do corpo do D2.

Por que isso importa:

Impacto prático do D2.

Aprofunde:

* [Outra fonte do cluster](https://example.com/artigo-2b) - Fonte B
* [Mais uma fonte](https://example.com/artigo-2c) - Fonte C

---

**DESTAQUE 3 | 🔬 PESQUISA**

**[Título do D3](https://example.com/artigo-3)**

Corpo único do D3.

Por que isso importa:

Impacto prático do D3.

---

**🚀 LANÇAMENTOS**

**[Ferramenta nova](https://example.com/ferramenta)**
Descrição curta da ferramenta.

---

**📡 RADAR**

**[Notícia do radar](https://example.com/radar-1)**
Descrição da notícia do radar.
`;

describe("parseHighlightBlocks (#6447 Fatia 2)", () => {
  it("extrai os 3 destaques com número, categoria, URL e parágrafos", () => {
    const { ok, blocks } = parseHighlightBlocks(FIXTURE);
    assert.equal(ok, true);
    assert.equal(blocks.length, 3);

    const d1 = blocks[0];
    assert.equal(d1.n, 1);
    assert.equal(d1.category, "🚀 LANÇAMENTO");
    assert.equal(d1.titleOptions.length, 3);
    assert.deepEqual(
      d1.titleOptions.map((t) => t.text),
      ["Primeira opção de título", "Segunda opção de título", "Terceira opção de título"],
    );
    assert.equal(d1.url, "https://example.com/artigo-1");
    assert.deepEqual(d1.body, ["Parágrafo 1 do D1 abre a história.", "Parágrafo 2 do D1 desenvolve contexto."]);
    assert.equal(d1.whyMatters, "Impacto prático do D1 para o público diar.ia.br.");
    assert.equal(d1.trailingRaw, "");
  });

  it("D2 já podado a 1 título tem titleOptions.length === 1", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d2 = blocks[1];
    assert.equal(d2.titleOptions.length, 1);
    assert.equal(d2.titleOptions[0].text, "Título único já podado do D2");
    assert.equal(d2.url, "https://example.com/artigo-2");
  });

  it("preserva o bloco 'Aprofunde:' como texto opaco (verbatim, com header)", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d2 = blocks[1];
    assert.match(d2.trailingRaw, /^Aprofunde:/);
    assert.match(d2.trailingRaw, /Outra fonte do cluster/);
    assert.match(d2.trailingRaw, /Mais uma fonte/);
  });

  it("D3 sem Aprofunde tem trailingRaw vazio", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d3 = blocks[2];
    assert.equal(d3.trailingRaw, "");
    assert.equal(d3.titleOptions.length, 1);
  });
});

describe("applyHighlightEdit (#6447 Fatia 2)", () => {
  it("3 títulos → seleciona 1: as outras 2 opções somem, resto do arquivo idêntico", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: "Segunda opção de título",
      url: d1.url,
      body: d1.body,
      whyMatters: d1.whyMatters,
    });
    assert.equal(result.ok, true);
    const md = result.md!;

    const { blocks: newBlocks } = parseHighlightBlocks(md);
    assert.equal(newBlocks[0].titleOptions.length, 1);
    assert.equal(newBlocks[0].titleOptions[0].text, "Segunda opção de título");

    // Resto do arquivo (D2, D3, seções secundárias) idêntico byte a byte —
    // localizamos o início de D2 em ambas as versões e comparamos o sufixo.
    const marker = "**DESTAQUE 2 | 💼 MERCADO**";
    assert.equal(md.slice(md.indexOf(marker)), FIXTURE.slice(FIXTURE.indexOf(marker)));
  });

  it("título único já podado: reescrever o texto não muda a contagem de opções", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d2 = blocks[1];
    const result = applyHighlightEdit(FIXTURE, 2, {
      title: "Título reescrito do D2",
      url: d2.url,
      body: d2.body,
      whyMatters: d2.whyMatters,
    });
    assert.equal(result.ok, true);
    const { blocks: newBlocks } = parseHighlightBlocks(result.md!);
    const newD2 = newBlocks[1];
    assert.equal(newD2.titleOptions.length, 1);
    assert.equal(newD2.titleOptions[0].text, "Título reescrito do D2");
  });

  it("URL mudada é refletida no link do título reconstruído", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d3 = blocks[2];
    const result = applyHighlightEdit(FIXTURE, 3, {
      title: d3.titleOptions[0].text,
      url: "https://example.com/artigo-3-atualizado",
      body: d3.body,
      whyMatters: d3.whyMatters,
    });
    assert.equal(result.ok, true);
    const { blocks: newBlocks } = parseHighlightBlocks(result.md!);
    assert.equal(newBlocks[2].url, "https://example.com/artigo-3-atualizado");
  });

  it("corpo com MAIS parágrafos que o original é refletido", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d3 = blocks[2];
    const result = applyHighlightEdit(FIXTURE, 3, {
      title: d3.titleOptions[0].text,
      url: d3.url,
      body: ["Primeiro parágrafo novo.", "Segundo parágrafo novo.", "Terceiro parágrafo novo."],
      whyMatters: d3.whyMatters,
    });
    assert.equal(result.ok, true);
    const { blocks: newBlocks } = parseHighlightBlocks(result.md!);
    assert.deepEqual(newBlocks[2].body, [
      "Primeiro parágrafo novo.",
      "Segundo parágrafo novo.",
      "Terceiro parágrafo novo.",
    ]);
  });

  it("corpo com MENOS parágrafos que o original é refletido", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: d1.titleOptions[0].text,
      url: d1.url,
      body: ["Parágrafo único consolidado."],
      whyMatters: d1.whyMatters,
    });
    assert.equal(result.ok, true);
    const { blocks: newBlocks } = parseHighlightBlocks(result.md!);
    assert.deepEqual(newBlocks[0].body, ["Parágrafo único consolidado."]);
  });

  it("'Aprofunde:' é preservado verbatim quando body/why/título mudam", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d2 = blocks[1];
    const originalTrailing = d2.trailingRaw;
    const result = applyHighlightEdit(FIXTURE, 2, {
      title: "Outro título pro D2",
      url: d2.url,
      body: ["Corpo totalmente reescrito."],
      whyMatters: "Novo texto de por que isso importa.",
    });
    assert.equal(result.ok, true);
    const { blocks: newBlocks } = parseHighlightBlocks(result.md!);
    assert.equal(newBlocks[1].trailingRaw, originalTrailing);
  });

  it("edição de D2 não toca nem 1 caractere fora do bloco de D2", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d2 = blocks[1];
    const result = applyHighlightEdit(FIXTURE, 2, {
      title: "Título completamente diferente",
      url: "https://example.com/nova-url-d2",
      body: ["Corpo reescrito.", "Segundo parágrafo novo."],
      whyMatters: "Why matters reescrito.",
    });
    assert.equal(result.ok, true);
    const md = result.md!;

    const beforeMarker = "**DESTAQUE 2 | 💼 MERCADO**";
    const afterMarker = "**DESTAQUE 3 | 🔬 PESQUISA**";

    const prefixOriginal = FIXTURE.slice(0, FIXTURE.indexOf(beforeMarker));
    const prefixNew = md.slice(0, md.indexOf(beforeMarker));
    assert.equal(prefixNew, prefixOriginal, "conteúdo ANTES de D2 deve ser idêntico");

    const suffixOriginal = FIXTURE.slice(FIXTURE.indexOf(afterMarker));
    const suffixNew = md.slice(md.indexOf(afterMarker));
    assert.equal(suffixNew, suffixOriginal, "conteúdo DEPOIS de D2 (D3 em diante) deve ser idêntico");
  });

  it("falha explicitamente quando o destaque não existe", () => {
    const result = applyHighlightEdit(FIXTURE, 4 as unknown as number, {
      title: "x",
      url: "https://example.com",
      body: ["x"],
      whyMatters: "x",
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /não encontrado/);
  });

  it("falha explicitamente com título vazio", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: "   ",
      url: d1.url,
      body: d1.body,
      whyMatters: d1.whyMatters,
    });
    assert.equal(result.ok, false);
  });

  it("falha explicitamente com URL vazia", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: d1.titleOptions[0].text,
      url: "   ",
      body: d1.body,
      whyMatters: d1.whyMatters,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /URL/);
  });

  it("falha explicitamente com URL sem esquema http(s) (#6493 review)", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: d1.titleOptions[0].text,
      url: "example.com/sem-esquema",
      body: d1.body,
      whyMatters: d1.whyMatters,
    });
    assert.equal(result.ok, false);
    assert.match(result.error!, /http/);
  });

  it("falha explicitamente com corpo vazio (todos os parágrafos em branco)", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: d1.titleOptions[0].text,
      url: d1.url,
      body: ["   ", ""],
      whyMatters: d1.whyMatters,
    });
    assert.equal(result.ok, false);
  });

  it("falha explicitamente com 'por que isso importa' vazio", () => {
    const { blocks } = parseHighlightBlocks(FIXTURE);
    const d1 = blocks[0];
    const result = applyHighlightEdit(FIXTURE, 1, {
      title: d1.titleOptions[0].text,
      url: d1.url,
      body: d1.body,
      whyMatters: "   ",
    });
    assert.equal(result.ok, false);
  });
});

describe("formatos legados de linha de título (#590/#1051) — round-trip (#6493 review)", () => {
  it("formato inner-bold ([**Título**](URL)) é preservado na reconstrução", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "[**Título em inner-bold**](https://example.com/x)",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
      "",
      "---",
      "",
    ].join("\n");
    const { blocks } = parseHighlightBlocks(md);
    assert.equal(blocks[0].titleOptions[0].text, "Título em inner-bold");

    const result = applyHighlightEdit(md, 1, {
      title: "Novo título inner-bold",
      url: blocks[0].url,
      body: blocks[0].body,
      whyMatters: blocks[0].whyMatters,
    });
    assert.equal(result.ok, true);
    assert.match(result.md!, /\[\*\*Novo título inner-bold\*\*\]\(https:\/\/example\.com\/x\)/);
  });

  it("formato plain ([Título](URL), sem negrito) é preservado na reconstrução", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "[Título sem negrito](https://example.com/y)",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
      "",
      "---",
      "",
    ].join("\n");
    const { blocks } = parseHighlightBlocks(md);
    assert.equal(blocks[0].titleOptions[0].text, "Título sem negrito");

    const result = applyHighlightEdit(md, 1, {
      title: "Novo título plain",
      url: blocks[0].url,
      body: blocks[0].body,
      whyMatters: blocks[0].whyMatters,
    });
    assert.equal(result.ok, true);
    assert.match(result.md!, /\[Novo título plain\]\(https:\/\/example\.com\/y\)/);
    assert.doesNotMatch(result.md!, /\*\*Novo título plain\*\*/);
  });
});

describe("'Por que isso importa' com múltiplos parágrafos — round-trip (#6493 review)", () => {
  const MULTI_WHY_MD = [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "**[Título único](https://example.com/multi)**",
    "",
    "Corpo do destaque.",
    "",
    "Por que isso importa:",
    "",
    "Primeiro parágrafo do why.",
    "",
    "Segundo parágrafo do why.",
    "",
    "---",
    "",
  ].join("\n");

  it("parse junta os 2 parágrafos com \\n\\n", () => {
    const { blocks } = parseHighlightBlocks(MULTI_WHY_MD);
    assert.equal(blocks[0].whyMatters, "Primeiro parágrafo do why.\n\nSegundo parágrafo do why.");
  });

  it("reconstrução a partir do texto multi-parágrafo recria as 2 linhas separadas por blank line", () => {
    const { blocks } = parseHighlightBlocks(MULTI_WHY_MD);
    const result = applyHighlightEdit(MULTI_WHY_MD, 1, {
      title: blocks[0].titleOptions[0].text,
      url: blocks[0].url,
      body: blocks[0].body,
      whyMatters: blocks[0].whyMatters,
    });
    assert.equal(result.ok, true);
    const { blocks: newBlocks } = parseHighlightBlocks(result.md!);
    assert.equal(newBlocks[0].whyMatters, "Primeiro parágrafo do why.\n\nSegundo parágrafo do why.");
    assert.match(result.md!, /Primeiro parágrafo do why\.\n\nSegundo parágrafo do why\./);
  });
});

describe("CRLF (#6493 review) — trailingRaw fica livre de \\r residual", () => {
  it("arquivo fonte CRLF: 'Aprofunde:' preservado sem \\r embutido, e a URL/eol de saída seguem CRLF", () => {
    const lfMd = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "**[Título único](https://example.com/crlf)**",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
      "",
      "Aprofunde:",
      "",
      "* [Outra fonte](https://example.com/crlf-b) - Fonte B",
      "",
      "---",
      "",
    ].join("\n");
    const crlfMd = lfMd.replace(/\n/g, "\r\n");

    const { blocks } = parseHighlightBlocks(crlfMd);
    assert.equal(blocks[0].trailingRaw.includes("\r"), false, "trailingRaw não deve conter \\r residual");
    assert.match(blocks[0].trailingRaw, /^Aprofunde:/);

    const result = applyHighlightEdit(crlfMd, 1, {
      title: "Novo título via CRLF",
      url: blocks[0].url,
      body: blocks[0].body,
      whyMatters: blocks[0].whyMatters,
    });
    assert.equal(result.ok, true);
    // eol de saída acompanha o eol detectado na ENTRADA (CRLF) — mesma
    // convenção de `replaceDestaqueTitleInMd` (extract-destaques.ts).
    assert.match(result.md!, /\r\n/);
    assert.match(result.md!, /Novo título via CRLF/);
  });
});
