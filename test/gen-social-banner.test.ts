/**
 * gen-social-banner.test.ts (#3695)
 *
 * Guarda o texto/dimensões dos banners de LinkedIn/Facebook: tagline plural
 * atual presente, forma singular antiga ausente, e nenhuma linha estoura o
 * canvas (regressão pro overflow visto na 1ª versão do Facebook, corrigido
 * com o clamp width-based em buildBannerSvg).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBannerSvg,
  BANNER_SPECS,
  TAGLINE_LINE_1,
  TAGLINE_LINE_2,
} from "../scripts/gen-social-banner.ts";

describe("gen-social-banner (#3695)", () => {
  it("tagline plural presente, forma singular antiga ausente", () => {
    assert.match(TAGLINE_LINE_2, /AS IAS$/);
    assert.doesNotMatch(`${TAGLINE_LINE_1} ${TAGLINE_LINE_2}`, /MELHOR A IA\b/);
  });

  for (const spec of Object.values(BANNER_SPECS)) {
    it(`${spec.key}: SVG contém as 2 linhas da tagline e as dimensões corretas`, () => {
      const svg = buildBannerSvg(spec.width, spec.height);
      assert.match(svg, new RegExp(`width="${spec.width}" height="${spec.height}"`));
      assert.ok(svg.includes(TAGLINE_LINE_1));
      assert.ok(svg.includes(TAGLINE_LINE_2));
    });

    it(`${spec.key}: font-size da tagline não estoura a largura disponível`, () => {
      const svg = buildBannerSvg(spec.width, spec.height);
      const sizeMatch = svg.match(/font-size="(\d+)" font-weight="700" letter-spacing="1"/);
      assert.ok(sizeMatch, "deveria encontrar o font-size da tagline no SVG");
      const fontSize = Number(sizeMatch![1]);
      const pad = Math.round(spec.height * 0.12);
      const maxLineLen = Math.max(TAGLINE_LINE_1.length, TAGLINE_LINE_2.length);
      // mesma estimativa conservadora (0.65em/char) usada no clamp — a largura
      // estimada da linha mais longa nunca deve exceder a área útil do canvas.
      const estimatedLineWidth = maxLineLen * fontSize * 0.65 + (maxLineLen - 1) * 1;
      assert.ok(
        estimatedLineWidth <= spec.width - pad * 2,
        `linha estimada (${estimatedLineWidth}px) estoura a área útil (${spec.width - pad * 2}px) em ${spec.key}`,
      );
    });
  }
});
