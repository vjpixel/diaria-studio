/**
 * gen-default-thumbnail.ts
 *
 * Gera o Default Thumbnail Preview da Diar.ia (1200x630) para upload manual
 * em Beehiiv Settings → Publication → Default Thumbnail Preview.
 *
 * Design: fundo papel #FBFAF6, acento teal #00A0A0, texto ink #171411.
 * Wordmark central "diar.ia.br" com separadores em teal.
 * Subtítulo "newsletter diária de IA" em sans.
 *
 * Uso:
 *   npx tsx scripts/gen-default-thumbnail.ts [--out assets/default-thumbnail-1200x630.png]
 *
 * Saída: PNG 1200x630 no caminho especificado (default: assets/default-thumbnail-1200x630.png).
 *        Imprime o path em stdout.
 *
 * Tecnologia: monta SVG inline + rasteriza via sharp (já dependência do projeto).
 * Georgia não existe em CI headless — usada com fallback genérico serif.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "assets", "default-thumbnail-1200x630.png");

// Design tokens (DS canônico — context/README / project_new_diaria_design.md)
const COLOR_PAPER = "#FBFAF6";
const COLOR_TEAL = "#00A0A0";
const COLOR_INK = "#171411";

const W = 1200;
const H = 630;

function buildSvg(): string {
  // Wordmark breakdown: diar.ia.br
  // diar → ink, . → teal, ia → ink, . → teal, br → teal
  // Layout: centralized horizontally and vertically.
  // Wordmark font-size 96, subtitle font-size 28.
  // A barra teal horizontal decorativa (accent rule) acima do wordmark.

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="${COLOR_PAPER}"/>

  <!-- Teal accent rule (top-left decorative bar) -->
  <rect x="80" y="72" width="80" height="6" rx="3" fill="${COLOR_TEAL}"/>

  <!-- Decorative bottom-right teal dot cluster -->
  <circle cx="${W - 80}" cy="${H - 72}" r="6" fill="${COLOR_TEAL}" opacity="0.35"/>
  <circle cx="${W - 100}" cy="${H - 72}" r="4" fill="${COLOR_TEAL}" opacity="0.22"/>
  <circle cx="${W - 80}" cy="${H - 92}" r="4" fill="${COLOR_TEAL}" opacity="0.22"/>

  <!-- Wordmark: diar.ia.br — centered vertically slightly above mid -->
  <!-- Each segment positioned manually for teal/ink split -->
  <!-- "diar" ink -->
  <text
    x="50%"
    y="295"
    text-anchor="middle"
    font-family="Georgia, 'Times New Roman', Times, serif"
    font-size="102"
    font-weight="400"
    letter-spacing="-1"
    fill="${COLOR_INK}"
    dominant-baseline="alphabetic"
  >diar<tspan fill="${COLOR_TEAL}">.</tspan>ia<tspan fill="${COLOR_TEAL}">.</tspan>br</text>

  <!-- Teal underline accent below wordmark -->
  <rect x="390" y="315" width="420" height="4" rx="2" fill="${COLOR_TEAL}" opacity="0.6"/>

  <!-- Subtitle -->
  <text
    x="50%"
    y="380"
    text-anchor="middle"
    font-family="'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    font-size="26"
    font-weight="400"
    letter-spacing="2"
    fill="${COLOR_INK}"
    opacity="0.55"
    dominant-baseline="alphabetic"
  >newsletter diária de IA</text>

  <!-- URL hint bottom-left -->
  <text
    x="80"
    y="${H - 48}"
    font-family="'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    font-size="18"
    font-weight="400"
    fill="${COLOR_TEAL}"
    dominant-baseline="alphabetic"
    opacity="0.75"
  >diar.ia.br</text>
</svg>`;
}

async function main(): Promise<void> {
  // Parse --out flag
  let outPath = DEFAULT_OUT;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--out" || args[i] === "-o") && args[i + 1]) {
      outPath = resolve(process.cwd(), args[++i]);
    }
  }

  // Ensure output directory exists
  mkdirSync(dirname(outPath), { recursive: true });

  const svg = buildSvg();

  // Rasterize SVG → PNG via sharp (uses libvips + librsvg under the hood)
  const pngBuf = await sharp(Buffer.from(svg))
    .resize(W, H, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();

  writeFileSync(outPath, pngBuf);
  console.log(outPath);
}

// CLI guard: só executa main() quando chamado diretamente, nunca ao ser importado em testes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("gen-default-thumbnail: erro ao gerar thumbnail:", err);
    process.exit(1);
  });
}

export { buildSvg, main };
