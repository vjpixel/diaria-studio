/**
 * published-social.ts — Schema Zod para `_internal/06-social-published.json` (#1132 P2.5)
 *
 * Output de publish-facebook + publish-linkedin agregado. Lido por:
 * delete-test-schedules, auto-reporter signals collection.
 *
 * Cada entry de `posts[]` tem platform + destaque + status + URL/scheduled_at
 * dependendo do estado. LinkedIn pode incluir `route` (worker_queue) e
 * `webhook_target` (#971).
 */

import { z } from "zod";

export const SocialPlatformSchema = z.enum(["facebook", "linkedin"]);
// Type inferido inline via `z.infer<typeof SocialPlatformSchema>` quando necessário.

export const SocialPostStatusSchema = z.enum([
  "draft",
  "scheduled",
  "published",
  "failed",
  "pending_manual",
]);

export const SocialPostSchema = z.object({
  platform: SocialPlatformSchema,
  destaque: z.string(), // d1 | d2 | d3 | "comment_diaria" | "comment_pixel"
  subtype: z.string().optional(), // main | comment_diaria | comment_pixel
  url: z.string().nullable().optional(),
  status: SocialPostStatusSchema,
  scheduled_at: z.string().nullable().optional(),
  fb_post_id: z.string().optional(),
  route: z.string().optional(), // ex: "worker_queue"
  worker_queue_key: z.string().optional(),
  webhook_target: z.string().optional(),
  action: z.string().optional(),
  is_test: z.boolean().optional(), // #1056
}).passthrough();

export const PublishedSocialSchema = z.object({
  posts: z.array(SocialPostSchema),
}).passthrough();

export type PublishedSocial = z.infer<typeof PublishedSocialSchema>;

export function parsePublishedSocial(raw: unknown): PublishedSocial {
  const result = PublishedSocialSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`06-social-published.json schema inválido: ${issues}`);
  }
  return result.data;
}
