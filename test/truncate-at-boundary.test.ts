/**
 * test/truncate-at-boundary.test.ts (#2065)
 *
 * Testa o helper truncateAtBoundary para os 3 limites usados na pipeline:
 *   - 150 chars (translate-summaries.ts)
 *   - 200 chars (clean-summary.ts / stitch-newsletter.ts renderSection)
 *   - 500 chars (fetch-rss.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateAtBoundary } from "../scripts/lib/truncate-at-boundary.ts";

describe("truncateAtBoundary (#2065)", () => {
  it("texto dentro do limite retorna sem modificar e sem …", () => {
    const text = "Texto curto sem necessidade de truncar.";
    assert.equal(truncateAtBoundary(text, 200), text);
    assert.doesNotMatch(truncateAtBoundary(text, 200), /…/);
  });

  it("texto exatamente no limite retorna sem modificar", () => {
    const text = "A".repeat(200);
    assert.equal(truncateAtBoundary(text, 200), text);
  });

  it("corta na última frase completa (ponto final) quando texto ultrapassa o limite", () => {
    // Frases completas repetidas, depois overflow que passa do limite
    const base = "Frase completa termina aqui. ".repeat(6); // 29*6=174 chars
    const overflow = "Outra frase que ultrapassa o limite.";
    const text = base + overflow;
    assert.ok(text.length > 200, `length=${text.length} deve ser >200`);
    const result = truncateAtBoundary(text, 200);
    assert.ok(result.length <= 200, `resultado deve ter ≤200 chars, mas tem ${result.length}`);
    // Deve terminar em ponto (última frase completa)
    assert.match(result, /\.$/, "deve terminar com ponto");
  });

  it("fallback: corta no último espaço + … quando sem frase completa antes do limite (limite 150)", () => {
    // Texto sem ponto final — 50 chars de palavras curtas, então longa sequência sem espaço
    const prefix = "Resumo sem ponto final para teste de fallback de ";  // 49 chars
    const longWord = "x".repeat(200);
    const text = prefix + longWord;
    assert.ok(text.length > 150, `length=${text.length} deve ser >150`);
    const result = truncateAtBoundary(text, 150);
    assert.ok(result.length <= 150, `resultado deve ter ≤150 chars, mas tem ${result.length}`);
    assert.match(result, /…$/, "deve terminar com reticências");
    // O resultado não deve conter a sequência longa de x (que é parte da última palavra)
    assert.doesNotMatch(result, /x{2,}/, "não deve incluir a sequência longa sem boundary");
  });

  it("limite 500 — corta na última frase completa (regressão fetch-rss)", () => {
    // Simula summary do RSS onde o texto passa de 500 chars com overflow no meio de palavra
    const sentences = "Esta é uma frase de exemplo com conteúdo variado. ".repeat(10); // ~500 chars
    assert.ok(sentences.length >= 490, `base length=${sentences.length}`);
    const overflow = "A atualização permite o uso do mod";
    const text = sentences + overflow;
    assert.ok(text.length > 500, `length=${text.length} deve ser >500`);
    const result = truncateAtBoundary(text, 500);
    assert.ok(result.length <= 500, `resultado deve ter ≤500 chars, mas tem ${result.length}`);
    // Deve terminar em ponto ou … mas nunca cortar 'atualização' no meio
    assert.doesNotMatch(result, /atualiza[^\s.…]*$/, "não deve terminar no meio de 'atualização'");
  });

  it("limite 200 — corta na última frase completa (regressão clean-summary)", () => {
    // Simula o caso Canaltech: texto passa 200 com overflow no meio de palavra
    const base = "Como usar o Google Maps no modo escuro. ".repeat(5); // ~200 chars
    assert.ok(base.length >= 190, `base length=${base.length}`);
    const overflow = "Como ver sua Linha do Tempo no";
    const text = base + overflow;
    assert.ok(text.length > 200, `length=${text.length} deve ser >200`);
    const result = truncateAtBoundary(text, 200);
    assert.ok(result.length <= 200, `resultado deve ter ≤200 chars, mas tem ${result.length}`);
    // Não pode cortar no meio de 'Linha' (ex: "Linh" sem o 'a')
    assert.doesNotMatch(result, /Linh[^a]|Linh$/, "não deve cortar 'Linha' no meio");
  });

  it("texto com apenas 1 palavra longa: trunca hard dentro de max + …", () => {
    const text = "P".repeat(300);
    const result = truncateAtBoundary(text, 200);
    // max = 200; resultado inclui … portanto resultado total ≤ 200 chars
    assert.ok(result.length <= 200, `result.length=${result.length} deve ser ≤200`);
    assert.match(result, /…$/);
  });

  it("não appenda … quando o texto termina exatamente na frase", () => {
    const text = "Frase curta.";
    const result = truncateAtBoundary(text, 200);
    assert.equal(result, text);
    assert.doesNotMatch(result, /…/);
  });

  it("suporta terminadores ! e ? além de .", () => {
    // Frases com ! e ?, texto que passa do limite
    const base = "Pergunta que tem terminador especial? ".repeat(3); // ~113 chars
    const overflow = "palavra_longa_demais_pra_caber_neste_limite";
    const text = base + overflow;
    assert.ok(text.length > 100, `length=${text.length} deve ser >100`);
    const result = truncateAtBoundary(text, 100);
    assert.ok(result.length <= 100, `result.length=${result.length} deve ser ≤100`);
    // Termina em ? ou . ou …
    assert.match(result, /[?!.…]$/, "deve terminar em terminador ou reticências");
  });

  it("resultado nunca ultrapassa max em nenhum caminho", () => {
    // Testar vários tamanhos e padrões
    const cases = [
      { text: "sem.ponto".repeat(30), max: 50 },
      { text: "Com ponto. ".repeat(5) + "overflow longo demais", max: 40 },
      { text: "AB CD EF".repeat(30), max: 30 },
    ];
    for (const { text, max } of cases) {
      const result = truncateAtBoundary(text, max);
      assert.ok(
        result.length <= max,
        `text=${JSON.stringify(text.slice(0, 20))}... max=${max}: result.length=${result.length} > max`,
      );
    }
  });
});
