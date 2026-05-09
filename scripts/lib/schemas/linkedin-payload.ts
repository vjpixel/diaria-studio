/**
 * linkedin-payload.ts — Schemas Zod pra payloads LinkedIn (#1032)
 *
 * Cobre:
 *   - MakeWebhookPayload (publish-linkedin envia pra Make.com webhook)
 *   - MakeWebhookResponse (Make retorna após aceitar)
 *   - WorkerQueueRequest/Response (Cloudflare Worker queue do LinkedIn cron)
 *
 * Bug-driver histórico (#974, #886):
 *   image_url null silenciosamente aceito → Make retorna DLQ.
 *   Schema força image_url ser explícito (string ou null literal).
 */

import { z } from "zod";

// ─── Make.com webhook ──────────────────────────────────────────────────────

/**
 * Payload enviado pra Make.com webhook em publish-linkedin.ts.
 *
 * Sobre `passthrough()`: passa pra Make.com via webhook que aceita campos
 * extras. Schema captura mínimo necessário; campos novos não quebram.
 */
export const MakeWebhookPayloadSchema = z.object({
  text: z.string().min(1, "text não pode estar vazio"),
  // image_url DEVE ser explícito — null literal aceito, undefined NÃO
  image_url: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  destaque: z.string(),
}).passthrough();

export type MakeWebhookPayload = z.infer<typeof MakeWebhookPayloadSchema>;

export const MakeWebhookResponseSchema = z.object({
  request_id: z.string().optional(),
  accepted: z.boolean().optional(),
}).passthrough();

export type MakeWebhookResponse = z.infer<typeof MakeWebhookResponseSchema>;

/** Parse + valida payload antes de mandar pro Make. Throws se inválido. */
export function parseMakeWebhookPayload(raw: unknown): MakeWebhookPayload {
  return MakeWebhookPayloadSchema.parse(raw);
}

/** Parse + valida response do Make. */
export function parseMakeWebhookResponse(raw: unknown): MakeWebhookResponse {
  return MakeWebhookResponseSchema.parse(raw);
}

// ─── Cloudflare Worker queue ───────────────────────────────────────────────

/**
 * Request body enviado pro Cloudflare Worker que enfileira posts LinkedIn.
 * Mesmo shape do MakeWebhookPayload (worker é proxy + storage).
 */
export const WorkerQueueRequestSchema = MakeWebhookPayloadSchema;
export type WorkerQueueRequest = MakeWebhookPayload;

/**
 * Response do Worker após enfileirar com sucesso.
 *
 * Sobre `queued: z.literal(true)`: contrato explícito — se Worker retornar
 * `queued: false`, parse falha (em vez de silent partial enqueue).
 */
export const WorkerQueueResponseSchema = z.object({
  queued: z.literal(true),
  key: z.string(),
  scheduled_at: z.string(),
  destaque: z.string(),
}).passthrough();

export type WorkerQueueResponse = z.infer<typeof WorkerQueueResponseSchema>;

export function parseWorkerQueueResponse(raw: unknown): WorkerQueueResponse {
  return WorkerQueueResponseSchema.parse(raw);
}
