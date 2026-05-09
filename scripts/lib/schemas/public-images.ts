/**
 * public-images.ts — Schema Zod para 06-public-images.json (Stage 4 cache)
 *
 * Bug-driver histórico (#1012):
 *   Cache de URLs públicas das imagens (Drive) consumido pelo LinkedIn payload
 *   e Make webhook. Schema drift = LinkedIn post sem imagem ou Make falha.
 *
 * Sobre `passthrough()`: os 4 campos por imagem (file_id, url, mime_type,
 * filename) são obrigatórios — Make/LinkedIn API quebram sem eles. Slots
 * (cover, d2, d3, eai_real, eai_ia) são record genérico pra suportar
 * combinações futuras sem refactor.
 */

import { z } from "zod";

export const PublicImageSchema = z.object({
  file_id: z.string(),
  url: z.string(),
  mime_type: z.string(),
  filename: z.string(),
}).passthrough();

export type PublicImage = z.infer<typeof PublicImageSchema>;

/** Map de slot → image. Slots conhecidos: cover, d2, d3, eai_real, eai_ia. */
export const PublicImagesSchema = z.object({
  images: z.record(z.string(), PublicImageSchema),
}).passthrough();

export type PublicImages = z.infer<typeof PublicImagesSchema>;

/** Parse + valida 06-public-images.json. */
export function parsePublicImages(raw: unknown): PublicImages {
  return PublicImagesSchema.parse(raw);
}
