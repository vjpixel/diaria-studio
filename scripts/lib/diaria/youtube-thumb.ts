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
 *   Short (capa vertical): um frame do próprio vídeo vertical dentro da janela
 *   do lettering do título (~3,5 s iniciais) — `ffmpeg -ss {t}`; aqui só os
 *   argumentos e a checagem da janela.
 *
 * Referências aprovadas: `data/editions/2610/261021/04-youtube-thumb.jpg` e
 * `data/editions/2610/261022/04-youtube-thumb.jpg`.
 */

import sharp from "sharp";
import { COLORS, FONTS } from "../shared/design-tokens.ts";

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
  return s.replace(/[?!.…]+$/u, "").split(" ").filter(Boolean);
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
export function buildGradientSvg(w = YOUTUBE_THUMB_W, h = YOUTUBE_THUMB_H): string {
  const y1 = Math.round(h * GRADIENT_END_RATIO);
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
 * Camada do gancho, isolada: Georgia bold cor papel, `?` em teal. O
 * posicionamento no canto superior direito é feito depois, a partir da caixa
 * REAL do texto rasterizado (`trim`), e não por `text-anchor="end"`: assim a
 * largura máxima vale mesmo quando a fonte efetiva tem métrica diferente da
 * estimada em `hookFontSize` (fallback sem Georgia sai bem mais largo).
 */
export function buildHookSvg(hook: string): string {
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
  // pela caixa real, como na linha única.
  const chars = Math.max(...hookDrawnLines(parts).map((l) => Array.from(l).length));
  const lineHeight = Math.round(size * HOOK_LINE_HEIGHT_EM);
  const w = Math.ceil(chars * size * 0.9) + 2 * size;
  const h = Math.ceil(size * 1.6) + lineHeight * (parts.lines.length - 1);
  const xEnd = w - size;
  const rows = parts.lines.map((line, i) => {
    const isLast = i === parts.lines!.length - 1;
    const y = Math.round(size * 1.2) + i * lineHeight;
    return `<text x="${xEnd}" y="${y}" text-anchor="end" ${textAttrs}>${escapeXml(line)}${isLast ? mark : ""}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${rows.join("")}</svg>`;
}

/**
 * Rasteriza o gancho, recorta a caixa real e encolhe se passar de `maxWidth`
 * (encolher a camada rasterizada equivale a reduzir a fonte).
 */
async function renderHookLayer(hook: string, maxWidth = HOOK_MAX_WIDTH): Promise<{ png: Buffer; width: number; height: number }> {
  let png = await sharp(Buffer.from(buildHookSvg(hook))).png().trim().toBuffer();
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
  if (!isSixteenByNine(bgMeta.width, bgMeta.height)) {
    warnings.push(
      `fundo ${bgMeta.width}x${bgMeta.height} não é 16:9 — recortado no centro; o processo aprovado usa o outpaint 16:9 da 04-d1-2x1.jpg com o objeto do D1 menor e inteiro à direita`,
    );
  }

  const ptMeta = await sharp(input.portrait).metadata();
  if (!ptMeta.hasAlpha) {
    throw new Error("retrato sem transparência — recorte antes com rembg (modelo birefnet-portrait): só a pessoa, sem fundo");
  }

  // Fundo: cover, sem desfoque (regra do editor: "nunca desfoque").
  const background = await sharp(input.background)
    .rotate()
    .resize(W, H, { fit: "cover", position: "centre" })
    .toBuffer();

  // Retrato: apara a transparência em volta, cabe em 50% x 94%, colado à esquerda e na base.
  const source = input.enhancePortrait ? await enhancePortrait(input.portrait) : input.portrait;
  const trimmed = await sharp(source).rotate().trim().png().toBuffer();
  const portrait = await sharp(trimmed)
    .resize(Math.round(W * PORTRAIT_MAX_W_RATIO), Math.round(H * PORTRAIT_MAX_H_RATIO), { fit: "inside" })
    .png()
    .toBuffer();
  const ph = (await sharp(portrait).metadata()).height ?? 0;
  let hookLayer = await renderHookLayer(input.hook);

  // #11228: com o gancho no topo, ele não pode invadir a cabeça do retrato.
  // Mede a parte opaca do retrato nas linhas do gancho e encolhe o gancho
  // (equivale a reduzir a fonte) até caber ao lado, com folga.
  const portraitRaw = await sharp(portrait).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rightEdge = portraitRightEdgeInRows(
    { data: portraitRaw.data, width: portraitRaw.info.width, height: portraitRaw.info.height, channels: portraitRaw.info.channels },
    H - ph,
    HOOK_TOP_MARGIN,
    HOOK_TOP_MARGIN + hookLayer.height,
  );
  const available = hookWidthBeside(rightEdge, W);
  if (hookLayer.width > available) {
    if (available < HOOK_MIN_WIDTH) {
      warnings.push(
        `gancho encostaria no retrato (só ${available}px livres ao lado da cabeça) — reduzido ao mínimo de ${HOOK_MIN_WIDTH}px e pode sobrepor; encurte o gancho ou use um retrato mais baixo`,
      );
    }
    hookLayer = await renderHookLayer(input.hook, Math.max(HOOK_MIN_WIDTH, available));
  }

  const compose = (quality: number) =>
    sharp(background)
      .composite([
        { input: Buffer.from(buildGradientSvg(W, H)), left: 0, top: 0 },
        { input: portrait, left: 0, top: H - ph },
        {
          input: hookLayer.png,
          left: W - HOOK_RIGHT_MARGIN - hookLayer.width,
          top: HOOK_TOP_MARGIN,
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
 * Argumentos do `ffmpeg` para extrair a capa do Short: um frame do próprio
 * vertical em `atSeconds`. Fora da janela do lettering do título vira aviso
 * (a capa aprovada mostra o título do D1 em Georgia no topo).
 */
export function planShortCoverFrame(video: string, atSeconds: number, out: string): ShortCoverPlan {
  if (!Number.isFinite(atSeconds) || atSeconds < 0) {
    throw new Error(`--at inválido: ${atSeconds} (segundos, ex.: 1.8)`);
  }
  const warnings: string[] = [];
  if (atSeconds > SHORT_COVER_LETTERING_WINDOW_S) {
    warnings.push(
      `frame aos ${atSeconds}s está fora da janela do lettering do título (0–${SHORT_COVER_LETTERING_WINDOW_S}s) — a capa sairia sem o título do D1`,
    );
  }
  return {
    args: ["-hide_banner", "-loglevel", "error", "-ss", String(atSeconds), "-i", video, "-frames:v", "1", "-q:v", "2", "-y", out],
    warnings,
  };
}
