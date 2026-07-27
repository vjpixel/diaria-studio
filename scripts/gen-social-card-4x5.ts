/**
 * gen-social-card-4x5.ts
 *
 * Gera, para cada destaque de uma edição, um card 1080x1350 (proporção 4:5 —
 * o formato de feed que mais ocupa tela no Instagram e no Facebook) com a
 * imagem do destaque em cima e o TÍTULO renderizado embaixo.
 *
 * Existe porque o pipeline só produzia 2:1 (hero do e-mail) e 1:1 (social):
 * nenhum dos dois carrega o título, então o post dependia 100% da legenda pra
 * dizer do que se trata — e no feed a imagem é o que para o scroll.
 *
 * Reusa o DS canônico (COLORS/FONTS de design-tokens.ts), mesmo cuidado de
 * gen-story-card.ts / gen-default-thumbnail.ts: nada de literal de cor/fonte.
 *
 * Uso:
 *   npx tsx scripts/gen-social-card-4x5.ts --edition-dir data/editions/2607/260727/
 *   npx tsx scripts/gen-social-card-4x5.ts --edition-dir ... --destaque d2
 *
 * Saída: `04-d{N}-4x5.jpg` na raiz da edição (junto dos demais assets de
 * imagem). Imprime JSON com os paths gerados.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { COLORS, FONTS } from "./lib/shared/design-tokens.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { parseDestaques } from "./extract-destaques.ts";

const W = 1080;
const H = 1350;
/** Altura da faixa de texto (embaixo). O resto é imagem. */
const TEXT_H = 470;
const IMG_H = H - TEXT_H;
const PAD = 72;

const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Quebra o título em linhas que caibam na largura útil. Estimativa por
 * caractere (0.52 * font-size) — mesma heurística de largura usada nos outros
 * geradores de card do repo; sem medição real de glifo, o clamp de font-size
 * abaixo é o que garante que não estoura.
 */
export function wrapTitle(title: string, maxCharsPerLine: number): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Escapa texto pra dentro de `<text>` do SVG. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * O kicker vem como `🚀 LANÇAMENTO` no MD. Emoji em SVG depende de fonte de
 * emoji instalada (varia por plataforma — mesmo problema de raster documentado
 * em diaria-design), então fica só o texto.
 */
export function stripKickerEmoji(category: string): string {
  return category.replace(/[^\p{L}\p{N}\s?!.-]/gu, "").trim();
}

