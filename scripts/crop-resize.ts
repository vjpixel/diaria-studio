/**
 * crop-resize.ts
 *
 * Center-crop and resize an image to target dimensions.
 * Uses sharp (already a project dependency via gemini-image.js).
 *
 * Usage:
 *   npx tsx scripts/crop-resize.ts <input> <output> [--width 800] [--height 450]
 *
 * Defaults: 800x450 (16:9). Output is always JPEG at quality 90.
 */

import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const args = process.argv.slice(2);
const positional: string[] = [];
let width = 800;
let height = 450;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--width" && args[i + 1]) {
    width = parseInt(args[++i], 10);
  } else if (args[i] === "--height" && args[i + 1]) {
    height = parseInt(args[++i], 10);
  } else {
    positional.push(args[i]);
  }
}

const [inputPath, outputPath] = positional;

if (!inputPath || !outputPath) {
  console.error("Usage: npx tsx scripts/crop-resize.ts <input> <output> [--width 800] [--height 450]");
  process.exit(2);
}

const buf = readFileSync(inputPath);

const result = await sharp(buf)
  .resize(width, height, { fit: "cover", position: "centre" })
  .jpeg({ quality: 90 })
  .toBuffer();

writeFileSync(outputPath, result);
console.log(outputPath);
