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
  findLastBoundary,
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
    const result = applyChunkSuggestions(chunk, suggestions);
    assert.ok(result.text.includes("há pouco"), "sugestão deve ser aplicada");
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
  });

  it("sugestão com from ambíguo (2× no chunk) → SKIP", () => {
    const chunk: TextChunk = { text: "O modelo foi lançado. O modelo é novo.", startOffset: 0 };
    // "O modelo" aparece 2× no chunk — ambígua
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "O modelo", to: "Esse modelo" },
    ];
    const result = applyChunkSuggestions(chunk, suggestions, () => {});
    assert.equal(result.applied.length, 0, "sugestão ambígua não deve ser aplicada");
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].reason.includes("ambígua"), `reason deveria mencionar ambiguidade: ${result.skipped[0].reason}`);
    assert.equal(result.text, chunk.text, "texto não deve ser alterado");
  });

  it("sugestão com from ausente no chunk → SKIP", () => {
    const chunk: TextChunk = { text: "Texto simples sem a frase esperada.", startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "frase inexistente no chunk", to: "substituição" },
    ];
    const result = applyChunkSuggestions(chunk, suggestions);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.text, chunk.text);
  });

  it("sugestão no-op (from === to) → SKIP silencioso", () => {
    const chunk: TextChunk = { text: "Texto de exemplo.", startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "Texto", to: "Texto" },
    ];
    const result = applyChunkSuggestions(chunk, suggestions);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.text, chunk.text);
  });

  it("sugestão from whitespace-only → SKIP (paridade com clarice-apply)", () => {
    const chunk: TextChunk = { text: "Algum texto com   espaços.", startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "   ", to: "" }, // from whitespace-only — não deve corromper espaços
    ];
    const result = applyChunkSuggestions(chunk, suggestions);
    assert.equal(result.applied.length, 0, "from whitespace-only não deve ser aplicado");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.text, chunk.text, "texto não deve ser alterado");
  });

  it("#2606: `to` com $ patterns ($&) não é interpretado como backreference", () => {
    const chunk: TextChunk = { text: "O preço é caro hoje.", startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "caro", to: "R$ 50 ($&)" }, // contém $& — não deve expandir para o match
    ];
    const result = applyChunkSuggestions(chunk, suggestions);
    assert.equal(result.applied.length, 1);
    assert.ok(
      result.text.includes("R$ 50 ($&)"),
      `'$&' deve ser literal, não expandido para o match. Texto: ${result.text}`,
    );
    assert.ok(!result.text.includes("R$ 50 (caro)"), "$& NÃO deve expandir para 'caro'");
  });

  it("múltiplas sugestões: aplica únicas, pula ambíguas", () => {
    const chunk: TextChunk = { text: "A empresa cresceu. A empresa lucrou.", startOffset: 0 };
    const suggestions: ClariceChunkSuggestion[] = [
      { from: "cresceu", to: "expandiu" },         // 1× no chunk → aplicar
      { from: "A empresa", to: "A companhia" },     // 2× no chunk → skip
    ];
    const result = applyChunkSuggestions(chunk, suggestions);
    assert.equal(result.applied.length, 1, "só 1 sugestão deve ser aplicada");
    assert.equal(result.applied[0].from, "cresceu");
    assert.equal(result.skipped.length, 1, "sugestão ambígua deve ser pulada");
    assert.ok(result.text.includes("expandiu"), "substituição de 'cresceu' deve estar no texto");
    assert.ok(result.text.includes("A empresa"), "substituição ambígua NÃO deve ter sido feita");
  });
});

// ---------------------------------------------------------------------------
// mergeChunkSuggestions (chunk-local: chunks corrigidos re-concatenados)
// ---------------------------------------------------------------------------

