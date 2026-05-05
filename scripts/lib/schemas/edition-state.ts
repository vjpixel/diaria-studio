/**
 * edition-state.ts — Schemas Zod para estado interno da edição (#632 Tier A)
 *
 * Cobre 01-categorized.json, 01-approved.json e artigos intermediários.
 *
 * Bug-drivers históricos:
 *   #229 — highlights flat vs nested (url direto vs article.url nested)
 *   #482 — title: "(inbox)" dedup — schema define sentinel explicitamente
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Artigo base
// ---------------------------------------------------------------------------

export const ArticleSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  summary: z.string().nullable().optional(),
  published_at: z.string().optional(),
  date: z.string().optional(),
  score: z.number().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  flag: z.string().optional(),
  date_unverified: z.boolean().optional(),
  editor_submitted: z.boolean().optional(),
  discovered_source: z.boolean().optional(),
  launch_candidate: z.boolean().optional(),
  suggested_primary_domain: z.string().optional(),
}).passthrough();

export type Article = z.infer<typeof ArticleSchema>;

// ---------------------------------------------------------------------------
// Highlight — suporta flat shape (url direto) e nested (article.url)  #229
// ---------------------------------------------------------------------------

const HighlightFlatSchema = ArticleSchema.extend({
  rank: z.number().optional(),
  reason: z.string().optional(),
});

const HighlightNestedSchema = z.object({
  rank: z.number(),
  score: z.number().optional(),
  bucket: z.string().optional(),
  reason: z.string().optional(),
  url: z.string().url().optional(),
  article: ArticleSchema.optional(),
}).passthrough();

export const HighlightSchema = z.union([HighlightFlatSchema, HighlightNestedSchema]);
export type Highlight = z.infer<typeof HighlightSchema>;

// ---------------------------------------------------------------------------
// 01-categorized.json
// ---------------------------------------------------------------------------

export const CategorizedJsonSchema = z.object({
  highlights: z.array(HighlightSchema).optional(),
  runners_up: z.array(HighlightSchema).optional(),
  lancamento: z.array(ArticleSchema),
  pesquisa: z.array(ArticleSchema),
  noticias: z.array(ArticleSchema),
  tutorial: z.array(ArticleSchema).optional(),
  video: z.array(ArticleSchema).optional(),
  total_considered: z.number().optional(),
  clusters: z.unknown().optional(),
});

export type CategorizedJson = z.infer<typeof CategorizedJsonSchema>;

// ---------------------------------------------------------------------------
// 01-approved.json — saída do apply-gate-edits.ts
// ---------------------------------------------------------------------------

export const ApprovedJsonSchema = z.object({
  highlights: z.array(HighlightSchema).min(1).max(3),
  runners_up: z.array(HighlightSchema).optional(),
  lancamento: z.array(ArticleSchema),
  pesquisa: z.array(ArticleSchema),
  noticias: z.array(ArticleSchema),
  tutorial: z.array(ArticleSchema).optional(),
  video: z.array(ArticleSchema).optional(),
  coverage: z.object({
    editor_submitted: z.number().optional(),
    diaria_discovered: z.number().optional(),
    selected: z.number().optional(),
    line: z.string().optional(),
  }).optional(),
}).passthrough();

export type ApprovedJson = z.infer<typeof ApprovedJsonSchema>;

/** Parse + valida 01-approved.json. Throws ZodError com mensagem descritiva se shape errado. */
export function parseApprovedJson(raw: unknown): ApprovedJson {
  return ApprovedJsonSchema.parse(raw);
}

/** Parse + valida 01-categorized.json. */
export function parseCategorizedJson(raw: unknown): CategorizedJson {
  return CategorizedJsonSchema.parse(raw);
}
