/**
 * eia-meta.ts — Schema Zod para 01-eia-meta.json (Stage 3 → Stage 4)
 *
 * Bug-driver histórico (#1012):
 *   Stage 3 (eia-composer) escreve metadata da imagem POTD do Wikimedia;
 *   Stage 4 (publish-monthly) lê pra registrar gabarito + montar crédito
 *   no email. Schema drift = crédito quebrado ou gabarito None.
 *
 * Sobre validações strict vs passthrough:
 *   - `ai_side: z.enum(["A", "B"])` é STRICT (fora de A/B = erro). Contrato fechado.
 *   - Campos opcionais usam passthrough no nível object (tolerante a extras).
 *   Mistura intencional: ai_side é crítico (gabarito do poll), outros campos
 *   são metadata em evolução.
 */

import { z } from "zod";

export const WikimediaInfoSchema = z.object({
  title: z.string(),
  image_url: z.string(),
  credit: z.string().optional(),
  // #1176: eia-compose.ts escreve `null` literal nestes 3 fields quando a API
  // Wikimedia não fornece o dado (ex: imagem POTD sem subject_wikipedia_url
  // ou artist_url resolvível). `.optional()` rejeita null — usar `.nullish()`
  // (aceita null OU undefined) pra schema bater com o JSON gerado.
  artist_url: z.string().nullish(),
  subject_wikipedia_url: z.string().nullish(),
  license_url: z.string().nullish(),
  // image_date_used nunca é null no JSON real (eia-compose sempre string) —
  // mantém .optional() pra evitar widening do type em consumers.
  image_date_used: z.string().optional(),
}).passthrough();


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