describe("mergeChunkSuggestions", () => {
  it("dois chunks com sugestões únicas → ambas aplicadas + reconstrução correta", () => {
    // Chunks reconstroem o original ao concatenar (invariante de splitIntoChunks).
    const chunk1: TextChunk = { text: "Primeira parte com erro1.\n\n", startOffset: 0 };
    const chunk2: TextChunk = { text: "Segunda parte com erro2.", startOffset: chunk1.text.length };
    const result = mergeChunkSuggestions([
      { chunk: chunk1, suggestions: [{ from: "erro1", to: "correção1" }] },
      { chunk: chunk2, suggestions: [{ from: "erro2", to: "correção2" }] },
    ]);
    assert.equal(result.text, "Primeira parte com correção1.\n\nSegunda parte com correção2.");
    assert.equal(result.applied.length, 2);
    assert.equal(result.skipped.length, 0);
  });

  it("integração: splitIntoChunks → merge reconstrói texto com correções aplicadas", () => {
    const para = "Frase de teste editorial. ".repeat(20) + "\n\n";
    let text = "ALVO_UNICO no início.\n\n";
    while (text.length < 12_000) text += para;
    const chunks = splitIntoChunks(text, 9_000);
    assert.ok(chunks.length >= 2);
    // Aplicar uma correção no primeiro chunk (ALVO_UNICO está no início, 1× global)
    const chunkSuggestions = chunks.map((chunk, i) => ({
      chunk,
      suggestions: i === 0 ? [{ from: "ALVO_UNICO", to: "ALVO_CORRIGIDO" }] : [],
    }));
    const result = mergeChunkSuggestions(chunkSuggestions);
    assert.ok(result.text.includes("ALVO_CORRIGIDO"));
    assert.ok(!result.text.includes("ALVO_UNICO"));
    // Texto restante (fora a substituição) preservado: comprimento bate com a diferença
    assert.equal(result.text.length, text.length + ("ALVO_CORRIGIDO".length - "ALVO_UNICO".length));
  });

  it("sugestão skip de um chunk não afeta sugestão válida do outro", () => {
    const chunk1: TextChunk = { text: "Texto1 com ambíguo ambíguo.\n\n", startOffset: 0 };
    const chunk2: TextChunk = { text: "Texto2 com único.", startOffset: chunk1.text.length };
    const result = mergeChunkSuggestions([
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

// ---------------------------------------------------------------------------
// findLastBoundary — #2705: guard contra regex sem flag `g` (footgun infinite-loop)
// ---------------------------------------------------------------------------

describe("findLastBoundary — guard de flag g (#2705)", () => {
  it("lança erro explícito quando o regex NÃO tem a flag g (em vez de travar em loop infinito)", () => {
    // Sem `g`, `re.exec(text)` nunca avança `lastIndex` — o `while` interno de
    // findLastBoundary rodaria para sempre. Antes do fix #2705 isso travava a
    // thread; o guard deve falhar loud e imediato.
    assert.throws(
      () => findLastBoundary("a---b---c", /---/, 0),
      /findLastBoundary requer regex com flag g/,
      "deve lançar erro claro em vez de entrar em loop infinito",
    );
  });

  it("funciona normalmente com regex com flag g (comportamento preservado)", () => {
    const result = findLastBoundary("a\n\nb\n\nc\n\nd", /\n\n/g, 0);
    // Última ocorrência de "\n\n" é entre "c" e "d" — índice 8, cutPos = 10.
    const expectedIdx = "a\n\nb\n\nc\n\nd".lastIndexOf("\n\n") + "\n\n".length;
    assert.equal(result, expectedIdx);
  });

  it("respeita minCut mesmo com regex g válido (comportamento preservado)", () => {
    const text = "a\n\nb\n\nc";
    // Com minCut muito alto, nenhum corte serve → -1.
    const result = findLastBoundary(text, /\n\n/g, 1000);
    assert.equal(result, -1);
  });
});

// #2798: threshold baixado 9k→4.5k pra dividir seções >5k que davam timeout no cortex
describe("CLARICE_CHUNK_THRESHOLD — seções >5k dividem (regressão #2798)", () => {
  it("threshold é < 5.000 (seções secundárias >5k precisam dividir)", () => {
    assert.ok(
      CLARICE_CHUNK_THRESHOLD < 5_000,
      `threshold deve ser <5000 pra dividir seções >5k (cortex timeout #2798), mas é ${CLARICE_CHUNK_THRESHOLD}`,
    );
  });

  it("uma seção de ~6.000 chars (a que estourava) dividida em ≥2 chunks com o default", () => {
    const paragraph = "Parágrafo editorial da seção secundária com conteúdo real. ".repeat(3) + "\n\n";
    let text = "";
    while (text.length < 6_000) text += paragraph;
    const chunks = splitIntoChunks(text); // usa o default CLARICE_CHUNK_THRESHOLD
    assert.ok(
      chunks.length >= 2,
      `seção de ${text.length} chars deve virar ≥2 chunks (antes era 1, sob o threshold antigo de 9k), recebido ${chunks.length}`,
    );
    for (const c of chunks) {
      assert.ok(c.text.length <= CLARICE_CHUNK_THRESHOLD, `chunk excede o threshold: ${c.text.length}`);
    }
    assert.equal(chunks.map((c) => c.text).join(""), text, "concatenação reconstrói o original");
  });
});
