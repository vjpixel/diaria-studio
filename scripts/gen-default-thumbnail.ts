/**
 * gen-default-thumbnail.ts
 *
 * Gera o Default Thumbnail Preview da diar.ia.br (1200x630) para upload manual
 * em Beehiiv Settings → Publication → Default Thumbnail Preview.
 *
 * Design (DS oficial, vjpixel/diaria-design — banners facebook/linkedin-cover):
 * fundo papel #FBFAF6, kicker mono CAIXA ALTA + régua tinta 2px (masthead),
 * wordmark = logo.svg do DS (Georgia bold; "diar"/"ia" ink, "." e ".br" teal),
 * tagline oficial plural (#3705) em mono CAIXA ALTA, hairline bege e assinatura
 * "Assine grátis em diar.ia.br" (Georgia bold, domínio em teal). Teal só em
 * marca/texto — nunca barra/borda/ponto decorativo.
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
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "assets", "default-thumbnail-1200x630.png");

// Design tokens (DS canônico — derivados de scripts/lib/shared/design-tokens.ts, #1936).
const COLOR_PAPER = COLORS.paper;
const COLOR_TEAL = COLORS.brand;
const COLOR_INK = COLORS.ink;
const COLOR_RULE = COLORS.rule; // hairline bege
const COLOR_RULE_STRONG = COLORS.ruleStrong; // régua editorial pesada (tinta)
const FONT_SERIF = FONTS.serif;
const FONT_MONO = FONTS.mono;

const W = 1200;
const H = 630;

// Tagline oficial plural (#3705, mesma forma de context/editorial-rules.md). O DS
// (vjpixel/diaria-design, banners oficiais) a compõe em Geist Mono CAIXA ALTA com
// tracking — o texto-fonte segue em sentence case (fonte única da tagline) e a
// caixa alta é aplicada na renderização (`upper()`).
export const TAGLINE_LINE_1 = "5 minutos diários pra se manter";
export const TAGLINE_LINE_2 = "atualizado e usar melhor as IAs.";

const upper = (t: string): string => t.toLocaleUpperCase("pt-BR");

/** Fator largura/em conservador do mono (Geist Mono ≈ 0.6em/char), usado no clamp. */
export const MONO_CHAR_EM = 0.62;

function buildSvg(): string {
  // Linguagem "Edição Diária" dos banners oficiais do DS (facebook-cover/linkedin-cover):
  //   kicker mono CAIXA ALTA (esq) + meta (dir) → régua pesada tinta 2px →
  //   manchete → hairline bege → assinatura serifada com o domínio em teal.
  // Wordmark = assets/logo/logo.svg do DS: Georgia BOLD; "diar"/"ia" ink,
  // "." e ".br" teal. Teal só em marca/texto — nunca barra/borda.
  const pad = 80;
  const availableWidth = W - pad * 2;
  const trackingEm = 0.06;
  const maxLineLen = Math.max(TAGLINE_LINE_1.length, TAGLINE_LINE_2.length);
  // Clamp por largura (mono + tracking) e teto absoluto: a tagline é secundária ao wordmark.
  const widthBasedSize = Math.floor(availableWidth / (maxLineLen * (MONO_CHAR_EM + trackingEm)));
  const taglineSize = Math.max(16, Math.min(30, widthBasedSize));
  const letterSpacing = +(taglineSize * trackingEm).toFixed(2);
  const lineGap = Math.round(taglineSize * 1.55);
  const taglineLine1Y = 392;
  const taglineLine2Y = taglineLine1Y + lineGap;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLOR_PAPER}"/>

  <!-- Kicker + meta (mono, CAIXA ALTA, tracking 0.16em) -->
  <text x="${pad}" y="86" font-family="${FONT_MONO}" font-size="15" font-weight="500" letter-spacing="2.4" fill="${COLOR_INK}">NEWSLETTER</text>
  <text x="${W - pad}" y="86" text-anchor="end" font-family="${FONT_MONO}" font-size="15" font-weight="500" letter-spacing="2.4" fill="${COLOR_INK}">SEG-SEX</text>

  <!-- Régua editorial pesada (tinta 2px) -->
  <rect x="${pad}" y="104" width="${availableWidth}" height="2" fill="${COLOR_RULE_STRONG}"/>

  <!-- Wordmark oficial (logo.svg do DS): Georgia bold -->
  <text x="50%" y="290" text-anchor="middle" font-family="${FONT_SERIF}" font-size="128" font-weight="700" letter-spacing="-1" fill="${COLOR_INK}" dominant-baseline="alphabetic">diar<tspan fill="${COLOR_TEAL}">.</tspan>ia<tspan fill="${COLOR_TEAL}">.br</tspan></text>

  <!-- Tagline oficial (mono, CAIXA ALTA) -->
  <text x="50%" y="${taglineLine1Y}" text-anchor="middle" font-family="${FONT_MONO}" font-size="${taglineSize}" font-weight="500" letter-spacing="${letterSpacing}" fill="${COLOR_INK}" dominant-baseline="alphabetic">${upper(TAGLINE_LINE_1)}</text>
  <text x="50%" y="${taglineLine2Y}" text-anchor="middle" font-family="${FONT_MONO}" font-size="${taglineSize}" font-weight="500" letter-spacing="${letterSpacing}" fill="${COLOR_INK}" dominant-baseline="alphabetic">${upper(TAGLINE_LINE_2)}</text>

  <!-- Hairline bege + assinatura (domínio em teal = marca/texto) -->
  <rect x="${pad}" y="${H - 100}" width="${availableWidth}" height="1" fill="${COLOR_RULE}"/>
  <text x="${W - pad}" y="${H - 48}" text-anchor="end" font-family="${FONT_SERIF}" font-size="28" font-weight="700" fill="${COLOR_INK}" dominant-baseline="alphabetic">Assine grátis em <tspan fill="${COLOR_TEAL}">diar.ia.br</tspan></text>
</svg>`;
}

async function main(): Promise<void> {
  // #4090: aborta se Georgia nao resolve nesta maquina — sem isso a arte sai
  // com fallback de fonte, fora da marca, EM SILENCIO.
  await assertBrandSerifAvailable("gen-default-thumbnail");
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
