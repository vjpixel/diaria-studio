/**
 * gen-story-card.ts
 *
 * Gera um card vertical (1080x1920, formato Status do WhatsApp / Stories do
 * Telegram e Instagram) pra divulgação avulsa fora do carrossel de feed —
 * primeiro uso: campanha de lançamento 21/07 (issue de campanha, sem número
 * fixo — colateral de marketing, não parte do pipeline editorial).
 *
 * Reusa o DS canônico (COLORS/FONTS de design-tokens.ts) pro card ficar
 * consistente com o resto dos assets de marca (mesmo cuidado de
 * gen-default-thumbnail.ts — não duplicar literais de cor/fonte).
 *
 * Uso:
 *   npx tsx scripts/gen-story-card.ts [--out data/lancamento/assets/stories/lancamento-2607-story.png]
 *
 * Saída: PNG 1080x1920 no caminho especificado. Imprime o path em stdout.
 * Default de saída fica em data/ (dado de campanha, junto com o resto dos
 * assets de lançamento — data/lancamento/assets/), não em assets/ do repo,
 * que é só pra assets canônicos e permanentes da marca (ex: default-thumbnail).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS, FONTS } from "./lib/shared/design-tokens.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "data", "lancamento", "assets", "stories", "lancamento-2607-story.png");

const COLOR_PAPER = COLORS.paper;
const COLOR_TEAL = COLORS.brand;
const COLOR_INK = COLORS.ink;
const FONT_SERIF = FONTS.serif;
const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const W = 1080;
const H = 1920;

export const EYEBROW = "LANÇAMENTO";
export const HEADLINE_LINES = [
  "5 minutos diários",
  "pra se manter atualizado",
  "e usar melhor as IAs.",
];
export const SUBLINE = "Já são 228 edições publicadas desde agosto de 2025.";
export const CTA_LABEL = "Assine grátis";
export const CTA_URL = "diar.ia.br";

function buildSvg(): string {
  const pad = 90;
  const availableWidth = W - pad * 2;

  // Clamp de font-size da headline, mesmo cuidado de gen-default-thumbnail.ts:
  // limitado pela linha mais longa E por um teto absoluto, nunca só por altura.
  const letterSpacing = 0.2;
  const maxLineLen = Math.max(...HEADLINE_LINES.map((l) => l.length));
  const widthBasedSize = Math.floor(
    (availableWidth - letterSpacing * (maxLineLen - 1)) / (maxLineLen * 0.56),
  );
  const headlineSize = Math.max(36, Math.min(68, widthBasedSize));
  const lineGap = Math.round(headlineSize * 1.32);

  const wordmarkY = 470;
  const headlineStartY = 760;
  const headlineLines = HEADLINE_LINES.map(
    (line, i) => `<text
    x="50%"
    y="${headlineStartY + i * lineGap}"
    text-anchor="middle"
    font-family="${FONT_SERIF}"
    font-size="${headlineSize}"
    font-weight="400"
    letter-spacing="${letterSpacing}"
    fill="${COLOR_INK}"
    dominant-baseline="alphabetic"
  >${line}</text>`,
  ).join("\n  ");

  const sublineY = headlineStartY + HEADLINE_LINES.length * lineGap + 70;
  // Sem forma de botão/pílula: story do WhatsApp/Telegram não é clicável
  // dentro da própria imagem (o link, quando existe, é um sticker separado
  // que a pessoa adiciona por cima ao publicar) — um desenho de botão aqui
  // sugeriria uma interação que a imagem sozinha não entrega.
  const ctaLabelY = H - 260;
  const ctaUrlY = ctaLabelY + 62;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLOR_PAPER}"/>

  <!-- Teal accent rule, topo -->
  <rect x="${W / 2 - 40}" y="150" width="80" height="6" rx="3" fill="${COLOR_TEAL}"/>

  <!-- Eyebrow -->
  <text
    x="50%"
    y="216"
    text-anchor="middle"
    font-family="${FONT_SANS}"
    font-size="30"
    font-weight="600"
    letter-spacing="3"
    fill="${COLOR_TEAL}"
    dominant-baseline="alphabetic"
  >${EYEBROW}</text>

  <!-- Wordmark: diar.ia.br -->
  <text
    x="50%"
    y="${wordmarkY}"
    text-anchor="middle"
    font-family="${FONT_SERIF}"
    font-size="108"
    font-weight="400"
    letter-spacing="-1"
    fill="${COLOR_INK}"
    dominant-baseline="alphabetic"
  >diar<tspan fill="${COLOR_TEAL}">.</tspan>ia<tspan fill="${COLOR_TEAL}">.</tspan><tspan fill="${COLOR_TEAL}">br</tspan></text>
  <rect x="${W / 2 - 220}" y="${wordmarkY + 22}" width="440" height="4" rx="2" fill="${COLOR_TEAL}" opacity="0.6"/>

  <!-- Headline (tagline oficial) -->
  ${headlineLines}

  <!-- Subline -->
  <text
    x="50%"
    y="${sublineY}"
    text-anchor="middle"
    font-family="${FONT_SANS}"
    font-size="30"
    font-weight="400"
    fill="${COLOR_INK}"
    opacity="0.65"
    dominant-baseline="alphabetic"
  >${SUBLINE}</text>

  <!-- CTA: texto plano, sem forma de botão (story não é clicável na imagem) -->
  <text
    x="50%"
    y="${ctaLabelY}"
    text-anchor="middle"
    font-family="${FONT_SANS}"
    font-size="46"
    font-weight="600"
    fill="${COLOR_TEAL}"
    dominant-baseline="alphabetic"
  >${CTA_LABEL}</text>
  <text
    x="50%"
    y="${ctaUrlY}"
    text-anchor="middle"
    font-family="${FONT_SANS}"
    font-size="34"
    font-weight="500"
    fill="${COLOR_INK}"
    opacity="0.7"
    dominant-baseline="alphabetic"
  >${CTA_URL}</text>
</svg>`;
}

async function main(): Promise<void> {
  let outPath = DEFAULT_OUT;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" || args[i] === "-o") {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("-")) {
        console.error(`${args[i]} requer um path de saída (ex: --out data/lancamento/assets/stories/lancamento-2607-story.png)`);
        process.exit(2);
      }
      outPath = resolve(process.cwd(), args[++i]);
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });

  const svg = buildSvg();
  const pngBuf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

  writeFileSync(outPath, pngBuf);
  console.log(outPath);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("gen-story-card: erro ao gerar card:", err);
    process.exit(1);
  });
}

export { buildSvg, main };
