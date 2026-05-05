/**
 * beehiiv.ts — Schemas Zod para responses da API Beehiiv (#632 Tier A)
 *
 * Bug-driver: #326 — refresh-past-editions usava `published_at` (string ISO)
 * mas API retorna `publish_date` (Unix seconds). Filtro incremental sempre
 * reportava 0 new posts (silent corruption).
 *
 * Estes schemas documentam o shape real da API v2 e fazem throw loud
 * se o campo crítico estiver ausente.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// list_posts endpoint (paginado)
// ---------------------------------------------------------------------------

export const BeehiivPostSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  /** Unix timestamp seconds — campo canônico da API v2. `published_at` ISO
   *  está deprecated; usar `beehiiv-timestamp.ts` pra extrair a data. */
  publish_date: z.number().nullable().optional(),
  /** Legacy ISO string — deprecated na API v2 mas pode aparecer em posts
   *  antigos. Nunca usar diretamente — usar extractPublishedDate() do lib. */
  published_at: z.string().nullable().optional(),
  web_url: z.string().optional(),
  subject: z.string().optional(),
  subtitle: z.string().optional(),
  authors: z.array(z.unknown()).optional(),
}).passthrough();

export type BeehiivPostSummary = z.infer<typeof BeehiivPostSummarySchema>;

export const ListPostsResponseSchema = z.object({
  data: z.array(BeehiivPostSummarySchema),
  page: z.number(),
  limit: z.number().optional(),
  total_results: z.number().optional(),
  total_pages: z.number().optional(),
}).passthrough();

export type ListPostsResponse = z.infer<typeof ListPostsResponseSchema>;

// ---------------------------------------------------------------------------
// get_post endpoint
// ---------------------------------------------------------------------------

export const BeehiivPostContentSchema = z.object({
  id: z.string(),
  status: z.string(),
  publish_date: z.number().nullable().optional(),
  published_at: z.string().nullable().optional(),
  web_url: z.string().optional(),
  subject: z.string().optional(),
  subtitle: z.string().optional(),
  /**
   * HTML content of the post. Required for newsletter rendering.
   * Bug-driver: #234 — get_post_content não expunha URLs como esperado;
   * links[] ficava vazio. Schema força verificar html direto.
   */
  html: z.string().optional(),
  free_web_content: z.string().optional(),
  free_email_content: z.string().optional(),
}).passthrough();

export type BeehiivPostContent = z.infer<typeof BeehiivPostContentSchema>;

/** Parse + valida list_posts response. Throws ZodError se shape inválido. */
export function parseListPostsResponse(raw: unknown): ListPostsResponse {
  return ListPostsResponseSchema.parse(raw);
}

/** Parse + valida get_post response. */
export function parseBeehiivPost(raw: unknown): BeehiivPostContent {
  return BeehiivPostContentSchema.parse(raw);
}
