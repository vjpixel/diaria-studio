/**
 * test/truncated-summary.test.ts (#2596)
 *
 * Testes de regressão para `isTruncatedSummary`.
 *
 * Caso real: Exame — descrição termina em "...conformidade…" (palavra
 * "conformidade" + "…"; mas "conformidade" é substantivo, fecha ideia →
 * NÃO deve ser flagrado pela heurística conservadora).
 *
 * Casos truncados reais: frase cortada com conjunção/preposição pendente.
 * Casos intencionais: reticências após verbo/substantivo/adjETIVO (ideia fechada).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTruncatedSummary } from "../scripts/lib/truncated-summary.ts";

describe("isTruncatedSummary (#2596)", () => {
  // ------------------------------------------------------------------ //
  //  Casos que NÃO devem ser flagrados (reticências intencionais)         //
  // ------------------------------------------------------------------ //

  it("reticências após substantivo = intencional → false", () => {
    // Caso real Exame: "...conformidade…" — substantivo fecha ideia
    assert.equal(
      isTruncatedSummary(
        "A empresa anunciou nova política de conformidade…",
      ),
      false,
    );
  });

  it('"e por aí vai..." — verbo fecha ideia → false', () => {
    assert.equal(isTruncatedSummary("O mercado cresceu e por aí vai..."), false);
  });

  it("reticências após adjetivo → false", () => {
    assert.equal(
      isTruncatedSummary("O produto é inovador, robusto e seguro..."),
      false,
    );
  });

  it("reticências após numeral → false", () => {
    assert.equal(
      isTruncatedSummary("A empresa tem mais de 500 funcionários..."),
      false,
    );
  });

  it("sem reticências → false", () => {
    assert.equal(
      isTruncatedSummary("Texto terminando com ponto final."),
      false,
    );
  });

  it("string vazia → false", () => {
    assert.equal(isTruncatedSummary(""), false);
  });

  it("reticências após pronome 'isso' (pronome fecha ideia) → false", () => {
    assert.equal(
      isTruncatedSummary("O estudo mostra tudo isso..."),
      false,
    );
  });

  // ------------------------------------------------------------------ //
  //  Casos que DEVEM ser flagrados (truncamento involuntário)             //
  // ------------------------------------------------------------------ //

  it("frase cortada com conjunção 'e' pendente → true", () => {
    // "crescimento, inovação e..." — "e" é conjunção pendente
    assert.equal(
      isTruncatedSummary("A empresa promove crescimento, inovação e…"),
      true,
    );
  });

  it("frase cortada com preposição 'de' pendente → true", () => {
    assert.equal(
      isTruncatedSummary("Novas regras de conformidade afetam empresas de…"),
      true,
    );
  });

  it("frase cortada com preposição 'para' pendente → true", () => {
    assert.equal(
      isTruncatedSummary("A proposta visa preparar o setor para…"),
      true,
    );
  });

  it("frase cortada com conjunção 'ou' pendente → true", () => {
    assert.equal(
      isTruncatedSummary("O usuário pode aceitar ou..."),
      true,
    );
  });

  it("frase cortada com conjunção subordinativa 'que' pendente → true", () => {
    assert.equal(
      isTruncatedSummary("O relatório aponta que..."),
      true,
    );
  });

  it("frase cortada com artigo 'o' pendente → true", () => {
    assert.equal(
      isTruncatedSummary("Especialistas recomendam consultar o…"),
      true,
    );
  });

  it("frase cortada com preposição 'em' + artigo 'no' pendente → true", () => {
    // "no" = em + o
    assert.equal(
      isTruncatedSummary("A regulação impacta diretamente no…"),
      true,
    );
  });

  it("frase cortada com conjunção 'mas' pendente → true", () => {
    assert.equal(
      isTruncatedSummary("O produto é bom mas…"),
      true,
    );
  });

  it("ASCII '...' em truncamento com preposição → true", () => {
    assert.equal(
      isTruncatedSummary("Novas regras de..."),
      true,
    );
  });

  it("ellipsis U+2026 em truncamento com conjunção → true", () => {
    assert.equal(
      isTruncatedSummary("O setor precisa se adaptar e…"),
      true,
    );
  });

  // ------------------------------------------------------------------ //
  //  Edge cases                                                           //
  // ------------------------------------------------------------------ //

  it("apenas reticências → false (sem palavra antes)", () => {
    assert.equal(isTruncatedSummary("…"), false);
  });

  it("texto com trailing whitespace antes de reticências — trimmed → detecta", () => {
    assert.equal(
      isTruncatedSummary("O projeto visa implementar e   "),
      false, // sem reticências, só whitespace
    );
  });

  it("texto terminado em reticências com trailing whitespace → lida corretamente", () => {
    assert.equal(
      isTruncatedSummary("O projeto visa implementar e…   "),
      true,
    );
  });
});
