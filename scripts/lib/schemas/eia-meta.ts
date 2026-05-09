/**
 * eia-meta.ts — Schema Zod para 01-eia-meta.json (Stage 3 → Stage 4)
 *
 * Bug-driver histórico (#1012):
 *   Stage 3 (eia-composer) escreve metadata da imagem POTD do Wikimedia;
 *   Stage 4 (publish-monthly) lê pra registrar gabarito + montar crédito
 *   no email. Schema drift = crédito quebrado ou gabarito None.
 */

import { z } from "zod";

export const WikimediaInfoSchema = z.object({
  title: z.string(),
  image_url: z.string(),
  credit: z.string().optional(),
  artist_url: z.string().optional(),
  subject_wikipedia_url: z.string().optional(),
  license_url: z.string().optional(),
  image_date_used: z.string().optional(),
}).passthrough();

export type WikimediaInfo = z.infer<typeof WikimediaInfoSchema>;

export const EiaMetaSchema = z.object({
  edition: z.string(),
  composed_at: z.string(),
  ai_image_file: z.string(),
  real_image_file: z.string(),
  ai_side: z.enum(["A", "B"]),
  wikimedia: WikimediaInfoSchema,
}).passthrough();

export type EiaMeta = z.infer<typeof EiaMetaSchema>;

/** Parse + valida 01-eia-meta.json. */
export function parseEiaMeta(raw: unknown): EiaMeta {
  return EiaMetaSchema.parse(raw);
}
