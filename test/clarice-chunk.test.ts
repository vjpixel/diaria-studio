/**
 * clarice-chunk.test.ts (#2606)
 *
 * Testes de regressão para o helper de chunking do Clarice:
 *   - splitIntoChunks: dividir texto longo em fronteiras seguras (parágrafos/seções)
 *   - applyChunkSuggestions: política de ambiguidade (skip quando from ≠ 1×)
 *   - mergeChunkSuggestions: merge de múltiplos chunks em sequência
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitIntoChunks,
  applyChunkSuggestions,
  mergeChunkSuggestions,
  CLARICE_CHUNK_THRESHOLD,
  type TextChunk,
  type ClariceChunkSuggestion,
} from "../scripts/lib/clarice-chunk.ts";

// ---------------------------------------------------------------------------
// splitIntoChunks
// ---------------------------------------------------------------------------

describe("splitIntoChunks", () => {
  it("texto curto (≤ threshold) → 1 chunk com offset 0", () => {
    const text = "Parágrafo curto sem necessidade de chunking.";
    const chunks = splitIntoChunks(text, CLARICE_CHUNK_THRESHOLD);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, text);
    assert.equal(chunks[0].startOffset, 0);
  });

  it("texto longo → ≥2 chunks em fronteiras seguras (sem cortar no meio de linha)", () => {
    // Gerar texto sintético >10k chars com parágrafos separados por \n\n
    const paragraph = "Este é um parágrafo de teste com conteúdo editorial. ".repeat(5) + "\n\n";
    let text = "";
    while (text.length < 15_000) {
      text += paragraph;
    }
    const chunks = splitIntoChunks(text, 9_000);
    assert.ok(chunks.length >= 2, `esperado ≥2 chunks, recebido ${chunks.length}`);
    // Todos os chunks devem estar dentro do limite
    for (const chunk of chunks) {
      assert.ok(
        chunk.text.length <= 9_000,
        `chunk com offset ${chunk.startOffset} excede limite: ${chunk.text.length} chars`,
      );
    }
    // A concatenação deve reconstituir o texto original
    const reconstructed = chunks.map((c) => c.text).join("");
    assert.equal(reconstructed, text, "chunks concatenados devem reconstruir o texto original");
  });

  it("corta em fronteira de seção `---` quando disponível", () => {
    // Texto com separador de seção que cabe no limite
    const section1 = "Conteúdo da primeira seção.\n".repeat(60); // ~1680 chars
    const section2 = "Conteúdo da segunda seção.\n".repeat(60); // ~1620 chars
    const separator = "\n---\n";
    const text = section1 + separator + section2;
    // Com limite de 3000 chars, deve cortar no ---
    const chunks = splitIntoChunks(text, 3_000);
    assert.ok(chunks.length >= 2);
    // O primeiro chunk deve terminar com o separador (inclui o \n--- \n)
    // ou pelo menos não deve cortar no meio de uma linha
    for (const chunk of chunks) {
      assert.ok(!chunk.text.endsWith("-"), "chunk não deve terminar no meio do separador ---");
    }
    // Reconstrução
    assert.equal(chunks.map((c) => c.text).join(""), text);
  });

  it("offsets são cumulativos e cobrem o texto inteiro", () => {
    const text = "Linha 1\n\nLinha 2\n\nLinha 3\n\n".repeat(200); // ~5400 chars
    const chunks = splitIntoChunks(text, 2_000);
    assert.ok(chunks.length >= 2);
    // Cada chunk deve começar onde o anterior terminou
    let expectedOffset = 0;
    for (const chunk of chunks) {
      assert.equal(
        chunk.startOffset,
        expectedOffset,
        `chunk com offset ${chunk.startOffset} deveria ter offset ${expectedOffset}`,
      );
      expectedOffset += chunk.text.length;
    }
    assert.equal(expectedOffset, text.length, "offsets acumulados devem cobrir o texto completo");
  });

  it("newsletter sintética >10k → ≥2 chunks com fronteiras em parágrafos", () => {
    // Simula newsletter Diar.ia real: seções com ---
    const header = "Olá!\n\n" + "Texto de abertura. ".repeat(50) + "\n\n";
    const destaque = (n: number) =>
      `DESTAQUE ${n}\n\n` + "Conteúdo do destaque com muitos detalhes editoriais. ".repeat(100) + "\n\n" + "Por que isso importa: " + "Análise detalhada e extensa do impacto deste acontecimento no ecossistema de IA. ".repeat(50) + "\n\n";
    const newsletter = header + destaque(1) + "---\n\n" + destaque(2) + "---\n\n" + destaque(3);

    assert.ok(newsletter.length > 10_000, `newsletter sintética tem apenas ${newsletter.length} chars`);

    const chunks = splitIntoChunks(newsletter, CLARICE_CHUNK_THRESHOLD);
    assert.ok(chunks.length >= 2, `esperado ≥2 chunks para newsletter de ${newsletter.length} chars`);
    assert.equal(chunks.map((c) => c.text).join(""), newsletter, "chunks reconstituem o texto");

    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= CLARICE_CHUNK_THRESHOLD, `chunk excede threshold: ${chunk.text.length}`);
    }
  });
});

// ---------------------------------------------------------------------------
// applyChunkSuggestions — política de ambiguidade
// ---------------------------------------------------------------------------

describe("applyChunkSuggestions", () => {
  it("sugestão com from único no chunk → aplicada no fullText", () => {
    const fullText = "O modelo foi atualizado recentemente e o modelo funciona bem.";
    const chunk: TextChunk = { text: "O modelo foi atualizado recentemente e o modelo funciona bem.", startOffset: 0 };
    // "recentemente" aparece 1× no chunk
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "recentemente", to: "há pouco" },
    ];
    const result = applyChunkSuggestions(fullText, chunk, suggestions);
    assert.ok(result.text.includes("há pouco"), "sugestão deve ser aplicada");
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
  });

  it("sugestão com from ambíguo (2× no chunk) → SKIP", () => {
    const fullText = "O modelo foi lançado. O modelo é novo.";
    const chunk: TextChunk = { text: "O modelo foi lançado. O modelo é novo.", startOffset: 0 };
    // "O modelo" aparece 2× no chunk — ambígua
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "O modelo", to: "Esse modelo" },
    ];
    const skipped: string[] = [];
    const result = applyChunkSuggestions(fullText, chunk, suggestions, (msg) => skipped.push(msg));
    assert.equal(result.applied.length, 0, "sugestão ambígua não deve ser aplicada");
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].reason.includes("ambígua"), `reason deveria mencionar ambiguidade: ${result.skipped[0].reason}`);
    assert.equal(result.text, fullText, "texto não deve ser alterado");
  });

  it("sugestão com from ausente no chunk → SKIP", () => {
    const fullText = "Texto simples sem a frase esperada.";
    const chunk: TextChunk = { text: "Texto simples sem a frase esperada.", startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "frase inexistente no chunk", to: "substituição" },
    ];
    const result = applyChunkSuggestions(fullText, chunk, suggestions);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.text, fullText);
  });

  it("sugestão no-op (from === to) → SKIP silencioso", () => {
    const fullText = "Texto de exemplo.";
    const chunk: TextChunk = { text: fullText, startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "Texto", to: "Texto" },
    ];
    const result = applyChunkSuggestions(fullText, chunk, suggestions);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.text, fullText);
  });

  it("múltiplas sugestões: aplica únicas, pula ambíguas", () => {
    const text = "A empresa cresceu. A empresa lucrou.";
    const chunk: TextChunk = { text, startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "cresceu", to: "expandiu" },         // 1× no chunk → aplicar
      { from: "A empresa", to: "A companhia" },     // 2× no chunk → skip
    ];
    const result = applyChunkSuggestions(text, chunk, suggestions);
    assert.equal(result.applied.length, 1, "só 1 sugestão deve ser aplicada");
    assert.equal(result.applied[0].from, "cresceu");
    assert.equal(result.skipped.length, 1, "sugestão ambígua deve ser pulada");
    assert.ok(result.text.includes("expandiu"), "substituição de 'cresceu' deve estar no texto");
    assert.ok(result.text.includes("A empresa"), "substituição ambígua NÃO deve ter sido feita");
  });

  it("sugestão em chunk parcial (não o texto inteiro) → aplica na região correta", () => {
    const fullText = "Seção 1: conteúdo inicial.\n\nSeção 2: conteúdo tardio com problema.";
    const secondSection = "Seção 2: conteúdo tardio com problema.";
    const offset = fullText.indexOf(secondSection);
    const chunk: TextChunk = { text: secondSection, startOffset: offset };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "tardio", to: "posterior" },
    ];
    const result = applyChunkSuggestions(fullText, chunk, suggestions);
    assert.ok(result.text.includes("posterior"), "substituição deve ser feita no fullText");
    assert.ok(!result.text.includes("tardio"), "texto original deve ser substituído");
    assert.equal(result.applied.length, 1);
  });
});

// ---------------------------------------------------------------------------
// mergeChunkSuggestions
// ---------------------------------------------------------------------------

describe("mergeChunkSuggestions", () => {
  it("dois chunks com sugestões únicas → ambas aplicadas", () => {
    const fullText = "Primeira parte com erro1.\n\nSegunda parte com erro2.";
    const chunk1: TextChunk = { text: "Primeira parte com erro1.", startOffset: 0 };
    const chunk2: TextChunk = {
      text: "Segunda parte com erro2.",
      startOffset: "Primeira parte com erro1.\n\n".length,
    };
    const result = mergeChunkSuggestions(fullText, [
      { chunk: chunk1, suggestions: [{ from: "erro1", to: "correção1" }] },
      { chunk: chunk2, suggestions: [{ from: "erro2", to: "correção2" }] },
    ]);
    assert.ok(result.text.includes("correção1"));
    assert.ok(result.text.includes("correção2"));
    assert.equal(result.applied.length, 2);
    assert.equal(result.skipped.length, 0);
  });

  it("sugestão skip de um chunk não afeta sugestão válida do outro", () => {
    const fullText = "Texto1 com ambíguo ambíguo.\n\nTexto2 com único.";
    const chunk1: TextChunk = { text: "Texto1 com ambíguo ambíguo.", startOffset: 0 };
    const chunk2: TextChunk = {
      text: "Texto2 com único.",
      startOffset: "Texto1 com ambíguo ambíguo.\n\n".length,
    };
    const result = mergeChunkSuggestions(fullText, [
      { chunk: chunk1, suggestions: [{ from: "ambíguo", to: "claro" }] }, // 2× no chunk → skip
      { chunk: chunk2, suggestions: [{ from: "único", to: "singular" }] }, // 1× → apply
    ]);
    assert.equal(result.applied.length, 1, "só sugestão única deve ser aplicada");
    assert.equal(result.applied[0].from, "único");
    assert.equal(result.skipped.length, 1, "sugestão ambígua deve ser pulada");
    assert.ok(result.text.includes("singular"));
    assert.ok(result.text.includes("ambíguo"), "texto ambíguo não deve ser substituído");
  });
});
