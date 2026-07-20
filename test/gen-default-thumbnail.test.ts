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

import { buildSvg, TAGLINE_LINE_1, TAGLINE_LINE_2 } from "../scripts/gen-default-thumbnail.ts";

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
  const block = blocks.find((b) => b.includes(TAGLINE_LINE_1));
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
    assert.ok(svg.includes(TAGLINE_LINE_1));
    assert.ok(svg.includes(TAGLINE_LINE_2));
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
    const estimatedLineWidth = maxLineLen * fontSize * 0.52 + (maxLineLen - 1) * 0.4;
    assert.ok(
      estimatedLineWidth <= W - pad * 2,
      `linha estimada (${estimatedLineWidth}px) estoura a área útil (${W - pad * 2}px)`,
    );
  });

  it("as 2 linhas da tagline ficam verticalmente entre o wordmark e o hint de URL (sem sobreposição)", () => {
    const svg = buildSvg();
    const y1Raw = findTextY(svg, "5 minutos");
    const y2Raw = findTextY(svg, "atualizado");
    assert.ok(y1Raw !== null && y2Raw !== null, "deveria encontrar as posições Y das 2 linhas da tagline");
    const y1 = y1Raw!;
    const y2 = y2Raw!;
    const wordmarkUnderlineY = 315 + 4; // fim do <rect> do underline
    const urlHintY = H - 48;
    assert.ok(y1 > wordmarkUnderlineY, "linha 1 deve ficar abaixo do underline do wordmark");
    assert.ok(y2 > y1, "linha 2 deve ficar abaixo da linha 1");
    assert.ok(y2 < urlHintY - 40, "linha 2 não deve colidir com o hint de URL no rodapé");
  });
});
