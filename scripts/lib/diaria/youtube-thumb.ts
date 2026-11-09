/**
 * scripts/lib/diaria/youtube-thumb.ts (#10800)
 *
 * Miolo da capa do YouTube no padrão diar.ia.br — a parte DETERMINÍSTICA do
 * processo aprovado pelo editor em 22/10/2026 (comentários do #10800):
 *
 *   Horizontal (`04-youtube-thumb.jpg`, 1280x720):
 *     1. retrato do editor gerado por IA a partir de 2 frames do vídeo do dia
 *        (Codex CLI) e recortado com `rembg`/`birefnet-portrait`  → INSUMO,
 *        fora daqui (passo com IA, conduzido pela skill `/diaria-publica-video`, Parte A);
 *     2. fundo = outpaint 16:9 da `04-d1-2x1.jpg` em pintura impasto nítida
 *        → INSUMO, fora daqui (sem outpaint, cai na própria 2:1 com recorte
 *        central e um aviso);
 *     3. composição — ESTE módulo: fundo 1280x720 sem desfoque, gradiente
 *        escuro no TOPO, retrato à esquerda colado na base, gancho de 2 a 4
 *        palavras em Georgia bold cor papel no canto SUPERIOR direito, com o
 *        `?` final em teal.
 *
 *   Desde a edição 261027 (#11220, #11228): o gancho subiu para o canto
 *   superior direito (o gradiente acompanhou, escuro no topo); o gancho aceita
 *   4 palavras ("Google Photos te vigia?") e encolhe para não invadir a cabeça
 *   do retrato; o retrato pode receber o realce de contraste aprovado pelo
 *   editor (`enhancePortrait`, +25% com o alfa do rembg preservado).
 *
 *   Desde a edição 261030 (#11740): o gancho aceita quebra explícita (`|`,
 *   `\n` literal ou quebra real) em até 2 linhas alinhadas à direita, com até
 *   4 palavras POR LINHA ("Confiou no chatbot|e morreu").
 *
 *   Desde a edição 261103 (#11942): o padrão volta a ser o da 261021 ("IA
 *   ladra?"), que o editor apontou como a melhor capa. Layout `bottom`
 *   (default): retrato em close-up grande à esquerda (até 55% da largura,
 *   altura inteira, colado na base), gancho grande no canto INFERIOR direito
 *   (pode passar por cima do ombro, como na referência, mas encolhe se fosse
 *   invadir mais que isso), gradiente escuro na base e vinheta nas bordas. O
 *   close-up vem do Codex com o frame do vídeo só como referência de
 *   identidade (`youtube-thumb-portrait.ts`). O layout `top` (#11220) segue
 *   disponível com `layout: "top"` / `--layout top`.
 *
 *   Desde a edição 261104 (#12123): layout `right`, o espelho do `bottom` —
 *   retrato colado à DIREITA, gancho embaixo à esquerda (linhas alinhadas à
 *   esquerda), vinheta com o centro em `cx=0.38`, a cena do D1 à esquerda.
 *   `bgCrop` recorta uma região do fundo antes do encaixe 16:9 (amplia a
 *   cena sem novo outpaint).
 *
 *   Short (capa vertical): um frame do próprio vídeo vertical dentro da janela
 *   do lettering do título (~3,5 s iniciais) — `ffmpeg -ss {t}`; aqui só os
 *   argumentos e a checagem da janela.
 *
 * Referência do padrão (#11942): `data/editions/2610/261021/04-youtube-thumb.jpg`.
 * Também aprovadas: `261022/04-youtube-thumb.jpg` e, no layout `top`,
 * `261027/04-youtube-thumb.jpg`.
 */

import sharp from "sharp";
import { COLORS, FONTS } from "../shared/design-tokens.ts";
import type { PortraitSide } from "./youtube-thumb-portrait.ts";

export const YOUTUBE_THUMB_W = 1280;
export const YOUTUBE_THUMB_H = 720;
/** Limite de `thumbnails.set` da YouTube Data API. */
export const YOUTUBE_THUMB_MAX_BYTES = 2 * 1024 * 1024;
/** Nome da capa do Short na pasta da edição (o mesmo usado à mão em 261022). */
export const YOUTUBE_SHORT_COVER_FILE = "04-youtube-short-capa.jpg";
/** O título do D1 aparece em lettering só nos ~3,5 s iniciais do vertical. */
export const SHORT_COVER_LETTERING_WINDOW_S = 3.5;

/** Margens e caixa do gancho, medidas nas duas referências aprovadas. */
const HOOK_RIGHT_MARGIN = 40;
/** Distância entre o topo da caixa do texto e a borda de cima (#11220). */
const HOOK_TOP_MARGIN = 40;
/** O gancho nunca invade o terço esquerdo inteiro (é do retrato). */
const HOOK_MAX_WIDTH = 800;
/** Folga mínima entre o gancho e a parte opaca do retrato nas mesmas linhas (#11228). */
const HOOK_PORTRAIT_GAP = 24;
/** Abaixo desta largura o gancho não encolhe mais (fica ilegível); vira aviso. */
const HOOK_MIN_WIDTH = 320;
/** Palavras do gancho: 2 a 4 (o 4 entrou em 261027, #11228). */
export const HOOK_MIN_WORDS = 2;
export const HOOK_MAX_WORDS = 4;
const HOOK_MAX_FONT = 130;
const HOOK_MIN_FONT = 64;
/** Largura média por caractere do Georgia bold, em em (conservador). */
const GEORGIA_BOLD_CHAR_EM = 0.56;
/** Entrelinha do gancho em 2 linhas (#11740), em em. */
const HOOK_LINE_HEIGHT_EM = 1.08;
/** Retrato ocupa até 94% da altura e até metade da largura. */
const PORTRAIT_MAX_H_RATIO = 0.94;
const PORTRAIT_MAX_W_RATIO = 0.5;
/**
 * Gradiente escuro no TOPO, atrás do gancho (#11220): do topo até 45% da
 * altura, opacidade máxima 0,6 na borda de cima (referência: a capa de 261027).
 */
