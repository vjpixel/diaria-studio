/**
 * eia-linkedin-card.ts
 *
 * Arte do "É IA?" para publicação MANUAL no LinkedIn.
 *
 * O LinkedIn não tem enquete com imagem: quem vota escreve "A" ou "B" nos
 * comentários. Isso torna a rotulagem parte da ARTE — o par
 * `01-eia-A.jpg`/`01-eia-B.jpg` que `eia-compose.ts` gera são duas fotos
 * 800×450 sem nenhuma marca, e fora do e-mail (onde o quiz numera as opções)
 * não há nada dizendo qual é qual. Aqui o A e o B vão CARIMBADOS por cima da
 * foto.
 *
 * Dois formatos, porque o LinkedIn trata quantidade de imagem de forma
 * diferente:
 *
 *   - **composto** (`buildEiaCompositeOverlaySvg`): UMA imagem 4:5 com as duas
 *     fotos empilhadas. É o formato seguro — post de imagem única não passa
 *     pela colagem do feed, então nada é cortado e o leitor vê A e B juntos,
 *     que é a comparação que o quiz pede.
 *   - **avulso** (`buildEiaSingleOverlaySvg`): uma imagem 4:5 por opção, pra
 *     quem preferir o post multi-imagem. O carimbo fica no canto superior
 *     esquerdo da foto; a colagem de 2 imagens do LinkedIn corta as laterais
 *     de cada tile, então esse formato assume esse risco de propósito.
 *
 * As funções `build*OverlaySvg` são PURAS e cobrem tudo menos as fotos
 * (fundo, kicker, carimbos, molduras, rodapé) — as fotos entram como
 * composite de buffer em `renderEia*Card`, pra não embutir base64 no SVG.
 */
import sharp from "sharp";
import { COLORS, FONTS } from "./shared/design-tokens.ts";

const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export const CARD_W = 1080;
/** 4:5 — mesma proporção dos cards sociais da diária (`gen-social-card-4x5.ts`). */
export const COMPOSITE_H = 1350;
/**
 * 1:1 no avulso, não 4:5: uma foto 16:9 sozinha num quadro 4:5 deixa faixas
 * de papel grandes demais em cima e embaixo — e o quadrado é o que menos
 * sofre na colagem multi-imagem do LinkedIn.
 */
export const SINGLE_H = 1080;
const PAD = 60;

/** 960×540 = as fotos 800×450 do `eia-compose.ts` em 1.2×, sem mudar o 16:9. */
export const PHOTO_W = CARD_W - PAD * 2;
export const PHOTO_H = Math.round((PHOTO_W * 450) / 800);

const KICKER_BAR_Y = 60;
const KICKER_BASE_Y = 122;

/** Empilhado: A no topo, B embaixo, com o mesmo respiro entre e ao redor. */
export const COMPOSITE_PHOTO_A_Y = 156;
const COMPOSITE_GAP = 28;
export const COMPOSITE_PHOTO_B_Y = COMPOSITE_PHOTO_A_Y + PHOTO_H + COMPOSITE_GAP;

/** Avulso: foto no terço superior, legenda "Opção X" abaixo dela. */
export const SINGLE_PHOTO_Y = 250;
const SINGLE_CAPTION_BASE_Y = SINGLE_PHOTO_Y + PHOTO_H + 92;

const BADGE_SIZE = 112;
const BADGE_INSET = 22;
const BADGE_FONT_SIZE = 68;

export const KICKER = "É IA?";
export const VOTE_CALL = "Responda A ou B nos comentários";

export type EiaOption = "A" | "B";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `diar.ia.br` com os pontos e o TLD em teal — mesmo tratamento do card sem foto. */
function wordmarkMarkup(): string {
  return `diar<tspan fill="${COLORS.brand}">.</tspan>ia<tspan fill="${COLORS.brand}">.</tspan><tspan fill="${COLORS.brand}">br</tspan>`;
}

function kickerMarkup(): string {
  return (
    `<rect x="${PAD}" y="${KICKER_BAR_Y}" width="64" height="6" rx="3" fill="${COLORS.brand}"/>\n` +
    `  <text x="${PAD}" y="${KICKER_BASE_Y}" font-family="${FONT_SANS}" font-size="34" font-weight="700" letter-spacing="2" fill="${COLORS.brand}">${esc(KICKER.toUpperCase())}</text>`
  );
}

