/**
 * scripts/lib/diaria/youtube-thumb-portrait.ts (#11942)
 *
 * Retrato da capa horizontal no padrão da 261021 ("IA ladra?"), que o editor
 * apontou em 03/11/2026 como a melhor capa até agora: "minha imagem deve ser
 * só uma referência. pode editar minha expressão."
 *
 * Em vez de recortar o frame do vídeo (corpo inteiro, mãos à vista, a
 * expressão que calhou no frame), o Codex gera um CLOSE-UP fotorrealista do
 * editor (cabeça e ombros) com o frame escolhido como referência de
 * identidade, e a expressão pedida no prompt para combinar com o gancho (na
 * 261021, desconfiada, olhando de lado). A regra "a única imagem realista é o
 * editor" segue valendo; o fundo continua impasto.
 *
 * Partes determinísticas (este módulo, sem rede e sem Codex):
 *   - `PORTRAIT_EXPRESSIONS` — as expressões disponíveis (chave em português,
 *     descrição em inglês para o prompt);
 *   - `parseExpressions` — valida o `--expressions a,b,c`;
 *   - `buildPortraitPrompt` — o JSON do `codex-image.js` (com
 *     `reference_mode: "identity"` e o frame em `reference_images`);
 *   - nomes dos arquivos da folha de opções de expressão.
 *
 * O CLI é `scripts/gen-youtube-thumb.ts --portrait-prompts | --portrait-sheet
 * | --pick-portrait N`; a geração em si é `node scripts/codex-image.js` (um por
 * opção), conduzida pela skill `/diaria-publica-video` (Passo A2). A escolha da
 * opção é sempre do editor.
 */

/** Pasta das opções de retrato (ao lado da dos frames, #11228). */
export const THUMB_PORTRAITS_DIR = "_internal/youtube-thumb-portraits";
export const THUMB_PORTRAITS_SHEET = "opcoes.jpg";
export const THUMB_PORTRAIT_PICKED = "escolhido.jpg";
/** Ordem das expressões das opções geradas (lida por `--portrait-sheet`). */
export const THUMB_PORTRAITS_META = "retratos.json";

export function portraitPromptFileName(n: number): string {
  return `prompt-${n}.json`;
}

/** Saída do `codex-image.js` para a opção N (JPEG, ainda com fundo). */
export function portraitOptionFileName(n: number): string {
  return `retrato-${n}.jpg`;
}

/**
 * Expressões disponíveis. A da 261021 é `desconfiado`. A descrição vai em
 * inglês porque o prompt do Codex é em inglês. Desde o #12123 a descrição não
 * diz para onde o editor olha: a direção do olhar sai do lado em que o
 * retrato entra na capa (`gazeSentence`), sempre para a cena do D1.
 */
export const PORTRAIT_EXPRESSIONS = {
  desconfiado: "suspicious and skeptical: a sideways glance, brows slightly lowered, mouth closed, lips pressed",
  surpreso: "surprised: eyebrows raised, eyes wide open, mouth slightly open",
  preocupado: "worried: brows drawn together, mouth closed and tense",
  serio: "serious and focused: neutral mouth closed",
  ironico: "ironic: a slight half smile on one side, one eyebrow raised",
  intrigado: "intrigued: head tilted slightly, one eyebrow raised, eyes narrowed",
} as const;

/** Lado da capa em que o retrato entra (#12123): `left` nos layouts `bottom`/`top`, `right` no `right`. */
export type PortraitSide = "left" | "right";
export const PORTRAIT_SIDES: readonly PortraitSide[] = ["left", "right"];

/**
 * Frase do olhar (#12123): o retrato olha para a cena, que fica no lado
 * oposto ao dele. Retrato à esquerda → olha para a direita do quadro.
 */
export function gazeSentence(side: PortraitSide): string {
  const scene = side === "left" ? "right" : "left";
  return (
    `Gaze: the portrait goes on the ${side} side of the thumbnail and the scene is on the ${scene} side, ` +
    `so head, shoulders and eyes turn toward the ${scene} of the frame, looking at the scene, not at the camera.`
  );
}

