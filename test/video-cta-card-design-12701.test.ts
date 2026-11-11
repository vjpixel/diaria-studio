/**
 * test/video-cta-card-design-12701.test.ts
 *
 * #12701 — o card de CTA gerado (#12571) divergia do card aprovado pelo editor
 * (PNGs de `YouTube/_marca/`, feitos por `_marca/mkcard.cjs`): itens em
 * Georgia 58 px ocupando ~1/3 da largura, ícone de "share" de 3 nós em vez
 * da seta de envio, bloco compacto. Estes testes travam as medidas do
 * aprovado no SVG gerado (puro, independente da fonte instalada) e, no
 * raster, a ocupação da largura e as dimensões dos dois formatos.
 *
 * Conferência pixel a pixel contra os PNGs aprovados (fora do repo, no Drive)
 * feita no 300 em 10/11/2026: diferença média 0 nos 3 casos (vertical e
 * horizontal default, vertical "quem joga no PC" da 261109-nvidia).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  CTA_CARD_DEFAULT_SHARE,
  CTA_CARD_DESIGN,
  ctaCardLayout,
  ctaCardShareLines,
  ctaCardSvg,
  ctaShareLine,
  georgiaTextWidth,
} from "../scripts/lib/diaria/video-cta-card.ts";

const fontSizes = (svg: string): number[] => [...svg.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));

describe("card de CTA: medidas do card aprovado (#12701)", () => {
  it("tipografia do aprovado: 'Gostou?' 124 px negrito e itens 66 px, texto a partir de x = 300", () => {
    const svg = ctaCardSvg({ width: 1080, height: 1920 });
    assert.deepEqual(fontSizes(svg).sort((a, b) => a - b), [66, 124]);
    assert.match(svg, /<text x="540" y="560"[^>]*font-size="124" font-weight="700"[^>]*>Gostou\?</);
    assert.match(svg, /<rect x="440" y="610" width="200" height="10" fill="#00A0A0"\/>/);
    assert.match(svg, /<text x="300" y="822">Curta o vídeo<\/text>/);
    assert.match(svg, /<text x="300" y="1030">Compartilhe com<\/text>/);
    assert.match(svg, /<text x="300" y="1110">quem se interessa por IA<\/text>/);
    assert.match(svg, /<text x="300" y="1322">Siga a diar\.ia\.br<\/text>/);
  });

  it("ícone de compartilhar = seta de envio teal (avião de papel), não os 3 nós do 'share'", () => {
    const svg = ctaCardSvg({ width: 1080, height: 1920 });
    assert.match(svg, /<g transform="translate\(200,1010\)"><path d="M-42,-38 L46,0 L-42,38 L-26,0 Z" fill="#00A0A0"\/><\/g>/);
    // Só um <circle> no card inteiro: o do "+" de seguir (o "share" antigo tinha 3 nós + 2 linhas).
    assert.equal((svg.match(/<circle/g) ?? []).length, 1);
    assert.doesNotMatch(svg, /<line /);
    // Coração e "+" nos centros do aprovado.
    assert.match(svg, /<g transform="translate\(200,800\)"><path d="M0,-28 /);
    assert.match(svg, /<g transform="translate\(200,1300\)"><circle r="45"/);
  });

  it("o texto ocupa a largura toda: a linha mais longa do default chega perto da borda (≈1022 de 1080), sem encolher", () => {
    const L = ctaCardLayout(1080, 1920, CTA_CARD_DEFAULT_SHARE);
    assert.ok(L.itemsRight > 1000 && L.itemsRight < CTA_CARD_DESIGN.textRight, `borda direita estimada ${L.itemsRight}`);
    assert.equal(L.itemScale, 1);
    // Largura do texto ≥ 2/3 do quadro (na 1ª versão o bloco ocupava ~1/3).
    assert.ok((L.itemsRight - CTA_CARD_DESIGN.textX) / 1080 > 0.66);
    // A tabela de avanços bate com a medida do PNG aprovado ("quem se interessa por IA" ≈ 722 px em 66 px).
    assert.ok(Math.abs(georgiaTextWidth("quem se interessa por IA", 66) - 722) < 8);
  });

  it("horizontal 1920x1080: o mesmo desenho a 0,85, centrado (translate 501, -220.75), como no mkcard.cjs", () => {
    const svg = ctaCardSvg({ width: 1920, height: 1080 });
    assert.match(svg, /<g transform="translate\(501,-220\.75\) scale\(0\.85\)">/);
    assert.deepEqual(fontSizes(svg).sort((a, b) => a - b), [66, 124]);
    const L = ctaCardLayout(1920, 1080, CTA_CARD_DEFAULT_SHARE);
    assert.equal(L.scale, 0.85);
  });

  it("vertical em outro tamanho (prévia 720x1280) escala o mesmo desenho", () => {
    const L = ctaCardLayout(720, 1280, CTA_CARD_DEFAULT_SHARE);
    assert.ok(Math.abs(L.scale - 720 / 1080) < 1e-9);
    assert.equal(L.tx, 0);
    assert.ok(Math.abs(L.ty) < 1e-9);
  });

  it("complemento curto fica numa linha (261109-nvidia: 'quem joga no PC'); longo quebra pela largura e desce o item de seguir", () => {
    assert.deepEqual(ctaCardShareLines(ctaShareLine("quem joga no PC")), ["Compartilhe com", "quem joga no PC"]);
    const longShare = ctaShareLine("quem trabalha com modelos de linguagem em empresas brasileiras");
    const lines = ctaCardShareLines(longShare);
    assert.equal(lines[0], "Compartilhe com");
    assert.ok(lines.length >= 3, JSON.stringify(lines));
    for (const l of lines) assert.ok(CTA_CARD_DESIGN.textX + georgiaTextWidth(l, 66) <= CTA_CARD_DESIGN.textRight, l);
    const extra = (lines.length - 2) * 80;
    const svg = ctaCardSvg({ width: 1080, height: 1920, share: longShare });
    assert.match(svg, new RegExp(`<text x="300" y="${1322 + extra}">Siga a diar\\.ia\\.br</text>`));
  });

  it("palavra que não cabe nem sozinha: só o bloco dos itens encolhe, ancorado na borda dos ícones", () => {
    const L = ctaCardLayout(1080, 1920, "Compartilhe com quem diz supercalifragilisticexpialidociousmente");
    assert.ok(L.itemScale < 1);
    const svg = ctaCardSvg({ width: 1080, height: 1920, share: "quem diz supercalifragilisticexpialidociousmente" });
    assert.match(svg, /<g font-family="[^"]*" font-size="66" fill="#FFFFFF" transform="translate\(155,1060\) scale\(0\.\d+\) translate\(-155,-1060\)">/);
  });

  it("raster: dimensões 1080x1920 e 1920x1080, e o texto dos itens vai além de 85% da largura na vertical", async () => {
    for (const [w, h] of [[1080, 1920], [1920, 1080]] as const) {
      const meta = await sharp(Buffer.from(ctaCardSvg({ width: w, height: h }))).png().metadata();
      assert.equal(meta.width, w);
      assert.equal(meta.height, h);
    }
    const { data, info } = await sharp(Buffer.from(ctaCardSvg({ width: 1080, height: 1920 }))).greyscale().raw().toBuffer({ resolveWithObject: true });
    // Faixa da 2ª linha do compartilhar (baseline 1110): borda direita da tinta branca.
    let right = -1;
    for (let y = 1050; y < 1130; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x] > 128) right = Math.max(right, x);
    assert.ok(right > 0.85 * 1080, `borda direita da tinta: ${right}`);
  });
});