export const GRADIENT_END_RATIO = 0.45;
export const GRADIENT_MAX_OPACITY = 0.6;

/**
 * Layout da capa horizontal (#11942). `bottom` = padrão da 261021 (close-up à
 * esquerda, gancho embaixo à direita, vinheta); `top` = padrão de 261027
 * (#11220: retrato de corpo na base, gancho no topo); `right` = espelho do
 * `bottom` (#12123: retrato à direita, gancho embaixo à esquerda, capa da
 * 261104).
 */
export type ThumbLayout = "bottom" | "top" | "right";
export const THUMB_LAYOUTS: readonly ThumbLayout[] = ["bottom", "top", "right"];
export const DEFAULT_THUMB_LAYOUT: ThumbLayout = "bottom";

/** Valida o `--layout`; ausente → default. Lança com as opções fora delas. */
export function parseThumbLayout(raw: string | undefined): ThumbLayout {
  if (raw === undefined) return DEFAULT_THUMB_LAYOUT;
  const v = raw.trim().toLowerCase();
  if ((THUMB_LAYOUTS as readonly string[]).includes(v)) return v as ThumbLayout;
  throw new Error(
    `--layout ${JSON.stringify(raw)} inválido: use ${THUMB_LAYOUTS.slice(0, -1).join(", ")} ou ${THUMB_LAYOUTS[THUMB_LAYOUTS.length - 1]} (default ${DEFAULT_THUMB_LAYOUT}, #11942)`,
  );
}

/** Lado em que o retrato entra na capa (#12123): `right` só no layout `right`. */
export function portraitSideForLayout(layout: ThumbLayout): PortraitSide {
  return layout === "right" ? "right" : "left";
}

/** Recorte do fundo em pixels da imagem de origem (#12123, `--bg-crop x,y,w,h`). */
export interface BgCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Valida `--bg-crop x,y,w,h` (inteiros ≥ 0, largura e altura > 0). Os limites da imagem são checados na composição. */
export function parseBgCrop(raw: string): BgCrop {
  const parts = raw.split(",").map((s) => s.trim());
  const nums = parts.map(Number);
  if (parts.length !== 4 || nums.some((n, i) => parts[i] === "" || !Number.isInteger(n) || n < 0)) {
    throw new Error(`--bg-crop ${JSON.stringify(raw)} inválido: use x,y,largura,altura em pixels inteiros da imagem de fundo (ex.: 200,80,1400,788)`);
  }
  const [left, top, width, height] = nums;
  if (width === 0 || height === 0) throw new Error(`--bg-crop ${JSON.stringify(raw)}: largura e altura precisam ser maiores que zero`);
  return { left, top, width, height };
}

/** Pure: o recorte cabe na imagem? Lança com as dimensões se não couber. */
export function assertBgCropInside(crop: BgCrop, width: number, height: number): void {
  if (crop.left + crop.width > width || crop.top + crop.height > height) {
    throw new Error(
      `--bg-crop ${crop.left},${crop.top},${crop.width},${crop.height} passa da imagem de fundo (${width}x${height}): x+largura ≤ ${width} e y+altura ≤ ${height}`,
    );
  }
}

/** Layout `bottom` (#11942): close-up até 55% da largura, altura inteira. */
const BOTTOM_PORTRAIT_MAX_W_RATIO = 0.55;
const BOTTOM_PORTRAIT_MAX_H_RATIO = 1;
/** Distância entre a base da caixa do gancho e a borda de baixo (#11942). */
const HOOK_BOTTOM_MARGIN = 40;
/**
 * O gancho de baixo nunca começa antes de ~40% da largura (na 261021 começa
 * em x≈560 de 1280): largura máxima 720.
 */
const BOTTOM_HOOK_MAX_WIDTH = 720;
/**
 * Quanto o gancho de baixo pode passar por cima do retrato (o ombro), em px.
 * Na 261021 o "IA" cobre ~140 px da camiseta; acima disso o gancho encolhe.
 */
export const BOTTOM_HOOK_PORTRAIT_OVERLAP = 160;
/** Vinheta (#11942): bordas escurecidas, centro da cena à direita intacto. */
export const VIGNETTE_MAX_OPACITY = 0.7;
/** Centro horizontal da vinheta: cena à direita no `bottom` (#11942), espelhada no `right` (#12123). */
export const VIGNETTE_CX_BOTTOM = 0.62;
export const VIGNETTE_CX_RIGHT = 0.38;
/** Margem esquerda do gancho no layout `right` (#12123), espelho da direita. */
const HOOK_LEFT_MARGIN = 40;

export interface HookParts {
  /** Texto em cor papel (sem o `?` final). Com quebra, as linhas unidas por espaço. */
  body: string;
  /** `?` final em teal, ou "" quando o gancho não termina em pergunta. */
  mark: string;
  /**
   * Linhas do gancho (sem o `?` final, que vai no fim da última), só quando o
   * `--hook` traz quebra explícita (#11740). Ausente = uma linha só.
   */
  lines?: string[];
}

