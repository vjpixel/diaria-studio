/**
 * test/gemini-image.test.ts (#6459)
 *
 * Edição 260828: a imagem B do EIA (águia-cobreira via Gemini) saiu com a
 * cabeça cortada no topo do frame — 2 gerações consecutivas com o mesmo
 * prompt reproduziram o corte; só a 3ª tentativa, com headroom pedido à mão
 * no prompt, saiu correta. `scripts/gemini-image.js` fazia
 * `sharp(trimmed).resize(w, h, { fit: 'cover' })` sem `position` explícito
 * (default `'centre'`) — crop uniforme em todos os lados, que corta o topo
 * quando o sujeito gerado já está próximo da borda superior.
 *
 * Fix de 2 pontas, os dois cobertos aqui:
 *   1. `buildPrompt` — instrução de headroom explícita, junto do "fill
 *      entire canvas" já existente (influencia o que o Gemini GERA).
 *   2. `buildResizeOptions` — `position: sharp.strategy.attention` em vez do
 *      default `'centre'` (rede de segurança determinística no CROP, cobre
 *      o caso em que o prompt sozinho não bastar, como aconteceu 2x na
 *      edição real antes da 3ª tentativa manual).
 *
 * Sem chamada real à API do Gemini — só as duas funções puras exportadas.
 * `buildResizeOptions` é testado tanto pelo valor da opção quanto por um
 * crop de verdade via sharp (imagem sintética com o "sujeito" perto do
 * topo), pra travar que 'attention' de fato preserva o topo onde 'centre'
 * cortaria — e que o caso comum (sujeito centralizado) não regride.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildPrompt, buildResizeOptions } from "../scripts/gemini-image.js";

describe("buildPrompt (#6459)", () => {
  it("inclui instrução explícita de headroom acima do sujeito", () => {
    const prompt = buildPrompt({ positive: "a snake eagle perched on a branch" });
    assert.match(prompt, /headroom/i);
    assert.match(prompt, /never touching or almost touching the top edge/i);
  });

  it("mantém a instrução pré-existente de preencher o canvas inteiro", () => {
    const prompt = buildPrompt({ positive: "a snake eagle" });
    assert.match(prompt, /fill the ENTIRE image edge to edge/i);
  });

  it("preserva o texto positivo original e o negative prompt quando presente", () => {
    const prompt = buildPrompt({ positive: "base description", negative: "watermark, text" });
    assert.match(prompt, /^base description/);
    assert.match(prompt, /watermark, text/);
  });

  it("não quebra quando negative está ausente", () => {
    const prompt = buildPrompt({ positive: "base description" });
    assert.doesNotMatch(prompt, /undefined/);
  });
});

describe("buildResizeOptions (#6459)", () => {
  it("usa fit:cover com position:attention (saliency), não o default centre", () => {
    const opts = buildResizeOptions();
    assert.equal(opts.fit, "cover");
    assert.equal(opts.position, sharp.strategy.attention);
  });

  it("crop com attention preserva mais do topo que centre quando o sujeito está perto da borda superior", async () => {
    // Imagem sintética: faixa de alta saliência (ruído colorido, "sujeito")
    // no terço superior, resto uniforme (fundo liso) — mimetiza uma
    // composição gerada com a cabeça perto do topo do frame, como no
    // incidente real (águia-cobreira, edição 260828).
    const width = 800;
    const height = 800;
    const subjectBandHeight = 150; // faixa "sujeito" nas primeiras linhas

    const background = await sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();

    const subjectBand = await sharp({
      create: { width, height: subjectBandHeight, channels: 3, background: { r: 0, g: 0, b: 0 }, noise: { type: "gaussian", mean: 128, sigma: 60 } },
    })
      .png()
      .toBuffer();

    const source = await sharp(background)
      .composite([{ input: subjectBand, top: 0, left: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // Alvo 800x450 — mesmo aspect ratio do EIA (2:1), força crop vertical.
    const targetW = 800;
    const targetH = 450;

    const attentionCrop = await sharp(source)
      .resize(targetW, targetH, buildResizeOptions())
      .raw()
      .toBuffer({ resolveWithObject: true });

    const centreCrop = await sharp(source)
      .resize(targetW, targetH, { fit: "cover" }) // default position: 'centre'
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Média de luminância da 1ª linha do resultado: se o topo (faixa ruidosa,
    // média ~128) sobreviveu ao crop, a linha 0 tem média bem acima do fundo
    // liso (40). Com 'centre' num crop vertical de 800x800→800x450, a janela
    // fica no meio da imagem e a faixa de 150px do topo já não aparece mais
    // na linha 0 — cai no fundo escuro.
    function firstRowMean(buf: Buffer, channels: number): number {
      let sum = 0;
      const rowBytes = targetW * channels;
      for (let i = 0; i < rowBytes; i++) sum += buf[i];
      return sum / rowBytes;
    }

    const attentionMean = firstRowMean(attentionCrop.data, attentionCrop.info.channels);
    const centreMean = firstRowMean(centreCrop.data, centreCrop.info.channels);

    assert.ok(
      attentionMean > centreMean,
      `esperava attention (${attentionMean.toFixed(1)}) preservar mais do topo que centre (${centreMean.toFixed(1)})`,
    );
  });

  it("caso comum (sujeito centralizado) — crop com attention ainda produz as dimensões pedidas", async () => {
    // Regressão inversa: garantir que a mudança de position não quebra o
    // caso majoritário (composição já centralizada) — resize deve sempre
    // sair com exatamente as dimensões pedidas, independente de onde a
    // saliência mais forte cair.
    const source = await sharp({
      create: { width: 900, height: 900, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 30 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const resized = await sharp(source)
      .resize(800, 450, buildResizeOptions())
      .jpeg({ quality: 90 })
      .toBuffer();

    const meta = await sharp(resized).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 450);
  });
});
