/**
 * platform-config.ts — Schema Zod para platform.config.json (#632 Tier A)
 *
 * Bug-driver: #316 — gmailQuery referenciava label inexistente, inbox drain
 * abortava silenciosamente. Schema valida shape sem verificar existência do
 * label em runtime (isso requereria I/O extra); garante pelo menos que os
 * campos existem com tipos corretos.
 */

import { z } from "zod";

const ScheduleSchema = z.object({
  d1: z.string(),
  d2: z.string(),
  d3: z.string(),
}).optional();

export const PlatformConfigSchema = z.object({
  newsletter: z.string().optional(),
  publication_id: z.string().optional(),
  drive_sync: z.boolean().optional().default(true),
  drive_sync_conflict_tolerance_seconds: z.number().optional().default(10),
  image_generator: z.enum(["gemini", "comfyui", "cloudflare", "openai"]).optional().default("gemini"),

  inbox: z.object({
    enabled: z.boolean().optional().default(true),
    gmailQuery: z.string().optional(),
    address: z.string().email().optional(),
  }).optional(),

  publishing: z.object({
    newsletter: z.object({
      platform: z.string().optional(),
      template: z.string().optional(),
    }).optional(),
    social: z.object({
      linkedin: z.object({
        method: z.string().optional(),
        page_id: z.string().optional(),
        scheduled_posts_url: z.string().optional(),
        fallback_schedule: ScheduleSchema,
        day_offset: z.number().optional().default(0),
      }).optional(),
      facebook: z.object({
        method: z.string().optional(),
        fallback_schedule: ScheduleSchema,
        day_offset: z.number().optional().default(0),
      }).optional(),
    }).optional(),
  }).optional(),
}).passthrough();

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

/** Parse + valida platform.config.json. Throws ZodError se shape inválido. */
export function parsePlatformConfig(raw: unknown): PlatformConfig {
  return PlatformConfigSchema.parse(raw);
}
