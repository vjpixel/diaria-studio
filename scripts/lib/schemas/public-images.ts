/**
 * public-images.ts — Schema Zod para 06-public-images.json (Stage 4 cache)
 *
 * Bug-driver histórico (#1012):
 *   Cache de URLs públicas das imagens (Drive) consumido pelo LinkedIn payload
 *   e Make webhook. Schema drift = LinkedIn post sem imagem ou Make falha.
 *
 * #1119: campo `target` ("drive" | "cloudflare") opcional adicionado.
 * #1132 P2.5: `parsePublicImages` agora retorna erro com path descritivo
 * em vez de stack trace genérico do ZodError.
 *
 * Sobre `passthrough()`: os 4 campos por imagem (file_id, url, mime_type,
 * filename) são obrigatórios — Make/LinkedIn API quebram sem eles. Slots
 * (cover, d2, d3, eai_real, eai_ia, d1) são record genérico pra suportar
 * combinações futuras sem refactor.
 */

import { z } from "zod";

export const ImageTargetSchema = z.enum(["drive", "cloudflare"]);
// Tipo inferido disponível inline via `z.infer<typeof ImageTargetSchema>` se precisar.

export const PublicImageSchema = z.object({
  file_id: z.string().min(1, "file_id obrigatório"),
  url: z.string().min(1, "url obrigatória"),
  mime_type: z.string(),
  filename: z.string(),
  target: ImageTargetSchema.optional(), // #1119 — default drive pra back-compat
}).passthrough();


/** Map de slot → image. Slots conhecidos: cover, d1, d2, d3, eia_a, eia_b. */
export const PublicImagesSchema = z.object({
  images: z.record(z.string(), PublicImageSchema),
}).passthrough();

export type PublicImages = z.infer<typeof PublicImagesSchema>;

/**
 * Parse + valida 06-public-images.json. Lança Error com path descritivo
 * quando schema falha (em vez de ZodError stack — facilita debug).
 */
export function parsePublicImages(raw: unknown): PublicImages {
  const result = PublicImagesSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`06-public-images.json schema inválido: ${issues}`);
  }
  return result.data;
}
