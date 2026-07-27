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

  it("#3633: contém instrução de headroom vertical para figuras em pé", () => {
    assert.match(
      STYLE_SUFFIX,
      /margin above the head|headroom/i,
      "STYLE_SUFFIX deve instruir margem/headroom acima da cabeça para figuras antropomórficas em pé",
    );
  });

  it("#3633: proíbe explicitamente cortar o topo da cabeça", () => {
    assert.match(
      STYLE_SUFFIX,
      /never crop.*(?:top of the head|head)|cut off the top of the head/i,
      "STYLE_SUFFIX deve proibir explicitamente o corte do topo da cabeça",
    );
  });

  it("#3633: instrução de headroom cobre figuras humanas, robóticas e humanoides", () => {
    assert.match(
      STYLE_SUFFIX,
      /human, robot, or humanoid/i,
      "STYLE_SUFFIX deve cobrir figuras humanas/robóticas/humanoides, não só robôs",
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

  // A arte 2:1 do e-mail também vira card de feed (4:5) e story (9:16). Antes,
  // a safe-area só falava do crop 1:1 — os formatos retrato cortavam figura
  // (edição 260727: D2 e D3 decapitados, 2 regenerações manuais no gate).
  it("instrui composição para os crops RETRATO (4:5 e 9:16), não só 1:1", () => {
    assert.match(
      STYLE_SUFFIX,
      /4:5|9:16|portrait/i,
      "STYLE_SUFFIX deve mencionar os formatos retrato derivados",
    );
    assert.match(
      STYLE_SUFFIX,
      /central 67% of the width/i,
      "zona segura horizontal = interseção com o crop retrato (1080 de 1600)",
    );
    assert.match(
      STYLE_SUFFIX,
      /central 59% of the height/i,
      "zona segura vertical = interseção com o crop wide (800 de 1350)",
    );
  });

  // O título do card é sobreposto na base da imagem: sem área calma reservada,
  // o texto cai sobre rosto/mão/objeto-chave (caso do D3 na 260727).
  it("reserva a base do quadro para o texto que entra depois", () => {
    assert.match(
      STYLE_SUFFIX,
      /bottom fifth|headline will later be placed/i,
      "STYLE_SUFFIX deve reservar a faixa inferior pro headline sobreposto",
    );
    assert.match(
      STYLE_SUFFIX,
      /no faces, hands or key objects/i,
      "a faixa reservada deve excluir explicitamente rosto, mãos e objetos-chave",
    );
  });
});
