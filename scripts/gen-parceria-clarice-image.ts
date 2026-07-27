/**
 * gen-parceria-clarice-image.ts
 *
 * Gera as imagens de divulgação da parceria Clarice × Diar.ia (posts de
 * anúncio, ver doc "Posts de divulgação — Parceria Clarice × Diar.ia" no
 * Drive). Colateral de marketing one-off, não parte do pipeline editorial —
 * mesmo espírito de gen-story-card.ts.
 *
 * Composição: fundo branco + logo oficial da Clarice (SVG extraído de
 * clarice.ai, roxo #410A85 preservado — marca de terceiro não é recolorida)
 * + "+" + wordmark diar.ia.br (DS canônico, Georgia + pontos teal) + subline.
 * Clarice vem primeiro; as duas marcas ocupam a MESMA área (bounding box do
 * wordmark medido no render via sharp().trim(), escala da Clarice calculada
 * pra igualar a área de tinta).
 *
 * Uso:
 *   npx tsx scripts/gen-parceria-clarice-image.ts [--out-dir data/parceria-clarice/assets]
 *
 * Saídas: parceria-clarice-linkedin.png (1200x627) e
 *         parceria-clarice-square.png (1080x1080).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS, FONTS } from "./lib/shared/design-tokens.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data", "parceria-clarice", "assets");

const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const SUBLINE_1 = "Clarice News: a newsletter mensal de IA da Clarice,";
const SUBLINE_2 = "produzida pela diar.ia.br";

/**
 * Logo oficial da Clarice (clarice.ai, 260723) — viewBox 0 0 105 32, tudo
 * #410A85. Paths verbatim do SVG inline do site (ícone + wordmark "clarice.ai").
 */
