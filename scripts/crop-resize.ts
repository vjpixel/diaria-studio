/**
 * crop-resize.ts
 *
 * Center-crop and resize an image to target dimensions.
 * Uses sharp (already a project dependency via gemini-image.js).
 *
 * Usage:
 *   npx tsx scripts/crop-resize.ts <input> <output> [--width 800] [--height 450] \
 *     [--quality 90] [--mozjpeg] [--progressive]
 *
 * Defaults: 800x450 (16:9), quality 90, no mozjpeg, no progressive —
 * unchanged since this script predates #5136 and has other callers
 * (scripts/benchmark.ts, scripts/lib/weekly-instagram-ondemand-card.ts)
 * that rely on the original output profile. `--quality`/`--mozjpeg`/
 * `--progressive` (#5136) are opt-in so `scripts/image-generate.ts` can
 * request the smaller-file profile for its own square-crop derivations
 * without changing behavior for anyone else.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import sharp from "sharp";

const args = process.argv.slice(2);
const positional: string[] = [];
let width = 800;
let height = 450;
let quality = 90;
let mozjpeg = false;
let progressive = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--width" && args[i + 1]) {
    width = parseInt(args[++i], 10);
  } else if (args[i] === "--height" && args[i + 1]) {
    height = parseInt(args[++i], 10);
  } else if (args[i] === "--quality" && args[i + 1]) {
    quality = parseInt(args[++i], 10);
  } else if (args[i] === "--mozjpeg") {
    mozjpeg = true;
  } else if (args[i] === "--progressive") {
    progressive = true;
  } else {
    positional.push(args[i]);
  }
}

const [inputPath, outputPath] = positional;

if (!inputPath || !outputPath) {
  console.error(
    "Usage: npx tsx scripts/crop-resize.ts <input> <output> [--width 800] [--height 450] [--quality 90] [--mozjpeg] [--progressive]",
  );
  process.exit(2);
}

if (!existsSync(inputPath)) {
  console.error(`crop-resize: input não existe: ${inputPath}`);
  process.exit(2);
}

try {
  const buf = readFileSync(inputPath);
  const result = await sharp(buf)
    .resize(width, height, { fit: "cover", position: "centre" })
    .jpeg({ quality, mozjpeg, progressive })
    .toBuffer();
  writeFileSync(outputPath, result);
  console.log(outputPath);
} catch (e: unknown) {
  console.error(`crop-resize: sharp falhou: ${(e as Error).message ?? e}`);
  process.exit(3);
}
