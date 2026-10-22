/**
 * scripts/lib/diaria/youtube-thumb.ts (#10800)
 *
 * Miolo da capa do YouTube no padrão diar.ia.br — a parte DETERMINÍSTICA do
 * processo aprovado pelo editor em 22/10/2026 (comentários do #10800):
 *
 *   Horizontal (`04-youtube-thumb.jpg`, 1280x720):
 *     1. retrato do editor gerado por IA a partir de 2 frames do vídeo do dia
 *        (Codex CLI) e recortado com `rembg`/`birefnet-portrait`  → INSUMO,
 *        fora daqui (passo com IA, conduzido pela skill `/diaria-youtube`);
 *     2. fundo = outpaint 16:9 da `04-d1-2x1.jpg` em pintura impasto nítida
 *        → INSUMO, fora daqui (sem outpaint, cai na própria 2:1 com recorte
 *        central e um aviso);
 *     3. composição — ESTE módulo: fundo 1280x720 sem desfoque, gradiente
 *        escuro embaixo, retrato à esquerda colado na base, gancho de 2 ou 3
 *        palavras em Georgia bold cor papel no canto inferior direito, com o
 *        `?` final em teal.
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
/** Distância entre a base da caixa do texto e a borda de baixo. */
const HOOK_BOTTOM_MARGIN = 40;
/** O gancho nunca invade o terço esquerdo inteiro (é do retrato). */
const HOOK_MAX_WIDTH = 800;
const HOOK_MAX_FONT = 130;
const HOOK_MIN_FONT = 64;
/** Largura média por caractere do Georgia bold, em em (conservador). */
const GEORGIA_BOLD_CHAR_EM = 0.56;
/** Retrato ocupa até 94% da altura e até metade da largura. */
const PORTRAIT_MAX_H_RATIO = 0.94;
const PORTRAIT_MAX_W_RATIO = 0.5;
/** Gradiente escuro embaixo: começa em 55% da altura. */
const GRADIENT_START_RATIO = 0.55;
const GRADIENT_MAX_OPACITY = 0.78;

export interface HookParts {
  /** Texto em cor papel (sem o `?` final). */
  body: string;
  /** `?` final em teal, ou "" quando o gancho não termina em pergunta. */
  mark: string;
}

/**
 * Valida o gancho (2 ou 3 palavras, decisão do editor) e separa o `?` final,
 * que vai em teal. Lança com mensagem acionável fora da regra.
 */
export function splitHook(hook: string): HookParts {
  const clean = hook.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("gancho vazio — passe --hook \"IA ladra?\" (2 ou 3 palavras)");
  const words = clean.replace(/[?!.…]+$/u, "").split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 3) {
    throw new Error(`gancho ${JSON.stringify(clean)} tem ${words.length} palavra(s); a regra é 2 ou 3 (ex.: "IA antiveneno?")`);
  }
  if (clean.endsWith("?")) return { body: clean.slice(0, -1).trimEnd(), mark: "?" };
  return { body: clean, mark: "" };
}

/** Tamanho do gancho: o maior que cabe em HOOK_MAX_WIDTH, entre 64 e 130 px. */
export function hookFontSize(hook: HookParts): number {
  const chars = Array.from(hook.body + hook.mark).length;
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

/** Camada do gradiente escuro (fica ATRÁS do retrato, pra não apagá-lo). */
export function buildGradientSvg(w = YOUTUBE_THUMB_W, h = YOUTUBE_THUMB_H): string {
  const y0 = Math.round(h * GRADIENT_START_RATIO);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="${GRADIENT_MAX_OPACITY}"/>` +
    `</linearGradient></defs>` +
    `<rect x="0" y="${y0}" width="${w}" height="${h - y0}" fill="url(#g)"/>` +
    `</svg>`
  );
}

/**
 * Camada do gancho, isolada: Georgia bold cor papel, `?` em teal. O
 * posicionamento no canto inferior direito é feito depois, a partir da caixa
 * REAL do texto rasterizado (`trim`), e não por `text-anchor="end"`: assim a
 * largura máxima vale mesmo quando a fonte efetiva tem métrica diferente da
 * estimada em `hookFontSize` (fallback sem Georgia sai bem mais largo).
 */
export function buildHookSvg(hook: string): string {
  const parts = splitHook(hook);
  const size = hookFontSize(parts);
  const chars = Array.from(parts.body + parts.mark).length;
  // Canvas folgado: o texto real é recortado por `trim` na composição.
  const w = Math.ceil(chars * size * 0.9) + 2 * size;
  const h = Math.ceil(size * 1.6);
  const mark = parts.mark ? `<tspan fill="${COLORS.brand}">${escapeXml(parts.mark)}</tspan>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<text x="${size}" y="${Math.round(size * 1.2)}" font-family="${escapeXml(FONTS.serif)}" ` +
    `font-weight="700" font-size="${size}" fill="${COLORS.onInk}">` +
    `${escapeXml(parts.body)}${mark}</text>` +
    `</svg>`
  );
}

/** Rasteriza o gancho, recorta a caixa real e encolhe se passar da largura máxima. */
async function renderHookLayer(hook: string): Promise<{ png: Buffer; width: number; height: number }> {
  let png = await sharp(Buffer.from(buildHookSvg(hook))).png().trim().toBuffer();
  let meta = await sharp(png).metadata();
  if ((meta.width ?? 0) > HOOK_MAX_WIDTH) {
    png = await sharp(png).resize({ width: HOOK_MAX_WIDTH }).png().toBuffer();
    meta = await sharp(png).metadata();
  }
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 };
}

export interface ComposeThumbInput {
  /** Fundo: idealmente o outpaint 16:9 da `04-d1-2x1.jpg`. */
  background: Buffer;
  /** Retrato recortado (PNG com transparência — só a pessoa, sem fundo). */
  portrait: Buffer;
  hook: string;
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
  const trimmed = await sharp(input.portrait).rotate().trim().png().toBuffer();
  const portrait = await sharp(trimmed)
    .resize(Math.round(W * PORTRAIT_MAX_W_RATIO), Math.round(H * PORTRAIT_MAX_H_RATIO), { fit: "inside" })
    .png()
    .toBuffer();
  const ph = (await sharp(portrait).metadata()).height ?? 0;
  const hookLayer = await renderHookLayer(input.hook);

  const compose = (quality: number) =>
    sharp(background)
      .composite([
        { input: Buffer.from(buildGradientSvg(W, H)), left: 0, top: 0 },
        { input: portrait, left: 0, top: H - ph },
        {
          input: hookLayer.png,
          left: W - HOOK_RIGHT_MARGIN - hookLayer.width,
          top: H - HOOK_BOTTOM_MARGIN - hookLayer.height,
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
