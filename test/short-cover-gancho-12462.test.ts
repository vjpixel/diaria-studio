/**
 * #12462 itens 3 e 4 (decisão do editor de 08/11/2026): a capa vertical do
 * Short traz um gancho próprio de 2 a 5 palavras, como o horizontal, e não
 * repete o título do D1. Vale para o corte avulso (`publish-shorts --corte`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  SHORT_COVER_H,
  SHORT_COVER_LETTERING_WINDOW_S,
  SHORT_COVER_PANEL_TOP_RATIO,
  SHORT_COVER_W,
  YOUTUBE_THUMB_MAX_BYTES,
  buildShortCoverPanelSvg,
  composeShortCover,
  normalizeShortCoverHook,
  planShortCoverFrame,
} from "../scripts/lib/diaria/youtube-thumb.ts";

describe("normalizeShortCoverHook (#12462)", () => {
  it("2 a 3 palavras ficam numa linha", () => {
    assert.equal(normalizeShortCoverHook("IA ladra?"), "IA ladra?");
    assert.equal(normalizeShortCoverHook("Google Photos vigia?"), "Google Photos vigia?");
  });

  it("4 e 5 palavras quebram em 2 linhas equilibradas", () => {
    assert.equal(normalizeShortCoverHook("Google Photos te vigia?"), "Google Photos|te vigia?");
    assert.equal(normalizeShortCoverHook("Seu chatbot mente pra você?"), "Seu chatbot mente|pra você?");
  });

  it("quebra explícita do editor é respeitada", () => {
    assert.equal(normalizeShortCoverHook("Confiou no chatbot|e morreu"), "Confiou no chatbot|e morreu");
  });

  it("fora de 2 a 5 palavras recusa", () => {
    assert.throws(() => normalizeShortCoverHook("IA?"), /1 palavra\(s\); a regra é 2 a 5/);
    assert.throws(() => normalizeShortCoverHook("um dois três quatro cinco seis"), /6 palavra\(s\); a regra é 2 a 5/);
    assert.throws(() => normalizeShortCoverHook("   "), /gancho vazio/);
  });

  it("moeda e número contam como 1 palavra, igual ao horizontal (#12278), e a quebra não os separa", () => {
    assert.equal(normalizeShortCoverHook("R$ 100 mil?"), "R$ 100 mil?");
    assert.equal(normalizeShortCoverHook("Perdeu R$ 100 mil pra IA?"), "Perdeu R$ 100 mil|pra IA?");
    assert.throws(() => normalizeShortCoverHook("R$?"), /1 palavra\(s\)/);
  });
});

describe("planShortCoverFrame com gancho (#12462)", () => {
  it("com gancho, frame dentro da janela do lettering vira aviso; depois dela, não", () => {
    const inside = planShortCoverFrame("v.mp4", 1.8, "out.jpg", { withHook: true });
    assert.match(inside.warnings.join("\n"), /título do D1 apareceria junto do gancho/);
    const after = planShortCoverFrame("v.mp4", SHORT_COVER_LETTERING_WINDOW_S + 2, "out.jpg", { withHook: true });
    assert.deepEqual(after.warnings, []);
  });

  it("sem gancho segue a regra antiga (fora da janela avisa)", () => {
    assert.deepEqual(planShortCoverFrame("v.mp4", 1.8, "out.jpg").warnings, []);
    assert.match(planShortCoverFrame("v.mp4", 6, "out.jpg").warnings.join("\n"), /sairia sem o título do D1/);
  });
});

describe("composeShortCover (#12462)", () => {
  it("painel escuro começa na fração pedida e cobre até a base", () => {
    const svg = buildShortCoverPanelSvg();
    const y = Math.round(SHORT_COVER_H * SHORT_COVER_PANEL_TOP_RATIO);
    assert.match(svg, new RegExp(`<rect x="0" y="${y}" width="${SHORT_COVER_W}" height="${SHORT_COVER_H - y}"`));
    assert.throws(() => buildShortCoverPanelSvg(1.2), /--panel-top inválido/);
  });

  it("sai 1080x1920 em JPEG ≤ 2 MB, com a base escurecida e o topo (rosto) intacto", async () => {
    const frame = await sharp({ create: { width: 720, height: 1280, channels: 3, background: { r: 230, g: 230, b: 230 } } }).jpeg().toBuffer();
    const { jpeg, warnings } = await composeShortCover({ frame, hook: "IA ladra?" });
    assert.deepEqual(warnings, []);
    assert.ok(jpeg.length <= YOUTUBE_THUMB_MAX_BYTES);
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, SHORT_COVER_W);
    assert.equal(meta.height, SHORT_COVER_H);
    const px = async (top: number) => {
      const { data } = await sharp(jpeg).extract({ left: 10, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return data[0];
    };
    assert.ok((await px(100)) > 200, "topo (rosto) sem painel");
    assert.ok((await px(SHORT_COVER_H - 20)) < 80, "base coberta pelo painel");
  });

  it("frame fora de 9:16 é recortado no centro, com aviso", async () => {
    const frame = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const { warnings } = await composeShortCover({ frame, hook: "IA ladra?" });
    assert.match(warnings.join("\n"), /não é 9:16/);
  });

  it("gancho inválido recusa antes de qualquer trabalho de imagem", async () => {
    await assert.rejects(composeShortCover({ frame: Buffer.from("x"), hook: "IA?" }), /a regra é 2 a 5/);
  });
});