/** Quebra explícita no gancho (#11740): no máximo 2 linhas, cada uma alinhada à direita. */
export const HOOK_MAX_LINES = 2;
/** Por linha, com quebra explícita (#11740): até 4 palavras; total até 8. */
export const HOOK_MAX_WORDS_PER_LINE = 4;

/**
 * Separador de linha aceito no `--hook` (#11740): quebra de linha real, o
 * `\n` literal que o shell passa sem interpretar, ou `|`.
 */
const HOOK_LINE_BREAK_RE = /\r?\n|\\n|\|/;

function hookWords(s: string): string[] {
  // Moeda e número formam um token na contagem (#12278), sem alterar a copy.
  return s.replace(/(^|\s)((?:[A-Z]{1,3}\$|\p{Sc}))\s+(?=\d)/gu, "$1$2")
    .replace(/[?!.…]+$/u, "").split(" ").filter(Boolean);
}

/**
 * Valida o gancho (2 a 4 palavras: 2-3 na decisão de 22/10/2026, 4 aprovado
 * pelo editor em 261027, #11228) e separa o `?` final, que vai em teal. A
 * largura é controlada pelo tamanho da fonte e pelo encolhimento perto do
 * retrato, não pela contagem. Lança com mensagem acionável fora da regra.
 *
 * Quebra explícita (#11740, capa de 261030: "Confiou no chatbot|e morreu"):
 * até 2 linhas, cada uma com 1 a 4 palavras, e o total segue com o piso de 2.
 * O limite de 4 vale POR LINHA, não para o gancho inteiro.
 */
export function splitHook(hook: string): HookParts {
  const rawLines = hook.split(HOOK_LINE_BREAK_RE).map((l) => l.replace(/\s+/g, " ").trim());
  const lines = rawLines.filter(Boolean);
  if (lines.length > 0 && lines.length !== rawLines.length) {
    throw new Error(`gancho ${JSON.stringify(hook)} tem linha vazia — use a quebra só entre as linhas (ex.: "Confiou no chatbot|e morreu")`);
  }
  if (lines.length === 0) throw new Error("gancho vazio — passe --hook \"IA ladra?\" (2 a 4 palavras)");
  if (lines.length === 1) {
    const clean = lines[0];
    const words = hookWords(clean);
    if (words.length < HOOK_MIN_WORDS || words.length > HOOK_MAX_WORDS) {
      throw new Error(
        `gancho ${JSON.stringify(clean)} tem ${words.length} palavra(s); a regra é 2 a 4 (ex.: "IA antiveneno?", "Google Photos te vigia?"). ` +
          `Mais de 4 só em 2 linhas, com quebra explícita: "Confiou no chatbot|e morreu" (#11740)`,
      );
    }
    if (clean.endsWith("?")) return { body: clean.slice(0, -1).trimEnd(), mark: "?" };
    return { body: clean, mark: "" };
  }
  if (lines.length > HOOK_MAX_LINES) {
    throw new Error(`gancho ${JSON.stringify(hook)} tem ${lines.length} linhas; o máximo é ${HOOK_MAX_LINES} (#11740)`);
  }
  for (const [i, line] of lines.entries()) {
    const n = hookWords(line).length;
    if (n < 1 || n > HOOK_MAX_WORDS_PER_LINE) {
      throw new Error(`linha ${i + 1} do gancho (${JSON.stringify(line)}) tem ${n} palavra(s); a regra é 1 a ${HOOK_MAX_WORDS_PER_LINE} por linha (#11740)`);
    }
  }
  const total = lines.reduce((acc, l) => acc + hookWords(l).length, 0);
  if (total < HOOK_MIN_WORDS) {
    throw new Error(`gancho ${JSON.stringify(hook)} tem ${total} palavra(s); o mínimo é ${HOOK_MIN_WORDS}`);
  }
  const last = lines[lines.length - 1];
  const mark = last.endsWith("?") ? "?" : "";
  const bodyLines = [...lines.slice(0, -1), mark ? last.slice(0, -1).trimEnd() : last];
  return { body: bodyLines.join(" "), mark, lines: bodyLines };
}

/** Linhas do gancho como desenhadas (o `?` só no fim da última). */
function hookDrawnLines(hook: HookParts): string[] {
  const lines = hook.lines ?? [hook.body];
  return lines.map((l, i) => (i === lines.length - 1 ? l + hook.mark : l));
}

/**
 * Tamanho do gancho: o maior que cabe em HOOK_MAX_WIDTH, entre 64 e 130 px.
 * Com 2 linhas (#11740), quem manda é a linha mais longa.
 */
