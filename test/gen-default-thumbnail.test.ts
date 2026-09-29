/**
 * gen-default-thumbnail.test.ts (#3705)
 *
 * Regressão: o Default Thumbnail Preview (og:image, Beehiiv Settings →
 * General, 1200×630) estava numa forma pré-#3577 da tagline ("Seu filtro no
 * caos de notícias sobre IA") no asset ao vivo, e o gerador `gen-default-thumbnail.ts`
 * nunca incluiu tagline nenhuma (só o subtítulo genérico "newsletter diária de
 * IA"). Este teste guarda que o SVG gerado contém a tagline oficial ATUAL
 * (plural, #3695) e nenhuma forma antiga — singular, ou as variantes
 * pré-unificação (#3577) — volta por engano.
 *
 * Segue o padrão de test/gen-social-banner.test.ts: guard de tagline +
 * guard de não-overflow (clamp width-based do font-size).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSvg, TAGLINE_LINE_1, TAGLINE_LINE_2, MONO_CHAR_EM } from "../scripts/gen-default-thumbnail.ts";

const W = 1200;
const H = 630;

/** Acha o `<text ...>needle` que contém `needle` e extrai seu atributo y=.
 * Split por `<text` em vez de regex com [\s\S]*? sem limite — o template tem
 * atributos em linhas separadas, então um regex "y=\"(\\d+)\"[\\s\\S]*?>needle"
 * sem escopo por tag acabaria casando o y= do PRIMEIRO <text> do documento
 * (o wordmark) e só then expandindo até achar `needle` bem mais adiante. */
function findTextY(svg: string, needle: string): number | null {
  const blocks = svg.split("<text").slice(1);
  const block = blocks.find((b) => b.includes(needle));
  if (!block) return null;
  const m = block.match(/y="(\d+)"/);
  return m ? Number(m[1]) : null;
}

/** Mesmo raciocínio de findTextY: extrai o font-size do bloco `<text>` da
 * tagline (identificado pela 1ª linha da tagline), não via regex solto pelo
 * documento inteiro. */
function findTaglineFontSize(svg: string): number | null {
  const blocks = svg.split("<text").slice(1);
  const block = blocks.find((b) => b.includes(TAGLINE_LINE_1.toLocaleUpperCase("pt-BR")));
  if (!block) return null;
  const m = block.match(/font-size="(\d+)"/);
  return m ? Number(m[1]) : null;
}

describe("gen-default-thumbnail (#3705)", () => {
  it("SVG contém as dimensões corretas (1200x630)", () => {
    const svg = buildSvg();
    assert.match(svg, new RegExp(`width="${W}" height="${H}"`));
  });

  it("tagline oficial plural presente no SVG", () => {
    const svg = buildSvg();
    // DS: tagline renderizada em CAIXA ALTA (mono), texto-fonte em sentence case.
    assert.ok(svg.includes(TAGLINE_LINE_1.toLocaleUpperCase("pt-BR")));
    assert.ok(svg.includes(TAGLINE_LINE_2.toLocaleUpperCase("pt-BR")));
    assert.match(TAGLINE_LINE_2, /as IAs\.?$/);
  });

  it("nenhuma forma antiga da tagline presente (singular #3695, pré-unificação #3577, subtítulo genérico substituído)", () => {
    const svg = buildSvg();
    const combined = `${TAGLINE_LINE_1} ${TAGLINE_LINE_2}`;
    assert.doesNotMatch(combined, /melhor a IA\b/i);
    assert.ok(!svg.includes("Seu filtro no caos de notícias sobre IA"));
    assert.ok(!svg.includes("As notícias essenciais sobre IA em 5 minutos"));
    assert.ok(
      !svg.includes("newsletter diária de IA"),
      "o subtítulo genérico antigo deveria ter sido substituído pela tagline",
    );
  });

  it("font-size da tagline não estoura a largura disponível do canvas", () => {
    const svg = buildSvg();
    // Escopo por bloco de <text> (via findTaglineFontSize), não regex solto:
    // um "font-size=\"(\\d+)\"[\\s\\S]*?letter-spacing=\"0\\.4\"" sem escopo por
    // tag casaria o font-size="102" do WORDMARK (1ª ocorrência no documento) e só
    // então expandiria até o letter-spacing="0.4" da tagline, bem mais adiante —
    // mesma classe de bug do findTextY acima.
    const fontSizeRaw = findTaglineFontSize(svg);
    assert.ok(fontSizeRaw !== null, "deveria encontrar o font-size da tagline no SVG");
    const fontSize = fontSizeRaw!;
    const pad = 80;
    const maxLineLen = Math.max(TAGLINE_LINE_1.length, TAGLINE_LINE_2.length);
    // mesma estimativa conservadora (0.52em/char, sans regular) usada no clamp —
    // a largura estimada da linha mais longa nunca deve exceder a área útil.
    const estimatedLineWidth = maxLineLen * fontSize * (MONO_CHAR_EM + 0.06);
    assert.ok(
      estimatedLineWidth <= W - pad * 2,
      `linha estimada (${estimatedLineWidth}px) estoura a área útil (${W - pad * 2}px)`,
    );
  });

  it("as 2 linhas da tagline ficam verticalmente entre o wordmark e o hint de URL (sem sobreposição)", () => {
    const svg = buildSvg();
    const y1Raw = findTextY(svg, "5 MINUTOS");
    const y2Raw = findTextY(svg, "ATUALIZADO");
    assert.ok(y1Raw !== null && y2Raw !== null, "deveria encontrar as posições Y das 2 linhas da tagline");
    const y1 = y1Raw!;
    const y2 = y2Raw!;
    const wordmarkBottomY = 290 + 30; // baseline do wordmark + descendentes
    const urlHintY = H - 100; // hairline do rodapé
    assert.ok(y1 > wordmarkBottomY, "linha 1 deve ficar abaixo do wordmark");
    assert.ok(y2 > y1, "linha 2 deve ficar abaixo da linha 1");
    assert.ok(y2 < urlHintY - 20, "linha 2 não deve colidir com o rodapé");
  });

  it("DS: teal nunca em barra/borda/ponto — só texto (wordmark, domínio)", () => {
    const svg = buildSvg();
    const shapes = svg.match(/<(rect|circle)[^>]*>/g) ?? [];
    for (const sh of shapes) {
      assert.ok(!/fill="#00A0A0"/i.test(sh), `forma teal proibida pelo DS: ${sh}`);
    }
    assert.ok(!svg.includes("<circle"), "sem pontos decorativos");
  });

  it("wordmark segue o logo.svg do DS: Georgia bold, \".br\" em teal", () => {
    const svg = buildSvg();
    assert.ok(svg.includes('>diar<tspan fill="#00A0A0">.</tspan>ia<tspan fill="#00A0A0">.br</tspan>'));
    assert.match(svg, /font-weight="700"[^>]*>diar</);
  });
});