/** Rodapé ancorado na base do card — a altura muda entre composto e avulso. */
function footerMarkup(cardH: number): string {
  const y = cardH - 44;
  return (
    `<text x="${PAD}" y="${y}" font-family="${FONT_SANS}" font-size="30" font-weight="600" fill="${COLORS.ink}">${esc(VOTE_CALL)}</text>\n` +
    `  <text x="${CARD_W - PAD}" y="${y}" text-anchor="end" font-family="${FONTS.serif}" font-size="34" fill="${COLORS.ink}">${wordmarkMarkup()}</text>`
  );
}

/** Moldura hairline da foto — a foto é composta POR BAIXO deste overlay. */
function frameMarkup(y: number): string {
  return `<rect x="${PAD + 0.5}" y="${y + 0.5}" width="${PHOTO_W - 1}" height="${PHOTO_H - 1}" fill="none" stroke="${COLORS.rule}" stroke-width="1"/>`;
}

/**
 * Carimbo da opção, no canto superior esquerdo DA FOTO. Fundo cheio em tinta
 * (não translúcido) porque a foto embaixo é imprevisível — meio-tom sobre céu
 * claro já bastou pra sumir com a letra em teste.
 */
function badgeMarkup(letter: EiaOption, photoY: number): string {
  const x = PAD + BADGE_INSET;
  const y = photoY + BADGE_INSET;
  const cx = x + BADGE_SIZE / 2;
  // librsvg ignora `dominant-baseline` com frequência — baseline explícita.
  const baseline = y + BADGE_SIZE / 2 + BADGE_FONT_SIZE * 0.36;
  return (
    `<rect x="${x}" y="${y}" width="${BADGE_SIZE}" height="${BADGE_SIZE}" rx="10" fill="${COLORS.ink}"/>\n` +
    `  <text x="${cx}" y="${baseline}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${BADGE_FONT_SIZE}" font-weight="700" fill="${COLORS.onInk}">${letter}</text>`
  );
}

function svgShell(inner: string, cardH: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${cardH}" viewBox="0 0 ${CARD_W} ${cardH}">
  ${inner}
</svg>`;
}

/**
 * Pure: overlay do card COMPOSTO (as duas fotos empilhadas, carimbadas A e B).
 * Transparente onde as fotos entram.
 */
export function buildEiaCompositeOverlaySvg(): string {
  return svgShell(
    [
      kickerMarkup(),
      frameMarkup(COMPOSITE_PHOTO_A_Y),
      frameMarkup(COMPOSITE_PHOTO_B_Y),
      badgeMarkup("A", COMPOSITE_PHOTO_A_Y),
      badgeMarkup("B", COMPOSITE_PHOTO_B_Y),
      footerMarkup(COMPOSITE_H),
    ].join("\n  "),
    COMPOSITE_H,
  );
}

/** Pure: overlay do card AVULSO de uma opção. */
export function buildEiaSingleOverlaySvg(letter: EiaOption): string {
  const caption = `Opção ${letter}`;
  return svgShell(
    [
      kickerMarkup(),
      frameMarkup(SINGLE_PHOTO_Y),
      badgeMarkup(letter, SINGLE_PHOTO_Y),
      `<text x="${CARD_W / 2}" y="${SINGLE_CAPTION_BASE_Y}" text-anchor="middle" font-family="${FONTS.serif}" font-size="64" fill="${COLORS.ink}">${esc(caption)}</text>`,
      footerMarkup(SINGLE_H),
    ].join("\n  "),
    SINGLE_H,
  );
}

async function photoLayer(path: string, top: number) {
  const input = await sharp(path).resize(PHOTO_W, PHOTO_H, { fit: "cover" }).toBuffer();
  return { input, top, left: PAD };
}

function paperCanvas(cardH: number) {
  return sharp({
    create: { width: CARD_W, height: cardH, channels: 3, background: COLORS.paper },
  });
}

/** Renderiza o card composto (A em cima, B embaixo) num JPEG. */
export async function renderEiaCompositeCard(
  photoAPath: string,
  photoBPath: string,
  outPath: string,
): Promise<string> {
  await paperCanvas(COMPOSITE_H)
    .composite([
      await photoLayer(photoAPath, COMPOSITE_PHOTO_A_Y),
      await photoLayer(photoBPath, COMPOSITE_PHOTO_B_Y),
      { input: Buffer.from(buildEiaCompositeOverlaySvg()), top: 0, left: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return outPath;
}

/** Renderiza o card avulso de uma opção num JPEG. */
export async function renderEiaSingleCard(
  photoPath: string,
  letter: EiaOption,
  outPath: string,
): Promise<string> {
  await paperCanvas(SINGLE_H)
    .composite([
      await photoLayer(photoPath, SINGLE_PHOTO_Y),
      { input: Buffer.from(buildEiaSingleOverlaySvg(letter)), top: 0, left: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return outPath;
}