export function hookFontSize(hook: HookParts): number {
  const chars = Math.max(...hookDrawnLines(hook).map((l) => Array.from(l).length));
  const fit = Math.floor(HOOK_MAX_WIDTH / (chars * GEORGIA_BOLD_CHAR_EM));
  return Math.max(HOOK_MIN_FONT, Math.min(HOOK_MAX_FONT, fit));
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Camada do gradiente escuro (fica ATRÁS do retrato, pra não apagá-lo). Desde
 * o #11220 é escura no topo, onde está o gancho, e some em 45% da altura.
 */
export function buildGradientSvg(w = YOUTUBE_THUMB_W, h = YOUTUBE_THUMB_H, position: "top" | "bottom" = "top"): string {
  const y1 = Math.round(h * GRADIENT_END_RATIO);
  if (position === "bottom") {
    // #11942: espelho do de cima — escuro na base, onde fica o gancho.
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity="${GRADIENT_MAX_OPACITY}"/>` +
      `</linearGradient></defs>` +
      `<rect x="0" y="${h - y1}" width="${w}" height="${y1}" fill="url(#g)"/>` +
      `</svg>`
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#000" stop-opacity="${GRADIENT_MAX_OPACITY}"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<rect x="0" y="0" width="${w}" height="${y1}" fill="url(#g)"/>` +
    `</svg>`
  );
}

/**
 * Vinheta do layout `bottom` (#11942): radial elíptica, transparente no miolo
 * (centrado um pouco à direita, onde fica a cena do D1) e escura nas bordas,
 * como na capa de 261021. Fica atrás do retrato.
 */
export function buildVignetteSvg(w = YOUTUBE_THUMB_W, h = YOUTUBE_THUMB_H, cx = VIGNETTE_CX_BOTTOM): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><radialGradient id="v" cx="${cx}" cy="0.42" r="0.75">` +
    `<stop offset="0.45" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="${VIGNETTE_MAX_OPACITY}"/>` +
    `</radialGradient></defs>` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#v)"/>` +
    `</svg>`
  );
}

/**
 * Camada do gancho, isolada: Georgia bold cor papel, `?` em teal. O
 * posicionamento no canto superior direito é feito depois, a partir da caixa
 * REAL do texto rasterizado (`trim`), e não por `text-anchor="end"`: assim a
 * largura máxima vale mesmo quando a fonte efetiva tem métrica diferente da
 * estimada em `hookFontSize` (fallback sem Georgia sai bem mais largo).
 */