const CLARICE_PURPLE = "#410A85";
const CLARICE_W = 105;
const CLARICE_H = 32;
const CLARICE_PATHS = `
<path d="M39.9026 15.5148C39.247 15.3014 38.763 15.1606 38.4528 15.0902C38.1425 15.0198 37.7817 14.9846 37.3747 14.9846C36.3627 14.9846 35.5949 15.242 35.0735 15.7568C34.5498 16.2716 34.288 17.0351 34.288 18.0449C34.288 19.0217 34.5674 19.8138 35.1263 20.4276C35.6851 21.0392 36.4353 21.345 37.3747 21.345C37.7817 21.345 38.1425 21.3098 38.4528 21.2394C38.763 21.169 39.247 21.026 39.9026 20.8126V22.8344C38.9984 23.1887 38.0127 23.3669 36.9479 23.3669C35.3507 23.3669 34.068 22.8784 33.1022 21.9038C32.1342 20.927 31.6523 19.6421 31.6523 18.0449C31.6523 16.4476 32.121 15.2068 33.0626 14.318C34.002 13.4314 35.2979 12.9869 36.9479 12.9869C38.1183 12.9869 39.104 13.1563 39.9026 13.493V15.5148Z" fill="${CLARICE_PURPLE}"/>
<path d="M44.6394 21.6091C45.0817 21.6091 45.4909 21.5475 45.8649 21.4221V23.1007C45.2093 23.4373 44.4458 23.6067 43.5768 23.6067C41.8366 23.6067 40.9697 22.6475 40.9697 20.7312V8.72766H43.4712V19.9854C43.4712 20.5354 43.5592 20.9424 43.7374 21.2087C43.9112 21.4771 44.2126 21.6091 44.6394 21.6091Z" fill="${CLARICE_PURPLE}"/>
<path d="M47.7261 13.5194C48.1881 13.3588 48.7689 13.2311 49.4708 13.1343C50.1704 13.0375 50.7512 12.9869 51.2132 12.9869C52.8633 12.9869 54.0469 13.2927 54.7663 13.9044C55.4858 14.516 55.8444 15.5148 55.8444 16.8987V23.3669H53.5563L53.5299 22.4626C52.7313 23.1007 51.7368 23.4197 50.5488 23.4197C49.4488 23.4197 48.5709 23.1403 47.9131 22.5814C47.2575 22.0226 46.9297 21.29 46.9297 20.3858C46.9297 19.3913 47.2971 18.6169 48.0341 18.0581C48.7711 17.4993 49.8228 17.1847 51.189 17.1143L53.1845 17.0087C53.1845 16.353 53.1229 15.8998 52.9975 15.6512C52.8721 15.3674 52.6521 15.1716 52.3309 15.066C52.0118 14.9604 51.5058 14.9054 50.815 14.9054C50.353 14.9054 49.8162 14.9494 49.2046 15.0396C48.5929 15.1298 48.1001 15.2442 47.7283 15.385V13.5194H47.7261ZM53.2901 18.7357L51.4794 18.8699C50.7864 18.9227 50.2826 19.0569 49.9636 19.2681C49.6446 19.4815 49.484 19.7918 49.484 20.1988C49.484 20.608 49.6336 20.927 49.9372 21.158C50.2386 21.389 50.6566 21.5034 51.189 21.5034C51.6158 21.5034 51.9656 21.4682 52.2407 21.3978C52.5157 21.3274 52.8655 21.1668 53.2923 20.9182V18.7357H53.2901Z" fill="${CLARICE_PURPLE}"/>
<path d="M56.909 23.3669H59.4369V15.5941C60.0221 15.3983 60.5809 15.3015 61.1134 15.3015C61.912 15.3015 62.6028 15.4621 63.188 15.7811V13.2796C62.7436 13.1916 62.363 13.1454 62.044 13.1454H61.8042C60.5083 13.1454 59.3643 13.3544 58.3699 13.7702C57.3754 14.1882 56.887 14.857 56.9068 15.7789V23.3669H56.909Z" fill="${CLARICE_PURPLE}"/>
<path d="M64.5369 10.7869C64.2597 10.5097 64.1211 10.1775 64.1211 9.79245C64.1211 9.39203 64.2597 9.05542 64.5369 8.78701C64.8141 8.51641 65.1463 8.3822 65.5313 8.3822C65.9317 8.3822 66.2684 8.51641 66.5368 8.78701C66.8074 9.05762 66.9416 9.39203 66.9416 9.79245C66.9416 10.1775 66.8074 10.5097 66.5368 10.7869C66.2662 11.0641 65.9317 11.2027 65.5313 11.2027C65.1463 11.2027 64.8141 11.0641 64.5369 10.7869ZM64.2553 23.3669H66.8096V13.1454H64.2553V23.3669Z" fill="${CLARICE_PURPLE}"/>
<path d="M76.1248 15.5148C75.4691 15.3014 74.9851 15.1606 74.6749 15.0902C74.3647 15.0198 74.0039 14.9846 73.5969 14.9846C72.5849 14.9846 71.817 15.242 71.2956 15.7568C70.772 16.2716 70.5102 17.0351 70.5102 18.0449C70.5102 19.0217 70.7896 19.8138 71.3484 20.4276C71.9072 21.0392 72.6575 21.345 73.5969 21.345C74.0039 21.345 74.3647 21.3098 74.6749 21.2394C74.9851 21.169 75.4691 21.026 76.1248 20.8126V22.8344C75.2205 23.1887 74.2349 23.3669 73.1701 23.3669C71.5728 23.3669 70.2902 22.8784 69.3244 21.9038C68.3563 20.927 67.8745 19.6421 67.8745 18.0449C67.8745 16.4476 68.3431 15.2068 69.2848 14.318C70.2242 13.4314 71.52 12.9869 73.1701 12.9869C74.3405 12.9869 75.3261 13.1563 76.1248 13.493V15.5148Z" fill="${CLARICE_PURPLE}"/>
<path d="M86.2645 23.2327C85.3053 23.4989 84.17 23.6309 82.8566 23.6309C81.1185 23.6309 79.7391 23.1469 78.7183 22.181C77.6974 21.2152 77.187 19.9238 77.187 18.3089C77.187 17.2441 77.4092 16.3046 77.8514 15.4884C78.2958 14.6898 78.8723 14.0738 79.5807 13.6382C80.2891 13.2047 81.0701 12.9869 81.9238 12.9869C83.4506 12.9869 84.6298 13.4578 85.4637 14.3972C86.2975 15.3366 86.7155 16.6413 86.7155 18.3089V19.2945H79.7699C79.9107 20.839 81.0569 21.609 83.2042 21.609C84.5528 21.609 85.5737 21.521 86.2645 21.3428V23.2327ZM81.9788 14.9824C81.3935 14.9824 80.8963 15.2178 80.4893 15.6864C80.0801 16.1572 79.8601 16.7645 79.8227 17.5103H84.1876C84.1876 16.7117 83.9918 16.0912 83.6024 15.6468C83.213 15.2046 82.6718 14.9824 81.9788 14.9824Z" fill="${CLARICE_PURPLE}"/>
<path d="M88.2335 23.2063C87.9321 22.9049 87.7803 22.5507 87.7803 22.1415C87.7803 21.7322 87.9299 21.378 88.2335 21.0766C88.5349 20.7752 88.8891 20.6234 89.2983 20.6234C89.7075 20.6234 90.0618 20.7752 90.3632 21.0766C90.6646 21.378 90.8164 21.7322 90.8164 22.1415C90.8164 22.5507 90.6646 22.9049 90.3632 23.2063C90.0618 23.5077 89.7075 23.6595 89.2983 23.6595C88.8891 23.6595 88.5349 23.5077 88.2335 23.2063Z" fill="${CLARICE_PURPLE}"/>
<path d="M92.625 13.5194C93.0871 13.3588 93.6679 13.2311 94.3697 13.1343C95.0693 13.0375 95.6501 12.9869 96.1121 12.9869C97.7622 12.9869 98.9458 13.2927 99.6653 13.9044C100.385 14.516 100.743 15.5148 100.743 16.8987V23.3669H98.4552L98.4288 22.4626C97.6302 23.1007 96.6358 23.4197 95.4477 23.4197C94.3477 23.4197 93.4699 23.1403 92.812 22.5814C92.1564 22.0226 91.8286 21.29 91.8286 20.3858C91.8286 19.3913 92.196 18.6169 92.933 18.0581C93.6701 17.4993 94.7217 17.1847 96.0879 17.1143L98.0834 17.0087C98.0834 16.353 98.0218 15.8998 97.8964 15.6512C97.771 15.3674 97.551 15.1716 97.2298 15.066C96.9108 14.9604 96.4048 14.9054 95.7139 14.9054C95.2519 14.9054 94.7151 14.9494 94.1035 15.0396C93.4919 15.1298 92.999 15.2442 92.6272 15.385V13.5194H92.625ZM98.1868 18.7357L96.3762 18.8699C95.6831 18.9227 95.1793 19.0569 94.8603 19.2681C94.5413 19.4815 94.3807 19.7918 94.3807 20.1988C94.3807 20.608 94.5303 20.927 94.8339 21.158C95.1353 21.389 95.5533 21.5034 96.0857 21.5034C96.5126 21.5034 96.8624 21.4682 97.1374 21.3978C97.4124 21.3274 97.7622 21.1668 98.189 20.9182V18.7357H98.1868Z" fill="${CLARICE_PURPLE}"/>
<path d="M102.061 10.8155C101.775 10.5295 101.632 10.1885 101.632 9.7925C101.632 9.37889 101.775 9.03568 102.061 8.75627C102.347 8.47906 102.688 8.34045 103.084 8.34045C103.498 8.34045 103.841 8.47906 104.121 8.75627C104.4 9.03348 104.536 9.37889 104.536 9.7925C104.536 10.1885 104.398 10.5295 104.121 10.8155C103.843 11.1015 103.498 11.2445 103.084 11.2445C102.688 11.2445 102.347 11.1015 102.061 10.8155ZM101.806 23.3669H104.36V13.1454H101.806V23.3669Z" fill="${CLARICE_PURPLE}"/>
<path d="M25.6132 12.6196C25.512 5.63218 19.816 0 12.8066 0C5.73338 0 0 5.73338 0 12.8066C0 19.8798 5.73338 25.6132 12.8066 25.6132V31.9978C20.2714 28.8957 25.5384 21.5629 25.6132 12.9914C25.6132 12.9298 25.6132 12.8682 25.6132 12.8044C25.6154 12.745 25.6154 12.6812 25.6132 12.6196ZM12.8066 19.442C10.1071 19.442 7.91805 17.2529 7.91805 14.5535H17.6952C17.6952 17.2529 15.5061 19.442 12.8066 19.442Z" fill="${CLARICE_PURPLE}"/>
`;

