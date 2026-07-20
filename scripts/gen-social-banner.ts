/**
 * gen-social-banner.ts (#3695)
 *
 * Gera os banners/capas de perfis sociais da Diar.ia (LinkedIn company page,
 * Facebook cover photo) com a tagline oficial atual. Reproduz o design
 * existente (fundo ink, texto onInk, acento teal, fonte mono, uppercase) já
 * publicado nos dois canais — só recria pra atualizar o texto pra forma
 * plural ("...usar melhor as IAs", #3695) sem depender do arquivo-fonte
 * original (Canva/Figma, fora do repo).
 *
 * Uso:
 *   npx tsx scripts/gen-social-banner.ts linkedin [--out assets/banner-linkedin-1128x191.png]
 *   npx tsx scripts/gen-social-banner.ts facebook [--out assets/banner-facebook-820x312.png]
 *
 * Dimensões oficiais recomendadas (2026-07): LinkedIn company page banner
 * 1128×191; Facebook Page cover photo 820×312 (confirmado via render medido
 * na página ao vivo, 960×365 ≈ mesma proporção 2.63:1).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS, FONTS } from "./lib/shared/design-tokens.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TAGLINE_LINE_1 = "5 MINUTOS DIÁRIOS PRA SE MANTER";
export const TAGLINE_LINE_2 = "ATUALIZADO E USAR MELHOR AS IAS";

export interface BannerSpec {
  key: "linkedin" | "facebook";
  width: number;
  height: number;
  defaultOut: string;
}

export const BANNER_SPECS: Record<"linkedin" | "facebook", BannerSpec> = {
  linkedin: {
    key: "linkedin",
    width: 1128,
    height: 191,
    defaultOut: resolve(ROOT, "assets", "banner-linkedin-1128x191.png"),
  },
  facebook: {
    key: "facebook",
    width: 820,
    height: 312,
    defaultOut: resolve(ROOT, "assets", "banner-facebook-820x312.png"),
  },
};

/** Pure: monta o SVG do banner pra um W×H dado. Escala tipografia proporcional à altura,
 * mas limitada pela largura disponível — banners mais "quadrados" (Facebook, 2.6:1) têm
 * menos largura por pixel de altura que o LinkedIn (5.9:1), então o tamanho puramente
 * height-based (usado antes) estourava a linha pra fora do canvas no Facebook. */
export function buildBannerSvg(width: number, height: number): string {
  const pad = Math.round(height * 0.12);
  const headerSize = Math.max(11, Math.round(height * 0.075));
  const footerSize = Math.max(11, Math.round(height * 0.075));
  const midY = height / 2;

  const maxLineLen = Math.max(TAGLINE_LINE_1.length, TAGLINE_LINE_2.length);
  const availableWidth = width - pad * 2;
  const letterSpacing = 1;
  // Largura de caractere ≈ 0.65em pra mono bold (Geist Mono/JetBrains Mono) — fator
  // conservador pra garantir que nenhuma linha estoure o canvas.
  const widthBasedSize = Math.floor(
    (availableWidth - letterSpacing * (maxLineLen - 1)) / (maxLineLen * 0.65),
  );
  const heightBasedSize = Math.round(height * 0.19);
  const taglineSize = Math.max(12, Math.min(heightBasedSize, widthBasedSize));
  const lineGap = Math.round(taglineSize * 1.35);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${COLORS.ink}"/>

  <!-- Header row -->
  <text x="${pad}" y="${pad + headerSize}" font-family="${FONTS.mono}" font-size="${headerSize}"
    letter-spacing="2" fill="${COLORS.onInk}" opacity="0.75">NEWSLETTER GRATUITA</text>
  <text x="${width - pad}" y="${pad + headerSize}" text-anchor="end" font-family="${FONTS.mono}"
    font-size="${headerSize}" letter-spacing="2" fill="${COLORS.onInk}" opacity="0.75">SEG-SEX</text>
  <rect x="${pad}" y="${pad + headerSize * 1.8}" width="${width - pad * 2}" height="1" fill="${COLORS.onInk}" opacity="0.25"/>

  <!-- Tagline (2 lines, centered) -->
  <text x="50%" y="${midY - lineGap * 0.15}" text-anchor="middle" font-family="${FONTS.mono}"
    font-size="${taglineSize}" font-weight="700" letter-spacing="1" fill="${COLORS.onInk}">${TAGLINE_LINE_1}</text>
  <text x="50%" y="${midY - lineGap * 0.15 + lineGap}" text-anchor="middle" font-family="${FONTS.mono}"
    font-size="${taglineSize}" font-weight="700" letter-spacing="1" fill="${COLORS.onInk}">${TAGLINE_LINE_2}</text>

  <!-- Footer -->
  <text x="${width - pad}" y="${height - pad}" text-anchor="end" font-family="${FONTS.mono}"
    font-size="${footerSize}" fill="${COLORS.onInk}" opacity="0.85">Assine grátis em <tspan fill="${COLORS.brand}" font-weight="700">diar.ia.br</tspan></text>
</svg>`;
}

async function renderBanner(spec: BannerSpec, outPath: string): Promise<void> {
  const svg = buildBannerSvg(spec.width, spec.height);
  mkdirSync(dirname(outPath), { recursive: true });
  const pngBuf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(outPath, pngBuf);
  console.log(outPath);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args[0];
  if (target !== "linkedin" && target !== "facebook") {
    console.error("Uso: npx tsx scripts/gen-social-banner.ts <linkedin|facebook> [--out path]");
    process.exit(2);
  }
  const spec = BANNER_SPECS[target];

  let outPath = spec.defaultOut;
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0) {
    const val = args[outIdx + 1];
    if (val === undefined || val.startsWith("-")) {
      console.error("--out requer um path de saída");
      process.exit(2);
    }
    outPath = resolve(process.cwd(), val);
  }

  await renderBanner(spec, outPath);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("gen-social-banner: erro ao gerar banner:", err);
    process.exit(1);
  });
}

export { renderBanner, main };