export function buildHookSvg(hook: string, align: "end" | "start" | "middle" = "end"): string {
  const parts = splitHook(hook);
  const size = hookFontSize(parts);
  const textAttrs = `font-family="${escapeXml(FONTS.serif)}" font-weight="700" font-size="${size}" fill="${COLORS.onInk}"`;
  const mark = parts.mark ? `<tspan fill="${COLORS.brand}">${escapeXml(parts.mark)}</tspan>` : "";
  if (!parts.lines) {
    const chars = Array.from(parts.body + parts.mark).length;
    // Canvas folgado: o texto real é recortado por `trim` na composição.
    const w = Math.ceil(chars * size * 0.9) + 2 * size;
    const h = Math.ceil(size * 1.6);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<text x="${size}" y="${Math.round(size * 1.2)}" ${textAttrs}>` +
      `${escapeXml(parts.body)}${mark}</text>` +
      `</svg>`
    );
  }
  // #11740: uma <text> por linha, todas ancoradas no MESMO x à direita
  // (`text-anchor="end"`), então as linhas saem alinhadas à direita entre si; o
  // `trim` da composição recorta a caixa do bloco e o encaixe no canto segue
  // pela caixa real, como na linha única. No layout `right` (#12123) o gancho
  // fica à esquerda e as linhas se alinham à esquerda (`align: "start"`).
  const chars = Math.max(...hookDrawnLines(parts).map((l) => Array.from(l).length));
  const lineHeight = Math.round(size * HOOK_LINE_HEIGHT_EM);
  const w = Math.ceil(chars * size * 0.9) + 2 * size;
  const h = Math.ceil(size * 1.6) + lineHeight * (parts.lines.length - 1);
  // #12462: `middle` centraliza as linhas entre si (capa vertical do Short).
  const x = align === "end" ? w - size : align === "middle" ? Math.round(w / 2) : size;
  const rows = parts.lines.map((line, i) => {
    const isLast = i === parts.lines!.length - 1;
    const y = Math.round(size * 1.2) + i * lineHeight;
    return `<text x="${x}" y="${y}" text-anchor="${align}" ${textAttrs}>${escapeXml(line)}${isLast ? mark : ""}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${rows.join("")}</svg>`;
}

/**
 * Rasteriza o gancho, recorta a caixa real e encolhe se passar de `maxWidth`
 * (encolher a camada rasterizada equivale a reduzir a fonte).
 */
async function renderHookLayer(
  hook: string,
  maxWidth = HOOK_MAX_WIDTH,
  align: "end" | "start" | "middle" = "end",
): Promise<{ png: Buffer; width: number; height: number }> {
  let png = await sharp(Buffer.from(buildHookSvg(hook, align))).png().trim().toBuffer();
  let meta = await sharp(png).metadata();
  if ((meta.width ?? 0) > maxWidth) {
    png = await sharp(png).resize({ width: maxWidth }).png().toBuffer();
    meta = await sharp(png).metadata();
  }
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/**
 * Maior x (coordenada da capa) com pixel visível do retrato entre as linhas
 * `y0..y1` da capa, ou -1 se o retrato não tem nada visível ali. O retrato é
 * colado à esquerda (`left = 0`), com o topo em `top`. Puro sobre o buffer
 * RGBA cru; exportado para teste.
 */
export function portraitRightEdgeInRows(
  rgba: { data: Uint8Array; width: number; height: number; channels: number },
  top: number,
  y0: number,
  y1: number,
  alphaThreshold = 16,
): number {
  let maxX = -1;
  const from = Math.max(0, y0 - top);
  const to = Math.min(rgba.height - 1, y1 - top);
  for (let y = from; y <= to; y++) {
    for (let x = rgba.width - 1; x > maxX; x--) {
      if (rgba.data[(y * rgba.width + x) * rgba.channels + rgba.channels - 1] > alphaThreshold) {
        maxX = x;
        break;
      }
    }
  }
  return maxX;
}

/**
 * Largura disponível para o gancho no topo à direita sem invadir o retrato
 * (#11228): da borda direita (menos a margem) até a parte opaca mais à direita
 * do retrato nas linhas que o gancho ocupa, menos a folga. Nunca passa de
 * `HOOK_MAX_WIDTH`.
 */
export function hookWidthBeside(portraitRight: number, thumbW = YOUTUBE_THUMB_W): number {
  if (portraitRight < 0) return HOOK_MAX_WIDTH;
  return Math.min(HOOK_MAX_WIDTH, thumbW - HOOK_RIGHT_MARGIN - (portraitRight + 1 + HOOK_PORTRAIT_GAP));
}

/**
 * Largura disponível para o gancho EMBAIXO à direita (#11942): ele pode passar
 * por cima do retrato até `BOTTOM_HOOK_PORTRAIT_OVERLAP` px (o ombro, como na
 * 261021), nunca mais que isso, e nunca passa de `BOTTOM_HOOK_MAX_WIDTH`.
 */
export function hookWidthBesideBottom(portraitRight: number, thumbW = YOUTUBE_THUMB_W): number {
  if (portraitRight < 0) return BOTTOM_HOOK_MAX_WIDTH;
  const startX = Math.max(0, portraitRight + 1 - BOTTOM_HOOK_PORTRAIT_OVERLAP);
  return Math.min(BOTTOM_HOOK_MAX_WIDTH, thumbW - HOOK_RIGHT_MARGIN - startX);
}

/**
 * Menor x (coordenada do RETRATO, 0 = borda esquerda dele) com pixel visível
 * entre as linhas `y0..y1` da capa, ou -1 se não há nada visível ali (#12123,
 * layout `right`: o gancho fica à esquerda do retrato). Mesmo contrato de
 * `portraitRightEdgeInRows`.
 */
export function portraitLeftEdgeInRows(
  rgba: { data: Uint8Array; width: number; height: number; channels: number },
  top: number,
  y0: number,
  y1: number,
  alphaThreshold = 16,
): number {
  let minX = rgba.width;
  const from = Math.max(0, y0 - top);
  const to = Math.min(rgba.height - 1, y1 - top);
  for (let y = from; y <= to; y++) {
    for (let x = 0; x < minX; x++) {
      if (rgba.data[(y * rgba.width + x) * rgba.channels + rgba.channels - 1] > alphaThreshold) {
        minX = x;
        break;
      }
    }
  }
  return minX === rgba.width ? -1 : minX;
}

/**
 * Largura disponível para o gancho EMBAIXO à ESQUERDA (#12123, layout
 * `right`): espelho de `hookWidthBesideBottom`. `portraitLeft` é a coordenada
 * da CAPA do pixel visível mais à esquerda do retrato nas linhas do gancho
 * (-1 = nada ali); o gancho pode passar por cima dele até
 * `BOTTOM_HOOK_PORTRAIT_OVERLAP` px.
 */
export function hookWidthBesideBottomLeft(portraitLeft: number, thumbW = YOUTUBE_THUMB_W): number {
  if (portraitLeft < 0) return BOTTOM_HOOK_MAX_WIDTH;
  const endX = Math.min(thumbW, portraitLeft + BOTTOM_HOOK_PORTRAIT_OVERLAP);
  return Math.min(BOTTOM_HOOK_MAX_WIDTH, endX - HOOK_LEFT_MARGIN);
}

/** Realce do retrato aprovado pelo editor em 261027 (#11228). */
export const PORTRAIT_CONTRAST = { a: 1.25, b: -32 } as const;
export const PORTRAIT_SATURATION = 1.08;

/**
 * Contraste +25% (`linear(1.25, -32)`), nitidez e saturação leve no retrato
 * recortado, PRESERVANDO o alfa do rembg (#11228). `linear` em RGBA também
 * mexeria no alfa (foi o que apagou a transparência no 1º ajuste de 261027):
 * o realce roda só nos canais de cor e a máscara original volta com
 * `dest-in`. Lança se o retrato não tiver transparência (recorte não rodou).
 */
export async function enhancePortrait(portrait: Buffer): Promise<Buffer> {
  const meta = await sharp(portrait).metadata();
  if (!meta.hasAlpha) {
    throw new Error("retrato sem transparência — recorte antes com rembg (modelo birefnet-portrait): só a pessoa, sem fundo");
  }
  const color = await sharp(portrait)
    .rotate()
    .removeAlpha()
    .linear(PORTRAIT_CONTRAST.a, PORTRAIT_CONTRAST.b)
    .sharpen()
    .modulate({ saturation: PORTRAIT_SATURATION })
    .ensureAlpha()
    .png()
    .toBuffer();
  const mask = await sharp(portrait).rotate().png().toBuffer();
  return sharp(color).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

export interface ComposeThumbInput {
  /** Fundo: idealmente o outpaint 16:9 da `04-d1-2x1.jpg`. */
  background: Buffer;
  /** Retrato recortado (PNG com transparência — só a pessoa, sem fundo). */
  portrait: Buffer;
  hook: string;
  /** Aplica `enhancePortrait` antes de compor (#11228). Default: false. */
  enhancePortrait?: boolean;
  /** Layout (#11942). Default: `bottom`, o padrão da 261021. */
  layout?: ThumbLayout;
  /**
   * Região do fundo (pixels da imagem de origem, depois da rotação EXIF) que
   * vira a cena (#12123): amplia a cena do D1 sem novo outpaint.
   */
  bgCrop?: BgCrop;
}

export interface ComposeThumbResult {
  jpeg: Buffer;
  warnings: string[];
}

/** Proporção 16:9 com tolerância de 2%. */
export function isSixteenByNine(width: number, height: number): boolean {
  return Math.abs(width / height - 16 / 9) <= (16 / 9) * 0.02;
}

/**
 * Compõe a capa 1280x720. Lança se o retrato não tiver transparência (sinal de
 * que o recorte do `rembg` não rodou — a regra é "só a pessoa, sem fundo").
 */
export async function composeYouTubeThumb(input: ComposeThumbInput): Promise<ComposeThumbResult> {
  const warnings: string[] = [];
  const W = YOUTUBE_THUMB_W;
  const H = YOUTUBE_THUMB_H;

  // Valida o gancho antes de qualquer trabalho de imagem.
  splitHook(input.hook);

  const bgMeta = await sharp(input.background).metadata();
  if (!bgMeta.width || !bgMeta.height) throw new Error("fundo ilegível (sem dimensões)");
  // #12123: o recorte vale sobre a imagem já orientada (EXIF), a que o editor vê.
  let bgSource = input.background;
  let [bgW, bgH] = [bgMeta.width, bgMeta.height];
  if (input.bgCrop) {
    const oriented = await sharp(input.background).rotate().toBuffer({ resolveWithObject: true });
    assertBgCropInside(input.bgCrop, oriented.info.width, oriented.info.height);
    bgSource = await sharp(oriented.data).extract(input.bgCrop).toBuffer();
    [bgW, bgH] = [input.bgCrop.width, input.bgCrop.height];
  }
  if (!isSixteenByNine(bgW, bgH)) {
    warnings.push(
      input.bgCrop
        ? `recorte do fundo ${bgW}x${bgH} não é 16:9 — recortado de novo no centro; use largura/altura ≈ 16:9 no --bg-crop`
        : `fundo ${bgW}x${bgH} não é 16:9 — recortado no centro; o processo aprovado usa o outpaint 16:9 da 04-d1-2x1.jpg com o objeto do D1 menor e inteiro à direita`,
    );
  }

  const ptMeta = await sharp(input.portrait).metadata();
  if (!ptMeta.hasAlpha) {
    throw new Error("retrato sem transparência — recorte antes com rembg (modelo birefnet-portrait): só a pessoa, sem fundo");
  }

  // Fundo: cover, sem desfoque (regra do editor: "nunca desfoque").
  const background = await sharp(bgSource)
    .rotate()
    .resize(W, H, { fit: "cover", position: "centre" })
    .toBuffer();

  const layout = input.layout ?? DEFAULT_THUMB_LAYOUT;
  // #12123: `right` é o `bottom` espelhado — mesmo close-up, gancho embaixo, vinheta.
  const mirrored = layout === "right";
  const bottom = layout === "bottom" || mirrored;

  // Retrato: apara a transparência em volta e cola à esquerda (à direita no
  // `right`, #12123), na base. No layout `top` cabe em 50% x 94%; no `bottom`
  // e no `right` (#11942) é o close-up grande, até 55% da largura e a altura
  // inteira.
  const source = input.enhancePortrait ? await enhancePortrait(input.portrait) : input.portrait;
  const trimmed = await sharp(source).rotate().trim().png().toBuffer();
  const [maxWRatio, maxHRatio] = bottom
    ? [BOTTOM_PORTRAIT_MAX_W_RATIO, BOTTOM_PORTRAIT_MAX_H_RATIO]
    : [PORTRAIT_MAX_W_RATIO, PORTRAIT_MAX_H_RATIO];
  const portrait = await sharp(trimmed)
    .resize(Math.round(W * maxWRatio), Math.round(H * maxHRatio), { fit: "inside" })
    .png()
    .toBuffer();
  const portraitMeta = await sharp(portrait).metadata();
  const ph = portraitMeta.height ?? 0;
  const pw = portraitMeta.width ?? 0;
  // #12123: no `right` o retrato cola na borda direita e o gancho vai à esquerda.
  const portraitLeft = mirrored ? W - pw : 0;
  const hookAlign = mirrored ? "start" : "end";
  const maxHookWidth = bottom ? BOTTOM_HOOK_MAX_WIDTH : HOOK_MAX_WIDTH;
  let hookLayer = await renderHookLayer(input.hook, maxHookWidth, hookAlign);
  const hookTop = (height: number) => (bottom ? H - HOOK_BOTTOM_MARGIN - height : HOOK_TOP_MARGIN);

  // #11228: no topo, o gancho não pode invadir a cabeça do retrato; #11942:
  // embaixo, pode passar por cima do ombro só até BOTTOM_HOOK_PORTRAIT_OVERLAP.
  // Mede a parte opaca do retrato nas linhas do gancho e encolhe o gancho
  // (equivale a reduzir a fonte) até caber.
  const portraitRaw = await sharp(portrait).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawImg = { data: portraitRaw.data, width: portraitRaw.info.width, height: portraitRaw.info.height, channels: portraitRaw.info.channels };
  const y0 = hookTop(hookLayer.height);
  const y1 = y0 + hookLayer.height;
  let available: number;
  if (mirrored) {
    const leftEdge = portraitLeftEdgeInRows(rawImg, H - ph, y0, y1);
    available = hookWidthBesideBottomLeft(leftEdge < 0 ? -1 : portraitLeft + leftEdge, W);
  } else {
    const rightEdge = portraitRightEdgeInRows(rawImg, H - ph, y0, y1);
    available = bottom ? hookWidthBesideBottom(rightEdge, W) : hookWidthBeside(rightEdge, W);
  }
  if (hookLayer.width > available) {
    if (available < HOOK_MIN_WIDTH) {
      warnings.push(
        bottom
          ? `gancho cobriria demais o retrato (só ${available}px livres ${mirrored ? "à esquerda" : "à direita"} dele) — reduzido ao mínimo de ${HOOK_MIN_WIDTH}px e pode sobrepor; encurte o gancho ou use um close-up mais estreito`
          : `gancho encostaria no retrato (só ${available}px livres ao lado da cabeça) — reduzido ao mínimo de ${HOOK_MIN_WIDTH}px e pode sobrepor; encurte o gancho ou use um retrato mais baixo`,
      );
    }
    hookLayer = await renderHookLayer(input.hook, Math.max(HOOK_MIN_WIDTH, available), hookAlign);
  }

  // Embaixo, o gancho vai POR CIMA do retrato (cobre o ombro, como na 261021);
  // a vinheta e o gradiente ficam atrás do retrato em todos os layouts.
  const shading = bottom
    ? [
        { input: Buffer.from(buildVignetteSvg(W, H, mirrored ? VIGNETTE_CX_RIGHT : VIGNETTE_CX_BOTTOM)), left: 0, top: 0 },
        { input: Buffer.from(buildGradientSvg(W, H, "bottom")), left: 0, top: 0 },
      ]
    : [{ input: Buffer.from(buildGradientSvg(W, H, "top")), left: 0, top: 0 }];

  const compose = (quality: number) =>
    sharp(background)
      .composite([
        ...shading,
        { input: portrait, left: portraitLeft, top: H - ph },
        {
          input: hookLayer.png,
          left: mirrored ? HOOK_LEFT_MARGIN : W - HOOK_RIGHT_MARGIN - hookLayer.width,
          top: hookTop(hookLayer.height),
        },
      ])
      .flatten({ background: COLORS.ink })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

  let jpeg = await compose(90);
  for (const q of [82, 74, 66]) {
    if (jpeg.length <= YOUTUBE_THUMB_MAX_BYTES) break;
    jpeg = await compose(q);
  }
  if (jpeg.length > YOUTUBE_THUMB_MAX_BYTES) {
    throw new Error(`capa com ${jpeg.length} bytes passa do limite de 2 MB do YouTube mesmo em qualidade 66`);
  }
  return { jpeg, warnings };
}

export interface ShortCoverPlan {
  args: string[];
  warnings: string[];
}

/**
 * Argumentos do `ffmpeg` para extrair o frame da capa do Short em
 * `atSeconds`. Sem gancho (`withHook: false`, a capa antiga): fora da janela
 * do lettering do título vira aviso (a capa mostrava o título do D1 em
 * Georgia no topo). Com gancho próprio (#12462, o padrão desde 08/11/2026):
 * o aviso inverte, porque dentro da janela o lettering do título do D1
 * apareceria junto do gancho.
 */
export function planShortCoverFrame(video: string, atSeconds: number, out: string, opts: { withHook?: boolean } = {}): ShortCoverPlan {
  if (!Number.isFinite(atSeconds) || atSeconds < 0) {
    throw new Error(`--at inválido: ${atSeconds} (segundos, ex.: 1.8)`);
  }
  const warnings: string[] = [];
  if (opts.withHook) {
    if (atSeconds <= SHORT_COVER_LETTERING_WINDOW_S) {
      warnings.push(
        `frame aos ${atSeconds}s está dentro da janela do lettering do título (0–${SHORT_COVER_LETTERING_WINDOW_S}s) — o título do D1 apareceria junto do gancho; escolha um frame depois de ${SHORT_COVER_LETTERING_WINDOW_S}s`,
      );
    }
  } else if (atSeconds > SHORT_COVER_LETTERING_WINDOW_S) {
    warnings.push(
      `frame aos ${atSeconds}s está fora da janela do lettering do título (0–${SHORT_COVER_LETTERING_WINDOW_S}s) — a capa sairia sem o título do D1`,
    );
  }
  return {
    args: ["-hide_banner", "-loglevel", "error", "-ss", String(atSeconds), "-i", video, "-frames:v", "1", "-q:v", "2", "-y", out],
    warnings,
  };
}

// ─── Capa vertical do Short com gancho próprio (#12462 itens 3 e 4) ─────────

/** Capa vertical do Short (feed de Shorts, Studio web): 1080x1920. */
export const SHORT_COVER_W = 1080;
export const SHORT_COVER_H = 1920;
/**
 * Gancho da capa vertical: 2 a 5 palavras (decisão do editor de 08/11/2026,
 * #12462 item 3). Um a mais que o horizontal (2 a 4), porque a capa vertical
 * quebra o gancho em 2 linhas. A palavra-chave fica no título (#12463/#12464);
 * a capa traz o gancho, nunca repete o título do D1.
 */
export const SHORT_HOOK_MIN_WORDS = 2;
export const SHORT_HOOK_MAX_WORDS = 5;
/**
 * Onde começa o painel escuro do gancho, em fração da altura. Cobre a
 * legenda queimada do vertical (terço de baixo) e deixa o rosto no alto
 * visível — o layout do corte de 08/11/2026, feito à mão (#12462 item 4).
 */
export const SHORT_COVER_PANEL_TOP_RATIO = 0.62;
export const SHORT_COVER_PANEL_OPACITY = 0.88;
/** Largura máxima do gancho na capa vertical (margem de 60 px de cada lado). */
const SHORT_HOOK_MAX_WIDTH = SHORT_COVER_W - 120;

function shortHookWords(line: string): string[] {
  return line.replace(/[?!.…]+$/u, "").split(" ").filter(Boolean);
}

/**
 * Pure (#12462): valida o gancho da capa vertical (2 a 5 palavras no total) e
 * devolve no formato de linhas do `splitHook` (`"linha 1|linha 2"`). Gancho
 * em 1 linha com mais de 3 palavras quebra em 2 linhas equilibradas (a
 * primeira fica com a metade arredondada para cima); quebra explícita do
 * editor (`|`, `\n`) é respeitada.
 */
export function normalizeShortCoverHook(hook: string): string {
  const lines = hook.split(HOOK_LINE_BREAK_RE).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('gancho vazio — passe --hook "IA ladra?" (2 a 5 palavras, #12462)');
  const total = lines.reduce((acc, l) => acc + shortHookWords(l).length, 0);
  if (total < SHORT_HOOK_MIN_WORDS || total > SHORT_HOOK_MAX_WORDS) {
    throw new Error(
      `gancho da capa vertical ${JSON.stringify(hook)} tem ${total} palavra(s); a regra é ${SHORT_HOOK_MIN_WORDS} a ${SHORT_HOOK_MAX_WORDS} (#12462). ` +
        `A capa traz o gancho, não o título do D1`,
    );
  }
  let normalized = lines.join("|");
  if (lines.length === 1) {
    const words = lines[0].split(" ");
    if (shortHookWords(lines[0]).length > 3) {
      const cut = Math.ceil(words.length / 2);
      normalized = `${words.slice(0, cut).join(" ")}|${words.slice(cut).join(" ")}`;
    }
  }
  splitHook(normalized); // mesma validação de linhas do horizontal (até 2 linhas, até 4 por linha)
  return normalized;
}