export type PortraitExpression = keyof typeof PORTRAIT_EXPRESSIONS;

/** Opções da folha por padrão: a da 261021 primeiro, e duas alternativas. */
export const DEFAULT_PORTRAIT_EXPRESSIONS: readonly PortraitExpression[] = ["desconfiado", "surpreso", "preocupado"];
/** A folha tem de 1 a 4 opções (a issue pede 2 ou 3; 1 = refazer só uma). */
export const MAX_PORTRAIT_OPTIONS = 4;

/** Valida `--expressions a,b,c`; ausente → `DEFAULT_PORTRAIT_EXPRESSIONS`. */
export function parseExpressions(raw: string | undefined): PortraitExpression[] {
  if (raw === undefined) return [...DEFAULT_PORTRAIT_EXPRESSIONS];
  const keys = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = Object.keys(PORTRAIT_EXPRESSIONS);
  if (keys.length === 0) throw new Error(`--expressions vazio: use uma ou mais de ${valid.join(", ")}`);
  if (keys.length > MAX_PORTRAIT_OPTIONS) {
    throw new Error(`--expressions tem ${keys.length} opções; o máximo é ${MAX_PORTRAIT_OPTIONS}`);
  }
  for (const k of keys) {
    if (!valid.includes(k)) throw new Error(`expressão ${JSON.stringify(k)} desconhecida: use ${valid.join(", ")}`);
  }
  if (new Set(keys).size !== keys.length) throw new Error(`--expressions repete opção: ${keys.join(",")}`);
  return keys as PortraitExpression[];
}

/** Formato do retrato gerado: 4:5 vertical, para o close-up de cabeça e ombros. */
export const PORTRAIT_FINAL_W = 1080;
export const PORTRAIT_FINAL_H = 1350;

export interface PortraitPrompt {
  positive: string;
  negative: string;
  final_width: number;
  final_height: number;
  reference_images: string[];
  reference_mode: "identity";
}

/**
 * JSON do `codex-image.js` para uma opção de retrato. `referenceFrame` deve
 * ser caminho absoluto (o Codex roda com outro cwd; `buildCodexArgs` resolve,
 * mas o JSON gravado fica legível de qualquer lugar).
 */
export function buildPortraitPrompt(expression: PortraitExpression, referenceFrame: string, side: PortraitSide = "left"): PortraitPrompt {
  const face = PORTRAIT_EXPRESSIONS[expression];
  return {
    positive:
      "Photorealistic close-up portrait photo of the same man shown in the reference image, for a YouTube thumbnail. " +
      // #12123: o recorte do rembg cortava o ombro na borda; ombros e braços inteiros, com margem dos dois lados.
      "Framing: head, both shoulders and the upper arms entirely inside the frame, with empty background margin on both the left and the right side " +
      "(no shoulder or arm cut by the image edge), face large and sharp, a little space above the hair. " +
      `${gazeSentence(side)} ` +
      `Facial expression: ${face}. ` +
      "Same identity, hair, beard and clothing as the reference. " +
      "Plain dark, softly lit studio background with nothing in it (it will be cut out). " +
      "Soft dramatic key light from the left, high detail skin texture, shallow depth of field, natural colors.",
    negative:
      "painting, illustration, drawing, cartoon, 3D render, text, letters, logo, watermark, hands, fingers, microphone, mug, objects, other people, busy background, frame, border, " +
      "cropped shoulder, arm cut off by the image edge, looking at the camera",
    final_width: PORTRAIT_FINAL_W,
    final_height: PORTRAIT_FINAL_H,
    reference_images: [referenceFrame],
    reference_mode: "identity",
  };
}

export interface PortraitsMeta {
  /** Frame usado como referência (caminho absoluto). */
  reference: string;
  /** Expressão de cada opção, na ordem: `expressions[0]` = opção 1. */
  expressions: PortraitExpression[];
  /** Lado da capa em que o retrato entra (#12123); ausente em rodadas anteriores = `left`. */
  side?: PortraitSide;
}