function clariceGroup(tx: number, ty: number, scale: number): string {
  return `<g transform="translate(${tx} ${ty}) scale(${scale})">${CLARICE_PATHS}</g>`;
}

/** Wordmark diar.ia.br do DS (mesmo desenho de gen-story-card.ts). */
function diariaWordmark(x: number, baselineY: number, fontSize: number, anchor: string): string {
  return `<text
    x="${x}"
    y="${baselineY}"
    text-anchor="${anchor}"
    font-family="${FONTS.serif}"
    font-size="${fontSize}"
    font-weight="400"
    letter-spacing="-1"
    fill="${COLORS.ink}"
    dominant-baseline="alphabetic"
  >diar<tspan fill="${COLORS.brand}">.</tspan>ia<tspan fill="${COLORS.brand}">.</tspan><tspan fill="${COLORS.brand}">br</tspan></text>`;
}

function subline(cx: number, y: number, size: number): string {
  const gap = Math.round(size * 1.5);
  return `
  <text x="${cx}" y="${y}" text-anchor="middle" font-family="${FONT_SANS}"
    font-size="${size}" font-weight="400" fill="${COLORS.ink}" opacity="0.65"
    dominant-baseline="alphabetic">${SUBLINE_1}</text>
  <text x="${cx}" y="${y + gap}" text-anchor="middle" font-family="${FONT_SANS}"
    font-size="${size}" font-weight="400" fill="${COLORS.ink}" opacity="0.65"
    dominant-baseline="alphabetic">${SUBLINE_2}</text>`;
}

