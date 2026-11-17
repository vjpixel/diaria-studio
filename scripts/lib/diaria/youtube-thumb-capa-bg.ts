/**
 * scripts/lib/diaria/youtube-thumb-capa-bg.ts (#13235)
 *
 * Prompt do FUNDO DE CAPA da "fórmula Van Gogh" (benchmark da #13217,
 * `docs/youtube-capa-visual.md`), para o período de teste da #13192: fundo
 * pintado escuro com um único objeto iluminado, o lado do retrato livre, sem
 * pessoas, sem texto, sem Noite Estrelada. Pure: só monta o JSON do
 * `codex-image.js`; quem gera é o comando que o CLI imprime
 * (`gen-youtube-thumb.ts --background-prompt-capa --scene "..."`), e o
 * resultado entra na capa com `--background`.
 *
 * O padrão (outpaint 16:9 da `04-d1-2x1.jpg`) não muda.
 */

import type { PortraitSide } from "./youtube-thumb-portrait.ts";

/** Pasta do prompt e do fundo de capa gerado (ao lado das de frames/retratos). */
export const THUMB_CAPA_BG_DIR = "_internal/youtube-thumb-capa-bg";
export const THUMB_CAPA_BG_PROMPT = "prompt-capa.json";
export const THUMB_CAPA_BG_OUT = "fundo-capa.jpg";
/** 16:9, do tamanho que o encaixe da capa (1280x720) reduz sem perda. */
export const CAPA_BG_W = 1920;
export const CAPA_BG_H = 1080;
/** A cena é UM objeto: descrição curta, para o Codex não povoar o quadro. */
export const CAPA_SCENE_MAX_CHARS = 200;

export interface CapaBackgroundPrompt {
  positive: string;
  negative: string;
  final_width: number;
  final_height: number;
}

/** Valida a `--scene` (o objeto iluminado). Lança com mensagem acionável. */
export function parseCapaScene(raw: string | undefined): string {
  const scene = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!scene) throw new Error('--background-prompt-capa exige --scene "..." (o objeto iluminado, ex.: "um cadeado aberto de metal")');
  if (scene.length > CAPA_SCENE_MAX_CHARS) {
    throw new Error(`--scene com ${scene.length} caracteres; o máximo é ${CAPA_SCENE_MAX_CHARS} (um objeto só, descrito curto)`);
  }
  return scene;
}

/**
 * Pure (#13235): JSON do `codex-image.js` para o fundo de capa. `portraitSide`
 * é o lado da capa em que o retrato entra (o `--layout` decide: `right` =
 * retrato à direita); esse lado fica livre e escuro, e o objeto vai no outro.
 */
export function buildCapaBackgroundPrompt(scene: string, portraitSide: PortraitSide = "left"): CapaBackgroundPrompt {
  const objectSide = portraitSide === "left" ? "right" : "left";
  return {
    positive:
      "Painting in the style of Vincent van Gogh, thick impasto brushstrokes, for a YouTube thumbnail background. " +
      `A single object, lit by a strong warm light: ${scene}. ` +
      `The object sits in the ${objectSide} half of the frame, entirely visible, medium size. ` +
      `The ${portraitSide} half of the frame is empty, a calm and very dark background with no objects (a portrait will be placed there). ` +
      "Very dark background overall, deep blues and near-black, with the light concentrated on the object. Simple composition, one object only.",
    negative:
      "people, person, face, hands, crowd, text, letters, words, numbers, logo, watermark, signature, frame, border, " +
      "The Starry Night, swirling starry sky, stars, many objects, busy background, bright background",
    final_width: CAPA_BG_W,
    final_height: CAPA_BG_H,
  };
}
