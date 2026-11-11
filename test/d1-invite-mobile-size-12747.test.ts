/**
 * #12747 — o convite do vídeo escrito na imagem do D1 ("Clique para assistir
 * meus comentários") saía com `font-size` = 2,4% da largura do hero. No
 * celular o hero encolhe para ~330px e o convite ficava com ~8px, contra os
 * 16px do corpo do e-mail logo abaixo. Regressão: no celular de referência
 * (360px de viewport, menos o recuo lateral), o convite tem pelo menos o
 * tamanho do corpo, e a faixa ainda cabe no canto sem tomar a imagem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  D1_HERO_MOBILE_WIDTH_PX,
  D1_INVITE_FONT_FAMILY,
  D1_INVITE_LINES,
  D1_INVITE_TEXT,
  EMAIL_BODY_FONT_PX,
  buildInviteSvg,
  inviteGeometry,
} from "../scripts/lib/diaria/d1-video-hero.ts";
import { measureInviteText } from "../scripts/lib/diaria/d1-play-image.ts";
import { LAYOUT } from "../scripts/lib/shared/design-tokens.ts";

/** Hero do D1 gerado no Stage 3 (2:1). */
const HERO_W = 1600;
const HERO_H = 800;

function svgFontSizes(svg: string): number[] {
  return [...svg.matchAll(/<text [^>]*font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
}

describe("#12747 — convite do D1 do tamanho do corpo no celular", () => {
  it("referência do celular: 360px de viewport menos o recuo lateral da seção", () => {
    assert.equal(EMAIL_BODY_FONT_PX, 16);
    assert.equal(D1_HERO_MOBILE_WIDTH_PX, 360 - 2 * LAYOUT.sidePad);
  });

  it("font-size desenhado no SVG, visto na largura do celular, é >= o corpo do e-mail (16px)", () => {
    for (const W of [HERO_W, 1200, 800]) {
      const sizes = svgFontSizes(buildInviteSvg(W, W / 2));
      assert.equal(sizes.length, D1_INVITE_LINES.length, "um <text> por linha");
      for (const fs of sizes) {
        const onPhone = (fs / W) * D1_HERO_MOBILE_WIDTH_PX;
        // Folga de 0,1px pelo arredondamento do `toFixed(1)` do SVG.
        assert.ok(onPhone >= EMAIL_BODY_FONT_PX - 0.1, `largura ${W}: convite a ${onPhone.toFixed(1)}px no celular, corpo é ${EMAIL_BODY_FONT_PX}px`);
        // Piso absoluto independente das constantes: o valor antigo (2,4%) e
        // qualquer coisa abaixo de ~4,5% da largura reprova.
        assert.ok(fs / W >= 0.045, `largura ${W}: font-size ${(100 * fs / W).toFixed(2)}% da largura`);
      }
    }
  });

  it("com a fonte real (e a de reserva), a faixa cabe no canto inferior direito sem tomar a imagem", async () => {
    for (const family of [D1_INVITE_FONT_FAMILY, "NoSuchFontXYZ"]) {
      const m = await measureInviteText(HERO_W, family);
      const { pill, fontSize } = inviteGeometry(HERO_W, HERO_H, m);
      const margin = HERO_W * 0.03;
      assert.ok(pill.x >= margin && pill.y >= margin, `${family}: faixa inteira dentro do hero, com margem`);
      assert.ok(pill.x + pill.w <= HERO_W - margin + 0.5 && pill.y + pill.h <= HERO_H - margin + 0.5, `${family}: margem direita/inferior`);
      assert.ok(pill.w <= HERO_W * 0.75, `${family}: faixa com ${(100 * pill.w / HERO_W).toFixed(0)}% da largura`);
      assert.ok(pill.h <= HERO_H * 0.4, `${family}: faixa com ${(100 * pill.h / HERO_H).toFixed(0)}% da altura`);
      assert.ok(m.textW < 12 * fontSize, `${family}: cada linha cabe (${(m.textW / fontSize).toFixed(1)} em)`);
    }
  });

  it("as duas linhas juntas são o convite inteiro (alt e checagem do Stage 5 usam D1_INVITE_TEXT)", () => {
    assert.equal(D1_INVITE_LINES.join(" "), D1_INVITE_TEXT);
  });

  it("imagem estreita demais para o convite lança (fail-soft tira o link) em vez de cortar o texto", () => {
    assert.throws(() => inviteGeometry(1600, 150), /não cabe/);
  });
});