function plusMark(cx: number, centerY: number, size: number): string {
  // "+" em Georgia fica centrado ~0.33em acima da baseline; compensa pra
  // alinhar o centro óptico do glifo em centerY.
  return `<text x="${cx}" y="${centerY + size * 0.33}" text-anchor="middle" font-family="${FONTS.serif}"
    font-size="${size}" font-weight="400" fill="${COLORS.ink}" opacity="0.45"
    dominant-baseline="alphabetic">+</text>`;
}

/**
 * Mede o bounding box de tinta do wordmark renderizado (fundo transparente +
 * trim). Fonte é system (Georgia) — por isso medir no render, não estimar.
 */
async function measureWordmark(fontSize: number): Promise<{ w: number; h: number }> {
  const pad = 200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fontSize * 8}" height="${fontSize * 3}">
  ${diariaWordmark(pad, fontSize * 2, fontSize, "start")}
</svg>`;
  const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height };
}

/**
 * Escala da Clarice a partir da área (bbox) do wordmark, com boost de tamanho
 * percebido: a área igual exata deixava a Clarice PARECENDO menor (o serif do
 * wordmark tem letras muito mais altas que o lowercase compacto da Clarice).
 * Fator calibrado a olho (feedback do editor 260723).
 */
const CLARICE_VISUAL_BOOST = 1.3;
function clariceScaleForEqualArea(wm: { w: number; h: number }): number {
  return Math.sqrt((wm.w * wm.h) / (CLARICE_W * CLARICE_H)) * CLARICE_VISUAL_BOOST;
}

/** 1200x627 — feed do LinkedIn (1.91:1). Clarice primeiro, lado a lado. */
export async function buildLandscapeSvg(): Promise<string> {
  const W = 1200;
  const H = 627;
  const cx = W / 2;

  const wordmarkSize = 84;
  const wm = await measureWordmark(wordmarkSize);
  const scale = clariceScaleForEqualArea(wm);
  const clariceW = CLARICE_W * scale;
  const clariceH = CLARICE_H * scale;

  const gap = 74; // distância do + até cada logo
  const rowW = clariceW + gap * 2 + wm.w;
  const rowCenterY = 265;

  const clariceX = cx - rowW / 2;
  const clariceTy = rowCenterY - clariceH / 2;
  const plusCx = clariceX + clariceW + gap;
  // Wordmark sem descendentes: topo de tinta = baseline - wm.h.
  const wmBaseline = rowCenterY + wm.h / 2;
  const wmX = plusCx + gap;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.paperEmail}"/>
  ${clariceGroup(clariceX, clariceTy, scale)}
  ${plusMark(plusCx, rowCenterY, 56)}
  ${diariaWordmark(wmX, wmBaseline, wordmarkSize, "start")}
  ${subline(cx, 440, 26)}
</svg>`;
}

/** 1080x1080 — quadrado (Instagram / reuso geral). Clarice primeiro, empilhado. */
export async function buildSquareSvg(): Promise<string> {
  const W = 1080;
  const H = 1080;
  const cx = W / 2;

  const wordmarkSize = 96;
  const wm = await measureWordmark(wordmarkSize);
  const scale = clariceScaleForEqualArea(wm);
  const clariceW = CLARICE_W * scale;
  const clariceH = CLARICE_H * scale;

  const clariceCenterY = 360;
  const plusCenterY = 505;
  const wmCenterY = 640;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${COLORS.paperEmail}"/>
  ${clariceGroup(cx - clariceW / 2, clariceCenterY - clariceH / 2, scale)}
  ${plusMark(cx, plusCenterY, 64)}
  ${diariaWordmark(cx, wmCenterY + wm.h / 2, wordmarkSize, "middle")}
  ${subline(cx, 840, 28)}
</svg>`;
}

async function main(): Promise<void> {
  let outDir = DEFAULT_OUT_DIR;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir" || args[i] === "-o") {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("-")) {
        console.error(`${args[i]} requer um diretório de saída`);
        process.exit(2);
      }
      outDir = resolve(process.cwd(), args[++i]);
    }
  }

  mkdirSync(outDir, { recursive: true });

  const outputs: Array<[string, string]> = [
    ["parceria-clarice-linkedin.png", await buildLandscapeSvg()],
    ["parceria-clarice-square.png", await buildSquareSvg()],
  ];
  for (const [name, svg] of outputs) {
    const outPath = resolve(outDir, name);
    const pngBuf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(outPath, pngBuf);
    console.log(outPath);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("gen-parceria-clarice-image: erro ao gerar imagens:", err);
    process.exit(1);
  });
}