export function buildCardSvg(
  title: string,
  _category: string,
  dateLabel = "",
  dims: { w: number; h: number; textH: number } = { w: W, h: H, textH: TEXT_H },
): string {
  const { w: CW, h: CH, textH: CTEXT } = dims;
  const CIMG = CH - CTEXT;
  const available = CW - PAD * 2;
  const maxChars = Math.floor(available / 26);
  const lines = wrapTitle(title, maxChars);
  // Clamp por número de linhas E por largura da linha mais longa: título curto
  // não vira outdoor, título longo não estoura a faixa.
  const longest = Math.max(...lines.map((l) => l.length));
  const widthBased = Math.floor(available / (longest * 0.52));
  const heightBased = Math.floor((CTEXT - 150) / (lines.length * 1.25));
  const size = Math.max(40, Math.min(82, widthBased, heightBased));
  const lineGap = Math.round(size * 1.2);
  // Título ancorado no TOPO da faixa (não centralizado no espaço restante):
  // centralizar deixava um vão morto acima com título de 1 linha e empurrava o
  // texto pra perto do rodapé com 3 linhas. Ancorado, a base é sempre a mesma.
  const startY = CIMG + 92 + size * 0.78;

  const titleLines = lines
    .map(
      (line, i) => `<text x="${PAD}" y="${startY + i * lineGap}" font-family="${FONTS.serif}" font-size="${size}" font-weight="400" fill="${COLORS.ink}">${esc(line)}</text>`,
    )
    .join("\n  ");

  // Filete teal de largura total na junção imagem/faixa: dá acabamento ao corte
  // seco e reaproveita a cor de marca que antes ancorava o kicker (removido).
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <rect x="0" y="${CIMG}" width="${CW}" height="${CTEXT}" fill="${COLORS.paper}"/>
  <rect x="0" y="${CIMG}" width="${CW}" height="8" fill="${COLORS.brand}"/>
  ${titleLines}
  <text x="${PAD}" y="${CH - 62}" font-family="${FONTS.serif}" font-size="34" fill="${COLORS.ink}">diar<tspan fill="${COLORS.brand}">.</tspan>ia<tspan fill="${COLORS.brand}">.</tspan><tspan fill="${COLORS.brand}">br</tspan></text>
  ${dateLabel ? `<text x="${CW - PAD}" y="${CH - 62}" text-anchor="end" font-family="${FONT_SANS}" font-size="24" font-weight="500" letter-spacing="1" fill="#8a8580">${esc(dateLabel)}</text>` : ""}
</svg>`;
}

/**
 * Layout OVERLAY: imagem ocupa o card inteiro, título sobreposto na base sobre
 * um gradiente escuro. Diferente do layout padrão (faixa de papel separada),
 * aqui o contraste é responsabilidade do gradiente — texto claro direto sobre
 * pintura a óleo, sem véu, fica ilegível em qualquer região clara.
 *
 * O gradiente vai de transparente (60% da altura) a quase opaco na base: cobre
 * a área do texto sem apagar a imagem inteira.
 */
export function buildOverlaySvg(
  title: string,
  dateLabel = "",
  dims: { w: number; h: number } = { w: W, h: H },
): string {
  const { w: CW, h: CH } = dims;
  const available = CW - PAD * 2;
  const lines = wrapTitle(title, Math.floor(available / 26));
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.max(44, Math.min(88, Math.floor(available / (longest * 0.52))));
  const lineGap = Math.round(size * 1.18);
  // Ancorado na BASE: o bloco cresce pra cima conforme o número de linhas, então
  // a distância até o rodapé é constante.
  const baseY = CH - 150;
  const startY = baseY - (lines.length - 1) * lineGap;
  const titleLines = lines
    .map(
      (line, i) => `<text x="${PAD}" y="${startY + i * lineGap}" font-family="${FONTS.serif}" font-size="${size}" font-weight="400" fill="#FFFFFF">${esc(line)}</text>`,
    )
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.35" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.62" stop-color="#000000" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${CW}" height="${CH}" fill="url(#scrim)"/>
  <rect x="${PAD}" y="${startY - size - 46}" width="64" height="6" rx="3" fill="${COLORS.brand}"/>
  ${titleLines}
  <text x="${PAD}" y="${CH - 62}" font-family="${FONTS.serif}" font-size="34" fill="#FFFFFF">diar<tspan fill="${COLORS.brand}">.</tspan>ia<tspan fill="${COLORS.brand}">.</tspan><tspan fill="${COLORS.brand}">br</tspan></text>
  ${dateLabel ? `<text x="${CW - PAD}" y="${CH - 62}" text-anchor="end" font-family="${FONT_SANS}" font-size="24" font-weight="500" letter-spacing="1" fill="#FFFFFF" fill-opacity="0.75">${esc(dateLabel)}</text>` : ""}
</svg>`;
}

/** `260727` → `27 JUL 2026` (rodapé do card). */
export function editionDateLabel(editionDir: string): string {
  const m = /(\d{2})(\d{2})(\d{2})(?:[\\/])?$/.exec(editionDir.replace(/[\\/]+$/, ""));
  if (!m) return "";
  const [, yy, mm, dd] = m;
  const meses = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  const mi = Number(mm) - 1;
  if (mi < 0 || mi > 11) return "";
  return `${dd} ${meses[mi]} 20${yy}`;
}

export type CardRatio = "4x5" | "9x16";

/** Dimensões por proporção. 9:16 = Stories (ocupa a tela inteira). */
const RATIOS: Record<CardRatio, { w: number; h: number; textH: number }> = {
  "4x5": { w: 1080, h: 1350, textH: 470 },
  "9x16": { w: 1080, h: 1920, textH: 620 },
};

