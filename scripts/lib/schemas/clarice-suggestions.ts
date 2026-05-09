/**
 * clarice-suggestions.ts — Schema Zod para _internal/02-clarice-suggestions.json
 *
 * Bug-driver histórico (#1012):
 *   Stage 2 mid-Clarice resume (humanização interrompida). Schema das
 *   sugestões varia se Clarice API mudar shape — silent skip de sugestões.
 *
 * Shape: array de { from, to, rule, explanation }
 */

import { z } from "zod";

export const ClariceSuggestionSchema = z.object({
  from: z.string(),
  to: z.string(),
  rule: z.string().optional(),
  explanation: z.string().optional(),
}).passthrough();

export type ClariceSuggestion = z.infer<typeof ClariceSuggestionSchema>;

export const ClariceSuggestionsSchema = z.array(ClariceSuggestionSchema);

export type ClariceSuggestions = z.infer<typeof ClariceSuggestionsSchema>;

/** Parse + valida 02-clarice-suggestions.json. */
export function parseClariceSuggestions(raw: unknown): ClariceSuggestions {
  return ClariceSuggestionsSchema.parse(raw);
}
