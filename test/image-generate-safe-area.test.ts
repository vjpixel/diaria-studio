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
import { STYLE_SUFFIX, styleSuffixFor, buildPositivePrompt, type ImageRatio } from "../scripts/image-generate.ts";

// #12422: o sufixo antigo dizia que uma arte única era recortada em 2:1, 4:5 e
// 9:16. O Stage 3 gera 2:1 e 4:5 nativo em chamadas separadas e 9:16 não existe.
describe("image-generate styleSuffixFor — sufixo por formato (#12422)", () => {
  const ALL: ImageRatio[] = ["2x1", "4x5", "1x1", "master"];
  const OWN: Record<ImageRatio, RegExp> = {
    "2x1": /wide 2:1 landscape image \(1600×800\)/,
    "4x5": /portrait 4:5 image \(1080×1350\)/,
    "1x1": /1:1 image \(1024×1024\)/,
    master: /6:5 image \(1600×1350\)/,
  };

  for (const r of ALL) {
    it(`${r}: cita o próprio formato e não descreve recorte de arte única nem 9:16`, () => {
      const s = styleSuffixFor(r);
      assert.match(s, OWN[r]);
      assert.doesNotMatch(s, /cropped/i, "nenhum formato é recorte de outra arte no gerador");
      assert.doesNotMatch(s, /9:16/);
      assert.doesNotMatch(s, /single artwork/i);
      for (const other of ALL.filter((o) => o !== r)) {
        assert.doesNotMatch(s, OWN[other], `${r} não pode citar o formato de ${other}`);
      }
    });

    it(`${r}: mantém os guards compartilhados`, () => {
      const s = styleSuffixFor(r);
      assert.match(s, /impasto/i);
      assert.match(s, /calm, even fields of color/);
      assert.match(s, /human, robot, or humanoid/);
      assert.match(s, /cut off the top of the head/);
      assert.match(s, /bottom fifth/);
      assert.match(s, /no faces, hands or key objects/);
      assert.match(s, /no written characters/);
      assert.match(s, /left or right edges/);
      assert.match(s, /never touch any edge/);
      assert.doesNotMatch(s, /starry night|swirl/i);
    });
  }

  it("STYLE_SUFFIX é o sufixo do 2:1 (formato padrão dos destaques)", () => {
    assert.equal(STYLE_SUFFIX, styleSuffixFor("2x1"));
  });

  it("buildPositivePrompt usa o sufixo do ratio pedido", () => {
    const p = buildPositivePrompt("# Cena\nUm **robô** lê.", "4x5");
    assert.ok(p.startsWith("Cena Um robô lê."));
    assert.ok(p.endsWith(styleSuffixFor("4x5")));
    assert.ok(!p.includes(styleSuffixFor("2x1")));
  });
});

describe("image-generate STYLE_SUFFIX — safe-area central (#2657)", () => {
  it("contém instrução de agrupar sujeitos no centro do frame", () => {
    assert.match(
      STYLE_SUFFIX,
      /central half|subjects.*grouped|grouped.*central/i,
      "STYLE_SUFFIX deve instruir Gemini a agrupar sujeitos na metade central para safe-area do crop 4:5",
    );
  });

  // #12309: o crop 1:1 deixou de ser gerado no #12226. A frase da metade
  // central passou a justificar-se pelo card 4:5, e nenhum trecho do sufixo
  // pode voltar a pedir composição para um quadrado que não existe mais.
  it("#12309: safe-area central cita o card 4:5 e não o crop quadrado 1:1", () => {
    assert.match(
      STYLE_SUFFIX,
      /central half of the horizontal frame[^.]*portrait 4:5 feed card/i,
      "a frase da metade central deve citar o card 4:5",
    );
    assert.doesNotMatch(STYLE_SUFFIX, /1:1/, "STYLE_SUFFIX não deve mencionar 1:1");
    assert.doesNotMatch(STYLE_SUFFIX, /\bsquare\b/i, "STYLE_SUFFIX não deve mencionar square");
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

  // Edição 260727: D2 e D3 decapitados nos formatos retrato. A zona segura
  // "central 67% × 59%" era a interseção dos crops de uma arte única (master),
  // fluxo aposentado no #12422; o que fica é a margem em todas as bordas.
  it("mantém elementos essenciais longe de todas as bordas", () => {
    assert.match(STYLE_SUFFIX, /never touch any edge/i);
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