/** Pure (#12462): painel escuro na base da capa vertical, atrás do gancho. */
export function buildShortCoverPanelSvg(panelTopRatio = SHORT_COVER_PANEL_TOP_RATIO, w = SHORT_COVER_W, h = SHORT_COVER_H): string {
  if (!(panelTopRatio > 0 && panelTopRatio < 1)) throw new Error(`--panel-top inválido: ${panelTopRatio} (fração da altura entre 0 e 1, ex.: 0.62)`);
  const y = Math.round(h * panelTopRatio);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="0" y="${y}" width="${w}" height="${h - y}" fill="${COLORS.ink}" fill-opacity="${SHORT_COVER_PANEL_OPACITY}"/>` +
    `</svg>`
  );
}

export interface ComposeShortCoverInput {
  /** Frame do vertical (JPEG/PNG), em qualquer tamanho 9:16. */
  frame: Buffer;
  hook: string;
  panelTopRatio?: number;
}

/**
 * Compõe a capa vertical do Short (#12462): o frame do vertical em 1080x1920
 * (recorte central se não for 9:16), painel escuro cobrindo a legenda
 * queimada e o gancho em Georgia bold cor papel, `?` em teal, centralizado
 * no painel. JPEG ≤ 2 MB.
 */
export async function composeShortCover(input: ComposeShortCoverInput): Promise<ComposeThumbResult> {
  const warnings: string[] = [];
  const hook = normalizeShortCoverHook(input.hook);
  const panelTopRatio = input.panelTopRatio ?? SHORT_COVER_PANEL_TOP_RATIO;
  const panel = buildShortCoverPanelSvg(panelTopRatio);
  const meta = await sharp(input.frame).metadata();
  if (!meta.width || !meta.height) throw new Error("frame ilegível (sem dimensões)");
  if (Math.abs(meta.width / meta.height - 9 / 16) > (9 / 16) * 0.02) {
    warnings.push(`frame ${meta.width}x${meta.height} não é 9:16 — recortado no centro`);
  }
  const base = await sharp(input.frame).rotate().resize(SHORT_COVER_W, SHORT_COVER_H, { fit: "cover", position: "centre" }).toBuffer();
  const hookLayer = await renderHookLayer(hook, SHORT_HOOK_MAX_WIDTH, "middle");
  const panelTop = Math.round(SHORT_COVER_H * panelTopRatio);
  const panelH = SHORT_COVER_H - panelTop;
  if (hookLayer.height > panelH - 80) {
    warnings.push(`gancho com ${hookLayer.height}px de altura quase não cabe no painel (${panelH}px) — encurte o gancho ou suba o painel (--panel-top)`);
  }
  const compose = (quality: number) =>
    sharp(base)
      .composite([
        { input: Buffer.from(panel), left: 0, top: 0 },
        {
          input: hookLayer.png,
          left: Math.max(0, Math.round((SHORT_COVER_W - hookLayer.width) / 2)),
          top: Math.max(panelTop, panelTop + Math.round((panelH - hookLayer.height) / 2)),
        },
      ])
      .flatten({ background: COLORS.ink })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  let jpeg = await compose(90);
  for (const q of [82, 74, 66]) {
    if (jpeg.length <= YOUTUBE_THUMB_MAX_BYTES) break;
    jpeg = await compose(q);
  }
  if (jpeg.length > YOUTUBE_THUMB_MAX_BYTES) {
    throw new Error(`capa vertical com ${jpeg.length} bytes passa do limite de 2 MB do YouTube mesmo em qualidade 66`);
  }
  return { jpeg, warnings };
}
