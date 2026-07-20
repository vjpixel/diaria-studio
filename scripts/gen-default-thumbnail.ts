/**
 * gen-default-thumbnail.ts
 *
 * Gera o Default Thumbnail Preview da Diar.ia (1200x630) para upload manual
 * em Beehiiv Settings → Publication → Default Thumbnail Preview.
 *
 * Design: fundo papel #FBFAF6, acento teal #00A0A0, texto ink #171411.
 * Wordmark central "diar.ia.br" com separadores em teal.
 * Subtítulo: tagline oficial plural (#3705), em 2 linhas, sans, substituindo
 * o antigo "newsletter diária de IA" genérico — a tagline já comunica
 * "newsletter diária" ("5 minutos diários..."), então mantinha as duas seria
 * redundante (decisão de design documentada no PR #3705).
 *
 * Uso:
 *   npx tsx scripts/gen-default-thumbnail.ts [--out assets/default-thumbnail-1200x630.png]
 *
 * Saída: PNG 1200x630 no caminho especificado (default: assets/default-thumbnail-1200x630.png).
 *        Imprime o path em stdout.
 *
 * Tecnologia: monta SVG inline + rasteriza via sharp (já dependência do projeto).
 * Georgia não existe em CI headless — usada com fallback genérico serif.
 *
 * Clamp de font-size da tagline: mesmo cuidado do `buildBannerSvg` em
 * gen-social-banner.ts (#3695/#3703) — 1200×630 (1.9:1) é bem mais "quadrado"
 * que os banners de LinkedIn (5.9:1)/Facebook (2.6:1), então o tamanho da
 * tagline é limitado tanto por largura disponível (chars × largura estimada
 * por char) quanto por um teto absoluto, e nunca só por altura — senão a
 * linha mais longa estoura o canvas.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
// #2530 review: tokens do DS canônico (fonte única, #1936) — não duplicar
// literais de cor/fonte (há drift-test pra esse padrão; um change no DS propaga).
import { COLORS, FONTS } from "./lib/shared/design-tokens.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "assets", "default-thumbnail-1200x630.png");

// Design tokens (DS canônico — derivados de scripts/lib/shared/design-tokens.ts, #1936).
const COLOR_PAPER = COLORS.paper;
const COLOR_TEAL = COLORS.brand;
const COLOR_INK = COLORS.ink;
const FONT_SERIF = FONTS.serif;
const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const W = 1200;
const H = 630;

// Tagline oficial plural (#3705, mesma forma de context/editorial-rules.md e
// gen-social-banner.ts) — quebrada em 2 linhas balanceadas no mesmo ponto que
// o banner do LinkedIn/Facebook usa ("...se manter" / "atualizado..."), só
// que em sentence case + sans (não uppercase/mono) pra combinar com o resto
// deste design (subtítulo original também era sentence case sans).
export const TAGLINE_LINE_1 = "5 minutos diários pra se manter";
export const TAGLINE_LINE_2 = "atualizado e usar melhor as IAs.";

function buildSvg(): string {
  // Wordmark breakdown: diar.ia.br
  // diar → ink, . → teal, ia → ink, . → teal, br → teal
  // Layout: centralized horizontally and vertically.
  // Wordmark font-size 96, subtitle font-size 28.
  // A barra teal horizontal decorativa (accent rule) acima do wordmark.

  // Clamp de font-size da tagline (#3705, mesmo cuidado do buildBannerSvg em
  // gen-social-banner.ts): limitado por largura disponível E por um teto
  // absoluto — a tagline é elemento secundário ao wordmark "diar.ia.br", não
  // deve competir em destaque visual, e 1200×630 tem folga de largura de
  // sobra (diferente do Facebook 2.6:1, onde o clamp width-based é o que
  // efetivamente governa). Ambos os limites coexistem pra que o cálculo
  // continue correto se a tagline mudar de novo no futuro (#3695 já trocou
  // 1×).
  const pad = 80; // mesma margem horizontal do resto do layout (accent bar, url hint)
  const availableWidth = W - pad * 2;
  const letterSpacing = 0.4;
  const maxLineLen = Math.max(TAGLINE_LINE_1.length, TAGLINE_LINE_2.length);
  // Sans regular (não-bold) — fator mais enxuto que o 0.65em/char do mono
  // bold do banner, ainda conservador o bastante pra nunca estourar.
  const widthBasedSize = Math.floor(
    (availableWidth - letterSpacing * (maxLineLen - 1)) / (maxLineLen * 0.52),
  );
  const taglineSize = Math.max(16, Math.min(32, widthBasedSize));
  const lineGap = Math.round(taglineSize * 1.5);
  const taglineLine1Y = 372;
  const taglineLine2Y = taglineLine1Y + lineGap;

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
    font-family="${FONT_SERIF}"
    font-size="102"
    font-weight="400"
    letter-spacing="-1"
    fill="${COLOR_INK}"
    dominant-baseline="alphabetic"
  >diar<tspan fill="${COLOR_TEAL}">.</tspan>ia<tspan fill="${COLOR_TEAL}">.</tspan>br</text>

  <!-- Teal underline accent below wordmark -->
  <rect x="390" y="315" width="420" height="4" rx="2" fill="${COLOR_TEAL}" opacity="0.6"/>

  <!-- Tagline oficial (2 linhas, substitui o antigo subtítulo genérico "newsletter
       diária de IA" — #3705: a tagline já comunica "newsletter diária") -->
  <text
    x="50%"
    y="${taglineLine1Y}"
    text-anchor="middle"
    font-family="${FONT_SANS}"
    font-size="${taglineSize}"
    font-weight="400"
    letter-spacing="${letterSpacing}"
    fill="${COLOR_INK}"
    opacity="0.72"
    dominant-baseline="alphabetic"
  >${TAGLINE_LINE_1}</text>
  <text
    x="50%"
    y="${taglineLine2Y}"
    text-anchor="middle"
    font-family="${FONT_SANS}"
    font-size="${taglineSize}"
    font-weight="400"
    letter-spacing="${letterSpacing}"
    fill="${COLOR_INK}"
    opacity="0.72"
    dominant-baseline="alphabetic"
  >${TAGLINE_LINE_2}</text>

  <!-- URL hint bottom-left -->
  <text
    x="80"
    y="${H - 48}"
    font-family="${FONT_SANS}"
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
    if (args[i] === "--out" || args[i] === "-o") {
      // #2530 review: validar o valor — sem isso, `--out` no fim (sem valor) cai
      // silenciosamente no DEFAULT_OUT (sobrescreve o asset canônico), e
      // `--out --flag` usaria o flag como path literal.
      const val = args[i + 1];
      if (val === undefined || val.startsWith("-")) {
        console.error(`${args[i]} requer um path de saída (ex: --out assets/default-thumbnail-1200x630.png)`);
        process.exit(2);
      }
      outPath = resolve(process.cwd(), args[++i]);
    }
  }

  // Ensure output directory exists
  mkdirSync(dirname(outPath), { recursive: true });

  const svg = buildSvg();

  // Rasterize SVG → PNG via sharp (uses libvips + librsvg under the hood)
  // #2530 review: sem .resize — o SVG já declara width/height ${W}x${H} (templados
  // das constantes W/H), então o sharp/librsvg rasteriza nessas dims nativamente.
  // O .resize era no-op, mas `fit:"fill"` distorceria silenciosamente caso as dims
  // do SVG divergissem das constantes.
  const pngBuf = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();

  writeFileSync(outPath, pngBuf);
  console.log(outPath);
}

// CLI guard: só executa main() quando chamado diretamente, nunca ao ser importado em testes.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("gen-default-thumbnail: erro ao gerar thumbnail:", err);
    process.exit(1);
  });
}

export { buildSvg, main };
