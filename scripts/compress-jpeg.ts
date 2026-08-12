/**
 * compress-jpeg.ts (#5136)
 *
 * Re-encode a JPEG file with a smaller target size, without resizing.
 * Uses sharp (already a project dependency, see scripts/crop-resize.ts).
 *
 * Motivation (#5136): `scripts/image-generate.ts` published the generator's
 * raw JPEG output as-is — no re-encode, no quality control. The 3 destaque
 * images (04-d1/d2/d3) alone were ~1 MB combined, 45% of first-visit page
 * weight on the poll/eia pages (86% on repeat visits, once Beehiiv's own
 * immutable/brotli assets are cache HITs). This script is the shared
 * compression step, invoked once for the wide 2x1 (in place of a bare
 * rename) and once for each derived/native square, so every published
 * destaque image gets the same treatment.
 *
 * Defaults (progressive mozjpeg @ q82) target the profile described in
 * issue #5136: visually lossless-ish, ~250-350 KB down from ~1 MB raw.
 * Flags exist so other callers can opt into a different profile without
 * touching this file's defaults.
 *
 * Usage:
 *   npx tsx scripts/compress-jpeg.ts <input> <output> [--quality 82] [--mozjpeg] [--progressive]
 *
 * <input> and <output> may be the same path (in-place re-encode) — the file
 * is fully read into memory before anything is written back out.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import sharp from "sharp";
import { isMainModule } from "./lib/cli-args.ts";

export interface CompressJpegOptions {
  quality?: number;
  mozjpeg?: boolean;
  progressive?: boolean;
}

// #5136: target profile — JPEG progressivo, mozjpeg (melhor que o encoder
// libjpeg padrão do sharp pro mesmo quality), qualidade 82 (faixa
// visualmente equivalente à fonte, mas com ganho de compressão substancial
// pra arte estilizada tipo impasto/Van Gogh, que já tem grão/textura alta
// e tolera quantização mais agressiva sem artefato perceptível).
export const DEFAULT_COMPRESS_OPTIONS: Required<CompressJpegOptions> = {
  quality: 82,
  mozjpeg: true,
  progressive: true,
};

/** Recompacta um buffer JPEG. Não redimensiona — só reencoda. */
export async function compressJpegBuffer(
  buf: Buffer,
  opts: CompressJpegOptions = {},
): Promise<Buffer> {
  const { quality, mozjpeg, progressive } = { ...DEFAULT_COMPRESS_OPTIONS, ...opts };
  return sharp(buf).jpeg({ quality, mozjpeg, progressive }).toBuffer();
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const opts: CompressJpegOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--quality" && args[i + 1]) {
      opts.quality = parseInt(args[++i], 10);
    } else if (args[i] === "--mozjpeg") {
      opts.mozjpeg = true;
    } else if (args[i] === "--progressive") {
      opts.progressive = true;
    } else {
      positional.push(args[i]);
    }
  }

  const [inputPath, outputPath] = positional;

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: npx tsx scripts/compress-jpeg.ts <input> <output> [--quality 82] [--mozjpeg] [--progressive]",
    );
    process.exit(2);
  }

  if (!existsSync(inputPath)) {
    console.error(`compress-jpeg: input não existe: ${inputPath}`);
    process.exit(2);
  }

  try {
    const before = readFileSync(inputPath);
    const after = await compressJpegBuffer(before, opts);
    writeFileSync(outputPath, after);
    console.error(
      `compress-jpeg: ${inputPath} (${before.length} B) -> ${outputPath} (${after.length} B)`,
    );
    console.log(outputPath);
  } catch (e: unknown) {
    console.error(`compress-jpeg: sharp falhou: ${(e as Error).message ?? e}`);
    process.exit(3);
  }
}

if (isMainModule(import.meta.url)) {
  await runCli();
}
