/**
 * test/compress-jpeg.test.ts (#5136)
 *
 * `scripts/image-generate.ts` publicava o JPEG cru do gerador sem re-encode
 * (renameSync direto) — ~1 MB por edição, 45% do peso de fio da página
 * eia/poll (86% na 2ª visita). `scripts/compress-jpeg.ts` é o fix: re-encode
 * JPEG progressivo + mozjpeg @ qualidade 82, sem redimensionar.
 *
 * Disciplina de teste do projeto pra imagem (achado citado na issue #5136):
 * comparar dimensões/formato/tamanho, nunca hash byte-a-byte — o encoder
 * mozjpeg pode variar sutilmente entre plataformas/versões da libjpeg
 * vendorada pelo `sharp`, então travar num hash exato seria frágil sem medir
 * nada que importe de verdade (mesmo padrão de test/assert-brand-font.test.ts,
 * que compara buffers renderizados via sharp em vez de string/hash).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { compressJpegBuffer, DEFAULT_COMPRESS_OPTIONS } from "../scripts/compress-jpeg.ts";

// JPEG sintético com ruído — incompressível o bastante em quality:100 pra
// dar um baseline "cru" comparável ao output real de um gerador de imagem
// (foto/arte real também não é um bloco de cor sólida).
async function makeNoisyJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
}

describe("compressJpegBuffer — perfil de compressão (#5136)", () => {
  it("reduz o tamanho do arquivo em relação ao quality 100 cru", async () => {
    const before = await makeNoisyJpeg(800, 450);
    const after = await compressJpegBuffer(before);
    assert.ok(
      after.length < before.length,
      `esperava after (${after.length} B) < before (${before.length} B)`,
    );
  });

  it("preserva as dimensões — só reencoda, nunca redimensiona", async () => {
    const before = await makeNoisyJpeg(1600, 800);
    const after = await compressJpegBuffer(before);
    const meta = await sharp(after).metadata();
    assert.equal(meta.width, 1600);
    assert.equal(meta.height, 800);
  });

  it("output continua um JPEG válido e progressivo", async () => {
    const before = await makeNoisyJpeg(400, 400);
    const after = await compressJpegBuffer(before);
    const meta = await sharp(after).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.isProgressive, true);
  });

  it("defaults batem com o perfil #5136 (quality 82, mozjpeg, progressive)", () => {
    assert.equal(DEFAULT_COMPRESS_OPTIONS.quality, 82);
    assert.equal(DEFAULT_COMPRESS_OPTIONS.mozjpeg, true);
    assert.equal(DEFAULT_COMPRESS_OPTIONS.progressive, true);
  });

  it("respeita override explícito de quality", async () => {
    const before = await makeNoisyJpeg(800, 450);
    const lowQuality = await compressJpegBuffer(before, { quality: 40 });
    const highQuality = await compressJpegBuffer(before, { quality: 95 });
    assert.ok(
      lowQuality.length < highQuality.length,
      `quality 40 (${lowQuality.length} B) deveria ser menor que quality 95 (${highQuality.length} B)`,
    );
  });
});

describe("compress-jpeg.ts CLI (#5136)", () => {
  it("recompacta um arquivo em disco e escreve o destino comprimido", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compress-jpeg-"));
    try {
      const src = join(dir, "src.jpg");
      const dest = join(dir, "dest.jpg");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(src, await makeNoisyJpeg(800, 450));
      const srcSize = readFileSync(src).length;

      execFileSync(
        process.execPath,
        [
          "--import", "tsx",
          join(process.cwd(), "scripts", "compress-jpeg.ts"),
          src, dest,
          "--quality", "82", "--mozjpeg", "--progressive",
        ],
        { stdio: "pipe" },
      );

      assert.ok(existsSync(dest), "arquivo de destino deveria existir");
      const destBuf = readFileSync(dest);
      assert.ok(destBuf.length < srcSize, "destino deveria ser menor que o original");

      const meta = await sharp(destBuf).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.width, 800);
      assert.equal(meta.height, 450);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suporta reencode in-place (source === dest)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compress-jpeg-inplace-"));
    try {
      const target = join(dir, "img.jpg");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(target, await makeNoisyJpeg(1024, 1024));
      const before = readFileSync(target).length;

      execFileSync(
        process.execPath,
        [
          "--import", "tsx",
          join(process.cwd(), "scripts", "compress-jpeg.ts"),
          target, target,
          "--quality", "82", "--mozjpeg", "--progressive",
        ],
        { stdio: "pipe" },
      );

      const after = readFileSync(target);
      assert.ok(after.length < before, "reencode in-place deveria reduzir o tamanho");
      const meta = await sharp(after).metadata();
      assert.equal(meta.width, 1024);
      assert.equal(meta.height, 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
