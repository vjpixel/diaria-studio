/**
 * strip-publisher-suffix.test.ts (#2140)
 *
 * Testes de regressão para `stripPublisherSuffix`:
 *   - Casos reais do issue (#2140): G1 e CNN Brasil.
 *   - Heurística anti-falso-positivo: prefixo < 15 chars → preservar original.
 *   - Títulos sem " | " → inalterado.
 *   - Pipe sem espaços → inalterado.
 *   - Múltiplos segmentos após o 1º " | " → todos removidos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripPublisherSuffix, MIN_PREFIX_LEN } from "../scripts/lib/strip-publisher-suffix.ts";

describe("stripPublisherSuffix (#2140)", () => {
  // ──────────────────────────────────────────────────────────
  // Casos reais do issue
  // ──────────────────────────────────────────────────────────

  it("remove sufixo simples '| G1' (caso real #2140)", () => {
    assert.equal(
      stripPublisherSuffix(
        "Especialistas criticam modelo de regulamentação da IA no Brasil | G1",
      ),
      "Especialistas criticam modelo de regulamentação da IA no Brasil",
    );
  });

  it("remove múltiplos segmentos '| Blogs | CNN Brasil' (caso real #2140)", () => {
    assert.equal(
      stripPublisherSuffix(
        "Gigantes da IA terão IPOs bilionários, mas há quem tema uma nova bolha | Blogs | CNN Brasil",
      ),
      "Gigantes da IA terão IPOs bilionários, mas há quem tema uma nova bolha",
    );
  });

  // ──────────────────────────────────────────────────────────
  // Heurística anti-falso-positivo: prefixo curto
  // ──────────────────────────────────────────────────────────

  it(`preserva título original quando prefixo antes do ' | ' tem < ${MIN_PREFIX_LEN} chars`, () => {
    // "IA no Brasil" = 12 chars (< MIN_PREFIX_LEN) → não deve cortar
    const input = "IA no Brasil | G1";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it(`preserva título original quando prefixo tem exatamente ${MIN_PREFIX_LEN - 1} chars (< ${MIN_PREFIX_LEN})`, () => {
    const prefix = "x".repeat(MIN_PREFIX_LEN - 1);
    const input = `${prefix} | Veículo`;
    assert.equal(stripPublisherSuffix(input), input);
  });

  it(`faz strip quando prefixo tem exatamente ${MIN_PREFIX_LEN} chars (= limite mínimo)`, () => {
    const prefix = "x".repeat(MIN_PREFIX_LEN);
    assert.equal(
      stripPublisherSuffix(`${prefix} | Veículo`),
      prefix,
    );
  });

  // ──────────────────────────────────────────────────────────
  // Títulos sem " | " → inalterado
  // ──────────────────────────────────────────────────────────

  it("retorna título inalterado quando não há ' | '", () => {
    const input = "OpenAI lança novo modelo sem sufixo";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("retorna string vazia inalterada", () => {
    assert.equal(stripPublisherSuffix(""), "");
  });

  // ──────────────────────────────────────────────────────────
  // Pipe sem espaços → inalterado (não é sufixo de veículo)
  // ──────────────────────────────────────────────────────────

  it("NÃO toca em pipe sem espaços (|SemEspaços|)", () => {
    const input = "Título|SemEspaços|Pipe";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("NÃO toca em pipe com espaço de um lado só", () => {
    const input = "Título |SemEspaçoDepois";
    assert.equal(stripPublisherSuffix(input), input);
  });

  // ──────────────────────────────────────────────────────────
  // C8: guard "return original" não normaliza whitespace (#2161)
  // ──────────────────────────────────────────────────────────

  it("C8: prefixo curto — retorna title original (sem strip de whitespace)", () => {
    // Prefixo "curto" < MIN_PREFIX_LEN → path guard retorna `title` intacto,
    // incluindo espaços que o chamador colocou.
    const input = "  curto | G1  ";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("C8: sem ' | ' — retorna title original (sem normalizar whitespace)", () => {
    const input = "  Título sem pipe  ";
    assert.equal(stripPublisherSuffix(input), input);
  });

  // ──────────────────────────────────────────────────────────
  // Misc
  // ──────────────────────────────────────────────────────────

  it("remove espaços extras ao redor do prefixo", () => {
    assert.equal(
      stripPublisherSuffix("  Título com espaço extra   | Veículo  "),
      "Título com espaço extra",
    );
  });

  it("retorna só o prefixo antes do 1º ' | ', ignorando os subsequentes", () => {
    assert.equal(
      stripPublisherSuffix("Título longo suficiente | Seção A | Seção B | Veículo"),
      "Título longo suficiente",
    );
  });
});
