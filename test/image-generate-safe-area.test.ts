/**
 * test/image-generate-safe-area.test.ts (#2657)
 *
 * Regressão: garante que STYLE_SUFFIX em scripts/image-generate.ts contém a
 * instrução de safe-area central. Bug 260629: Sol/Terra/Lua distribuídos em
 * toda a largura da composição 2:1 — crop 1:1 central cortou Sol e Lua,
 * deixando só a Terra. O STYLE_SUFFIX é a barreira determinística (independe
 * do prompt do writer-destaque) que instrui Gemini a agrupar sujeitos no centro.
 *
 * Por que testar STYLE_SUFFIX e não só editorial-rules.md?
 * STYLE_SUFFIX é injetado em TODAS as chamadas ao gerador por image-generate.ts
 * — é o único guard que não depende do agente LLM seguir a regra. Se alguém
 * remover a instrução de safe-area do STYLE_SUFFIX, este teste falha.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STYLE_SUFFIX } from "../scripts/image-generate.ts";

describe("image-generate STYLE_SUFFIX — safe-area central (#2657)", () => {
  it("contém instrução de agrupar sujeitos no centro do frame", () => {
    assert.match(
      STYLE_SUFFIX,
      /central half|subjects.*grouped|grouped.*central/i,
      "STYLE_SUFFIX deve instruir Gemini a agrupar sujeitos na metade central para safe-area do crop 1:1",
    );
  });

  it("menciona proibição de elementos nas bordas laterais", () => {
    assert.match(
      STYLE_SUFFIX,
      /do not place.*(?:left|right|edges)|near the.*edges|left or right edges/i,
      "STYLE_SUFFIX deve proibir sujeitos principais nas bordas laterais",
    );
  });

  it("mantém instrução de Van Gogh impasto (regressão STYLE_SUFFIX existente)", () => {
    assert.match(STYLE_SUFFIX, /impasto/i, "STYLE_SUFFIX deve manter estilo Van Gogh impasto");
  });

  it("mantém instrução anti-texto (regressão STYLE_SUFFIX existente)", () => {
    assert.match(
      STYLE_SUFFIX,
      /no written characters|no letters/i,
      "STYLE_SUFFIX deve manter instrução anti-texto do #1241",
    );
  });

  it("não contém referência a 'Noite Estrelada' nem 'Starry Night' (regressão)", () => {
    assert.doesNotMatch(
      STYLE_SUFFIX,
      /noite estrelada|starry night/i,
      "STYLE_SUFFIX não deve referenciar Noite Estrelada",
    );
  });
});
