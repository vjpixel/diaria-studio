/**
 * test/sanitize-description-boilerplate.test.ts (#3196)
 *
 * Regressão (#633) dos helpers `stripNavigationBoilerplate`,
 * `fixGluedAcronymDate` e `sanitizeDescriptionBoilerplate`.
 *
 * Caso real reportado na edição 260709 (issue #3196, USE MELHOR
 * hashtagtreinamentos):
 *   "Existe uma ótima radiografia de… Leia mais: Transição de carreira em
 *    dados no Brasil... Claude Code: Guia Completo para Programar com
 *    IA29 de maio de 2026"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripNavigationBoilerplate,
  fixGluedAcronymDate,
  sanitizeDescriptionBoilerplate,
} from "../scripts/lib/sanitize-description-boilerplate.ts";

describe("stripNavigationBoilerplate (#3196)", () => {
  it("corta a descrição no lead-in 'Leia mais:'", () => {
    const out = stripNavigationBoilerplate(
      "Resumo real do artigo. Leia mais: outro artigo qualquer sem relação",
    );
    assert.equal(out, "Resumo real do artigo.");
  });

  it("é case-insensitive e aceita sem dois-pontos", () => {
    const out = stripNavigationBoilerplate("Resumo válido. LEIA MAIS outra coisa");
    assert.equal(out, "Resumo válido.");
  });

  it("reconhece variantes ('leia também', 'veja mais', 'saiba mais', 'continue lendo')", () => {
    assert.equal(stripNavigationBoilerplate("Texto A. Leia também: Texto B"), "Texto A.");
    assert.equal(stripNavigationBoilerplate("Texto A. Veja mais: Texto B"), "Texto A.");
    assert.equal(stripNavigationBoilerplate("Texto A. Saiba mais: Texto B"), "Texto A.");
    assert.equal(stripNavigationBoilerplate("Texto A. Continue lendo: Texto B"), "Texto A.");
  });

  it("texto sem lead-in de navegação passa intacto", () => {
    const out = stripNavigationBoilerplate("A empresa vai investir R$ 10 milhões no projeto.");
    assert.equal(out, "A empresa vai investir R$ 10 milhões no projeto.");
  });

  it("string vazia passa intacta", () => {
    assert.equal(stripNavigationBoilerplate(""), "");
  });
});

describe("fixGluedAcronymDate (#3196)", () => {
  // CASO REAL 260709: "IA29 de maio de 2026" — acrônimo colado numa data completa.
  it("CASO REAL 260709: insere espaço entre 'IA' e a data colada", () => {
    const out = fixGluedAcronymDate(
      "Claude Code: Guia Completo para Programar com IA29 de maio de 2026",
    );
    assert.equal(
      out,
      "Claude Code: Guia Completo para Programar com IA 29 de maio de 2026",
    );
  });

  it("funciona com outros acrônimos curtos (CEO)", () => {
    const out = fixGluedAcronymDate("O novo CEO15 de janeiro de 2026 anúncio");
    assert.equal(out, "O novo CEO 15 de janeiro de 2026 anúncio");
  });

  it("não mexe em texto sem o padrão acrônimo+data colados", () => {
    const out = fixGluedAcronymDate("A IA avançou muito em 2026.");
    assert.equal(out, "A IA avançou muito em 2026.");
  });

  it("não mexe em produtos alfanuméricos legítimos sem data colada (GPT4)", () => {
    const out = fixGluedAcronymDate("O modelo GPT4 foi lançado essa semana.");
    assert.equal(out, "O modelo GPT4 foi lançado essa semana.");
  });

  it("string vazia passa intacta", () => {
    assert.equal(fixGluedAcronymDate(""), "");
  });
});

describe("sanitizeDescriptionBoilerplate — combinado (#3196)", () => {
  // CASO REAL COMPLETO 260709 (USE MELHOR hashtagtreinamentos).
  it("CASO REAL 260709: corta o boilerplate de navegação (a data colada estava DENTRO do trecho cortado)", () => {
    const raw =
      "Existe uma ótima radiografia de… Leia mais: Transição de carreira em dados " +
      "no Brasil... Claude Code: Guia Completo para Programar com IA29 de maio de 2026";
    const out = sanitizeDescriptionBoilerplate(raw);
    // O corte em "Leia mais:" remove TODO o resto, incluindo o "IA29" glued-date —
    // o resultado fica sem boilerplate de navegação (ainda com a reticência
    // herdada, que é responsabilidade do sanitizador #2881 rodar em seguida).
    assert.equal(out, "Existe uma ótima radiografia de…");
    assert.ok(!out.includes("Leia mais"), "boilerplate de navegação removido");
    assert.ok(!out.includes("IA29"), "artefato de data colada não sobrevive (estava após o corte)");
  });

  it("fixa acrônimo+data colados quando NÃO há boilerplate de navegação antes", () => {
    const out = sanitizeDescriptionBoilerplate(
      "Guia Completo para Programar com IA29 de maio de 2026",
    );
    assert.equal(out, "Guia Completo para Programar com IA 29 de maio de 2026");
  });

  it("texto limpo passa intacto", () => {
    const out = sanitizeDescriptionBoilerplate("A empresa vai investir R$ 10 milhões no projeto.");
    assert.equal(out, "A empresa vai investir R$ 10 milhões no projeto.");
  });
});