export async function generateCard(
  editionDir: string,
  destaque: string,
  title: string,
  category: string,
  ratio: CardRatio = "4x5",
  layout: "band" | "overlay" = "overlay",
): Promise<string | null> {
  // Fonte por LAYOUT — os dois recortam em direções opostas:
  //
  //   band    → área de imagem 1080×880 (~1,23:1), mais LARGA que a master
  //             (1,19:1): derivar da master cortaria altura e decepa a figura.
  //             O 2:1 já é o recorte horizontal certo; daqui só sai margem lateral.
  //   overlay → área de imagem 1080×1350 (0,8:1), retrato: precisa da altura que
  //             o 2:1 descartou. Da master sai só margem lateral; do 2:1 comeria
  //             60% da largura (era o que decepava os sujeitos na 260727).
  //
  // Fallback pro 2:1 em edição sem master (geradas antes dela existir).
  // Ordem de preferência da fonte (decisão editorial 260727 — gerar duas vezes):
  //   1. 4:5 NATIVO — arte composta pro card, entra sem recorte nenhum;
  //   2. master 6:5 — recorte lateral (tentativa de arte única pros dois formatos);
  //   3. 2:1 — legado das edições anteriores ao card existir.
  // Servir e-mail e feed com a MESMA arte degradava o hero 2:1, que passava a ser
  // recorte de uma cena mais alta em vez de composição nativa.
  const nativePath = resolve(editionDir, `04-${destaque}-4x5-nativo.jpg`);
  const masterPath = resolve(editionDir, `04-${destaque}-master.jpg`);
  const widePath = resolve(editionDir, `04-${destaque}-2x1.jpg`);
  const src = [nativePath, masterPath, widePath].find((p) => existsSync(p));
  if (!src) return null;
  const dims = RATIOS[ratio];
  const dateLabel = editionDateLabel(editionDir);
  if (layout === "overlay") {
    // Imagem ocupa o card INTEIRO; o texto vem por cima, sobre o gradiente.
    const full = await sharp(src).resize(dims.w, dims.h, { fit: "cover", position: "top" }).toBuffer();
    const outOverlay = resolve(editionDir, `04-${destaque}-${ratio}.jpg`);
    await sharp(full)
      .composite([{ input: Buffer.from(buildOverlaySvg(title, dateLabel, dims)), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toFile(outOverlay);
    return outOverlay;
  }
  const imgH = dims.h - dims.textH;
  // "top": o corte vertical descarta a BASE — que o prompt já reserva como área
  // calma pro texto — em vez de centralizar e comer a cabeça da figura.
  const top = await sharp(src).resize(dims.w, imgH, { fit: "cover", position: "top" }).toBuffer();
  const out = resolve(editionDir, `04-${destaque}-${ratio}-band.jpg`);
  await sharp({ create: { width: dims.w, height: dims.h, channels: 3, background: COLORS.paper } })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: Buffer.from(buildCardSvg(title, category, dateLabel, dims)), top: 0, left: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(out);
  return out;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"] ?? "";
  if (!editionDir) {
    console.error("uso: gen-social-card-4x5.ts --edition-dir <dir> [--destaque d1]");
    process.exit(1);
  }
  const only = args.values.destaque ?? null;
  const ratio = (args.values.ratio ?? "4x5") as CardRatio;
  const layout = (args.values.layout ?? "overlay") as "band" | "overlay";
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    console.error(`02-reviewed.md ausente em ${editionDir}`);
    process.exit(1);
  }
  const destaques = parseDestaques(readFileSync(mdPath, "utf8"));
  const generated: string[] = [];
  for (let i = 0; i < destaques.length; i++) {
    const key = `d${i + 1}`;
    if (only && only !== key) continue;
    const d = destaques[i] as { title?: string; category?: string };
    const out = await generateCard(editionDir, key, d.title ?? "", d.category ?? "", ratio, layout);
    if (out) generated.push(out);
    else console.error(`[gen-social-card-4x5] pulado ${key}: 04-${key}-2x1.jpg ausente`);
  }
  console.log(JSON.stringify({ generated, count: generated.length }, null, 2));
}

if (isMainModule(import.meta.url)) {
  await main();
}
