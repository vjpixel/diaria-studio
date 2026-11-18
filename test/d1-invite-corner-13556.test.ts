/**
 * #13556 — o selo do vídeo no hero do D1 não pode cobrir o sujeito da arte.
 * O canto era fixo (inferior direito); agora vai ao canto com menos bordas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { estimateInviteTextMetrics, inviteGeometry, pickInviteCorner, buildInviteSvg } from "../scripts/lib/diaria/d1-video-hero.ts";
import { renderD1PlayImage } from "../scripts/lib/diaria/d1-play-image.ts";

const W = 800;
const H = 400;

/** Fundo liso com um bloco "ruidoso" (sujeito) sob o retângulo do canto dado. */
function grayWithSubjectAt(corner: "br" | "bl" | "tr" | "tl"): Uint8Array {
  const m = estimateInviteTextMetrics(W);
  const { pill } = inviteGeometry(W, H, m, corner);
  const g = new Uint8Array(W * H).fill(128);
  for (let y = Math.floor(pill.y); y < pill.y + pill.h; y++)
    for (let x = Math.floor(pill.x); x < pill.x + pill.w; x++) g[y * W + x] = (x + y) % 2 ? 0 : 255;
  return g;
}

describe("pickInviteCorner (#13556)", () => {
  const m = estimateInviteTextMetrics(W);
  it("fundo liso: mantém o inferior direito", () => {
    assert.equal(pickInviteCorner(new Uint8Array(W * H).fill(90), W, H, m), "br");
  });
  it("sujeito no canto inferior direito: foge dele", () => {
    assert.notEqual(pickInviteCorner(grayWithSubjectAt("br"), W, H, m), "br");
  });
  it("sujeito em br e bl: escolhe um canto de cima", () => {
    const g = grayWithSubjectAt("br");
    const b = grayWithSubjectAt("bl");
    for (let i = 0; i < g.length; i++) if (b[i] !== 128) g[i] = b[i];
    assert.match(pickInviteCorner(g, W, H, m), /^t[lr]$/);
  });
  it("geometria por canto fica dentro da imagem e a margem é respeitada", () => {
    for (const c of ["br", "bl", "tr", "tl"] as const) {
      const { pill } = inviteGeometry(W, H, m, c);
      assert.ok(pill.x >= 0 && pill.y >= 0 && pill.x + pill.w <= W && pill.y + pill.h <= H, c);
    }
    assert.match(buildInviteSvg(W, H, m, undefined, "tl"), /<rect x="2[0-9]\.0" y="2[0-9]\.0"/);
  });
  it("renderD1PlayImage: selo não cobre o sujeito (hero com ruído embaixo à direita)", async () => {
    const noise = Buffer.alloc(300 * 150 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 256;
    const hero = await sharp({ create: { width: 1600, height: 800, channels: 3, background: "#808080" } })
      .composite([{ input: noise, raw: { width: 300, height: 150, channels: 3 }, left: 1250, top: 620 }])
      .jpeg().toBuffer();
    const out = await sharp(await renderD1PlayImage(hero)).extract({ left: 1250, top: 620, width: 300, height: 150 }).raw().toBuffer();
    const orig = await sharp(await sharp(hero).jpeg({ quality: 88 }).toBuffer()).extract({ left: 1250, top: 620, width: 300, height: 150 }).raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff += Math.abs(out[i] - orig[i]);
    assert.ok(diff / out.length < 3, `região do sujeito alterada (${diff / out.length})`);
  });
});
