/**
 * test/crop-resize.test.ts (#5136)
 *
 * `scripts/crop-resize.ts` ganhou `--quality`/`--mozjpeg`/`--progressive`
 * (#5136) pra `scripts/image-generate.ts` conseguir pedir o perfil de
 * compressão menor nos crops 1:1 derivados sem mudar o comportamento dos
 * outros chamadores (scripts/benchmark.ts,
 * scripts/lib/weekly-instagram-ondemand-card.ts), que continuam sem passar
 * essas flags. Este teste trava as duas pontas: defaults inalterados
 * (quality 90, sem mozjpeg/progressive) e o perfil novo funcionando quando
 * pedido explicitamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

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

function runCropResize(args: string[]): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "scripts", "crop-resize.ts"), ...args],
    { stdio: "pipe" },
  );
}

describe("crop-resize.ts — flags de compressão opcionais (#5136)", () => {
  it("sem as flags novas, comportamento pré-#5136 preservado (quality 90, não-progressivo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crop-resize-default-"));
    try {
      const src = join(dir, "src.jpg");
      const dest = join(dir, "dest.jpg");
      writeFileSync(src, await makeNoisyJpeg(800, 450));

      runCropResize([src, dest, "--width", "800", "--height", "800"]);

      const meta = await sharp(readFileSync(dest)).metadata();
      assert.equal(meta.width, 800);
      assert.equal(meta.height, 800);
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.isProgressive, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com --quality/--mozjpeg/--progressive, sai menor e progressivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crop-resize-5136-"));
    try {
      const src = join(dir, "src.jpg");
      const destDefault = join(dir, "dest-default.jpg");
      const dest5136 = join(dir, "dest-5136.jpg");
      writeFileSync(src, await makeNoisyJpeg(800, 450));

      runCropResize([src, destDefault, "--width", "800", "--height", "800"]);
      runCropResize([
        src, dest5136,
        "--width", "800", "--height", "800",
        "--quality", "82", "--mozjpeg", "--progressive",
      ]);

      const defaultSize = readFileSync(destDefault).length;
      const profileBuf = readFileSync(dest5136);
      const meta = await sharp(profileBuf).metadata();

      assert.equal(meta.width, 800);
      assert.equal(meta.height, 800);
      assert.equal(meta.isProgressive, true);
      assert.ok(
        profileBuf.length < defaultSize,
        `perfil #5136 (${profileBuf.length} B) deveria ser menor que o default (${defaultSize} B)`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
