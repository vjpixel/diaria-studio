/**
 * social-published.ts — Schema Zod para 06-social-published.json (#632 Tier A)
 *
 * Bug-drivers históricos:
 *   #601 — status: "draft" fabricado sem post real (LinkedIn)
 *   #600 — is_published deprecated em Graph API v25.0
 *
 * Schema documenta os shapes válidos de status para cada plataforma
 * e os campos obrigatórios para validação pós-publish.
 */

import { z } from "zod";

export const PostStatusSchema = z.enum(["draft", "scheduled", "failed", "published", "pending_manual"]);

export const PostEntrySchema = z.object({
  platform: z.enum(["linkedin", "facebook"]),
  destaque: z.enum(["d1", "d2", "d3"]),
  url: z.string().nullable(),
  status: PostStatusSchema,
  scheduled_at: z.string().nullable().optional(),
  published_at: z.string().optional(),
  failure_reason: z.string().optional(),
  fb_post_id: z.string().optional(),
  requires_manual_image_upload: z.boolean().optional(),
  // #886 LinkedIn route observability — qual canal de fire foi usado.
  // No failed path, é o route originalmente intentado, não tentativas subsequentes.
  route: z.enum(["worker_queue", "make_now"]).optional(),
  // Reservado pra fallback worker→make (#892, ainda não implementado).
  fallback_used: z.boolean().optional(),
  fallback_reason: z.string().optional(),
}).passthrough();


export const SocialPublishedSchema = z.object({
  posts: z.array(PostEntrySchema),
  summary: z.object({
    total: z.number().optional(),
    draft: z.number().optional(),
    scheduled: z.number().optional(),
    failed: z.number().optional(),
    published: z.number().optional(),
  }).optional(),
});

export type SocialPublished = z.infer<typeof SocialPublishedSchema>;

/** Parse + valida 06-social-published.json. */
export function parseSocialPublished(raw: unknown): SocialPublished {
  return SocialPublishedSchema.parse(raw);
}
