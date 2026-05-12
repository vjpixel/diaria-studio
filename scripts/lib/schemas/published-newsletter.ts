/**
 * published-newsletter.ts — Schema Zod para `_internal/05-published.json` (#1132 P2.5)
 *
 * Output do publish-newsletter playbook. Lido por: review-test-email loop,
 * auto-reporter (signals collection), publish-monthly (cross-ref histórico).
 *
 * Bug-class motivador (#1132): corruption silenciosa em `draft_url`,
 * `test_email_sent_at` ou `status` deixa loop verify→fix dependente de
 * estado inconsistente. Schema strict pega isso na borda.
 *
 * Campos críticos com validação strict:
 * - `draft_url`: URL absoluta do rascunho Beehiiv
 * - `status`: literal enum {draft, scheduled, published, sent, unknown}
 *
 * Demais campos opcionais com passthrough (metadata em evolução).
 */

import { z } from "zod";

export const PublishStatusSchema = z.enum([
  "draft",
  "scheduled",
  "published",
  "sent",
  "unknown",
]);
// Type inferido inline via `z.infer<typeof PublishStatusSchema>` quando necessário.

export const UnfixedIssueSchema = z.object({
  reason: z.string(),
  section: z.string(),
  details: z.string(),
}).passthrough();

export const BodyPasteSchema = z.object({
  inserted: z.boolean(),
  html_bytes: z.number().int().nonnegative().optional(),
  docSize: z.number().int().nonnegative().optional(),
  has_poll_sig: z.boolean().optional(),
  has_imgA: z.boolean().optional(),
  has_imgB: z.boolean().optional(),
}).passthrough();

export const PublishedNewsletterSchema = z.object({
  draft_url: z.string().url({ message: "draft_url deve ser URL absoluta válida" }),
  title: z.string().min(1, "title não pode ser vazio"),
  subtitle: z.string().optional(),
  subject_set: z.string().optional(),
  template_used: z.string().optional(),
  test_email_sent_to: z.string().nullable().optional(),
  test_email_sent_at: z.string().nullable().optional(),
  status: PublishStatusSchema,
  unfixed_issues: z.array(UnfixedIssueSchema).optional(),
  body_paste: BodyPasteSchema.optional(),
  title_persisted: z.boolean().optional(),
  fix_attempts: z.number().int().nonnegative().optional(),
}).passthrough();

export type PublishedNewsletter = z.infer<typeof PublishedNewsletterSchema>;

/**
 * Parse com mensagem de erro descritiva. Re-lança Error com path do campo
 * em falha — facilita debug quando schema drift acontece em produção.
 */
export function parsePublishedNewsletter(raw: unknown): PublishedNewsletter {
  const result = PublishedNewsletterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`05-published.json schema inválido: ${issues}`);
  }
  return result.data;
}
