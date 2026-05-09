/**
 * approved.ts — Schema Zod para 01-approved.json (Stage 1 → Stage 2)
 *
 * Bug-driver histórico (#1012):
 *   Schema drift entre `categorize` (escritor) e `writer` (leitor) gera
 *   campos inesperados ou faltando em produção.
 *
 * Shape: { highlights: [], runners_up: [], ... }
 *
 * Sobre `passthrough()`: tolera campos extras (não quebra quando categorize
 * adiciona novo field). Pega o caso "campo OBRIGATÓRIO faltando" — não pega
 * "field renomeado, leitor lê o nome antigo undefined". Trade-off escolhido
 * pra schemas internos em evolução (vs strict() que aumenta fricção).
 */

import { z } from "zod";

export const ArticleSchema = z.object({
  url: z.string(),
  title: z.string(),
  published_at: z.string().optional(),
  summary: z.string().optional(),
  author: z.string().nullable().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  score: z.number().optional(),
  verify_verdict: z.string().optional(),
  verify_note: z.string().optional(),
  date_unverified: z.boolean().optional(),
  type_hint: z.string().optional(),
}).passthrough(); // tolerante a campos extras (categorize evolui mais que writer)

export type Article = z.infer<typeof ArticleSchema>;

export const HighlightSchema = z.object({
  rank: z.number(),
  score: z.number(),
  bucket: z.string().optional(),
  reason: z.string().optional(),
  url: z.string().optional(),
  article: ArticleSchema,
}).passthrough();

export type Highlight = z.infer<typeof HighlightSchema>;

export const ApprovedSchema = z.object({
  highlights: z.array(HighlightSchema),
  runners_up: z.array(HighlightSchema).optional(),
}).passthrough();

export type Approved = z.infer<typeof ApprovedSchema>;

/** Parse + valida 01-approved.json. Lança ZodError em caso de schema drift. */
export function parseApproved(raw: unknown): Approved {
  return ApprovedSchema.parse(raw);
}
