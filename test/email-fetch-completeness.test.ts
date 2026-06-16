/**
 * test/email-fetch-completeness.test.ts (#2317)
 *
 * Testes de regressão para classifyFetchCompleteness.
 *
 * Cenário crítico: newsletter-final.html ~34KB, corpo Gmail MCP ~2KB (truncado)
 * → deve classificar como `incomplete` → agent deve downgrade para `inconclusive`,
 * NÃO emitir `section_missing`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFetchCompleteness,
  DEFAULT_COMPLETENESS_THRESHOLD,
} from "../scripts/lib/email-fetch-completeness.ts";

// Constantes dos cenários reais documentados na issue #2317
const REAL_HTML_SIZE = 34 * 1024; // ~34KB — newsletter-final.html típico
const TRUNCATED_BODY_SIZE = 2 * 1024; // ~2KB — corpo truncado reportado em 260616

describe("classifyFetchCompleteness (#2317)", () => {
  // -------------------------------------------------------------------------
  // Cenário crítico: 34KB html vs 2KB corpo (caso real 260616)
  // -------------------------------------------------------------------------

  it("cenário real 260616: 34KB html vs 2KB truncado → incomplete", () => {
    const result = classifyFetchCompleteness(TRUNCATED_BODY_SIZE, REAL_HTML_SIZE);
    assert.equal(result, "incomplete",
      "corpo de 2KB com HTML de 34KB deve ser classificado como incomplete (fetch truncado)");
  });

  it("cenário real 260616: body=2048, htmlLen=34816 (< 50% threshold) → incomplete", () => {
    // 2048 / 34816 ≈ 5.9% — muito abaixo do threshold de 50%
    assert.equal(
      classifyFetchCompleteness(2048, 34816),
      "incomplete",
    );
  });

  // -------------------------------------------------------------------------
  // Corpo completo: email grande (wrap do Beehiiv adiciona ~30-50% overhead)
  // -------------------------------------------------------------------------

  it("email completo (>50% do html local) → complete", () => {
    // Beehiiv adiciona template wrapper; email pode ser maior que o HTML local.
    const emailBody = 40 * 1024; // 40KB
    const finalHtml = 34 * 1024; // 34KB
    assert.equal(classifyFetchCompleteness(emailBody, finalHtml), "complete");
  });

  it("email exatamente igual ao html → complete", () => {
    assert.equal(classifyFetchCompleteness(REAL_HTML_SIZE, REAL_HTML_SIZE), "complete");
  });

  it("email no threshold exato (50%) → complete (não abaixo)", () => {
    // threshold é estritamente menor: emailBodyLen < 0.5 * finalHtmlLen → incomplete
    // Exatamente 0.5 * finalHtmlLen → complete (não é "< 0.5")
    const halfSize = Math.floor(REAL_HTML_SIZE * DEFAULT_COMPLETENESS_THRESHOLD);
    assert.equal(
      classifyFetchCompleteness(halfSize, REAL_HTML_SIZE),
      "complete",
      "valor exatamente no threshold deve ser 'complete' (threshold é exclusivo)",
    );
  });

  it("email logo abaixo do threshold (49.9%) → incomplete", () => {
    const justBelow = Math.floor(REAL_HTML_SIZE * 0.499);
    assert.equal(
      classifyFetchCompleteness(justBelow, REAL_HTML_SIZE),
      "incomplete",
    );
  });

  it("email logo acima do threshold (50.1%) → complete", () => {
    const justAbove = Math.ceil(REAL_HTML_SIZE * 0.501);
    assert.equal(
      classifyFetchCompleteness(justAbove, REAL_HTML_SIZE),
      "complete",
    );
  });

  // -------------------------------------------------------------------------
  // Casos especiais / edge cases
  // -------------------------------------------------------------------------

  it("finalHtmlLen=0 (sem referência local) → complete (fail-safe)", () => {
    // Sem HTML local não há base de comparação; assume completo para não bloquear.
    assert.equal(classifyFetchCompleteness(5000, 0), "complete");
  });

  it("finalHtmlLen negativo → complete (fail-safe, mesmo que inesperado)", () => {
    assert.equal(classifyFetchCompleteness(5000, -100), "complete");
  });

  it("emailBodyLen=0 com html presente → incomplete (corpo vazio = fetch falhou)", () => {
    assert.equal(classifyFetchCompleteness(0, REAL_HTML_SIZE), "incomplete");
  });

  it("emailBodyLen negativo com html presente → incomplete", () => {
    assert.equal(classifyFetchCompleteness(-1, REAL_HTML_SIZE), "incomplete");
  });

  it("ambos zero → complete (fail-safe: sem dados de comparação)", () => {
    assert.equal(classifyFetchCompleteness(0, 0), "complete");
  });

  // -------------------------------------------------------------------------
  // Threshold customizado
  // -------------------------------------------------------------------------

  it("threshold customizado 0.8 → incomplete quando corpo é 60% do html", () => {
    const emailBody = Math.floor(REAL_HTML_SIZE * 0.6);
    assert.equal(
      classifyFetchCompleteness(emailBody, REAL_HTML_SIZE, 0.8),
      "incomplete",
      "60% < 80% threshold → incomplete",
    );
  });

  it("threshold customizado 0.1 → complete quando corpo é 20% do html", () => {
    const emailBody = Math.floor(REAL_HTML_SIZE * 0.2);
    assert.equal(
      classifyFetchCompleteness(emailBody, REAL_HTML_SIZE, 0.1),
      "complete",
      "20% > 10% threshold → complete",
    );
  });

  // -------------------------------------------------------------------------
  // DEFAULT_COMPLETENESS_THRESHOLD valor esperado
  // -------------------------------------------------------------------------

  it("DEFAULT_COMPLETENESS_THRESHOLD é 0.5", () => {
    assert.equal(DEFAULT_COMPLETENESS_THRESHOLD, 0.5);
  });
});
