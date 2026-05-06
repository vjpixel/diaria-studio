/**
 * image-generate.ts — Schemas Zod para SD prompts e outputs (#649 Tier B)
 *
 * Bug-driver: prompt JSON gravado em `04-d{N}-sd-prompt.json` é input do
 * gemini-image.js / cloudflare-image.js / comfyui-run.js. Se o shape
 * estiver errado (ex: positive ausente, dimensões fora do range), o
 * backend falha silenciosamente ou gera imagem off-spec sem warning.
 *
 * Estes schemas validam o prompt antes de gravar e o output (path do JPG)
 * antes de retornar.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// SD prompt JSON (input para os scripts de geração)
// ---------------------------------------------------------------------------

export const SdPromptSchema = z.object({
  /** Texto positivo descrevendo a cena + estilo Van Gogh impasto. */
  positive: z.string().min(20, "positive prompt deve ter ≥20 chars"),
  /** Texto negativo (artefatos a evitar). */
  negative: z.string().min(10, "negative prompt deve ter ≥10 chars"),
  /**
   * Dimensões finais da imagem. Diar.ia usa 1600×800 (D1 wide 2:1) ou
   * 1024×1024 (D2/D3 nativo Gemini). Outros valores indicam config errada.
   */
  final_width: z.number().int().min(256, "min 256px").max(4096),
  final_height: z.number().int().min(256, "min 256px").max(4096),
}).passthrough();

export type SdPrompt = z.infer<typeof SdPromptSchema>;

// ---------------------------------------------------------------------------
// Output (path + dims)
// ---------------------------------------------------------------------------

export const ImageOutputSchema = z.object({
  /** Path absoluto ou relativo ao ROOT. Sufixo .jpg/.jpeg/.png. */
  path: z.string().refine(
    (p) => /\.(jpe?g|png)$/i.test(p),
    { message: "output path deve terminar em .jpg/.jpeg/.png" },
  ),
  format: z.enum(["jpg", "png"]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).passthrough();

export type ImageOutput = z.infer<typeof ImageOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valida SD prompt antes de gravar em disco. Throws ZodError se inválido. */
export function parseSdPrompt(raw: unknown): SdPrompt {
  return SdPromptSchema.parse(raw);
}

/** Valida output da geração antes de retornar path para o caller. */
export function parseImageOutput(raw: unknown): ImageOutput {
  return ImageOutputSchema.parse(raw);
}
