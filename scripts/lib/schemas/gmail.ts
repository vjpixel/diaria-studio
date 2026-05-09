/**
 * gmail.ts — Schemas Zod para responses da API Gmail v1 (#649 Tier B)
 *
 * Bug-driver: falhas silenciosas em `inbox-drain.ts` quando a API retorna
 * uma mensagem sem `payload.headers` (ex: thread só com draft, ou conta
 * Gmail com configuração não-padrão). O drain pula a entrada sem registrar
 * — sumiço silencioso de submissões do editor.
 *
 * Estes schemas garantem fail-loud no boundary HTTP (parse imediato após
 * `gmailRequest`).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Headers e payload (parts recursivos via z.lazy)
// ---------------------------------------------------------------------------

export const GmailHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
}).passthrough();

export type GmailHeader = z.infer<typeof GmailHeaderSchema>;

export const GmailBodySchema = z.object({
  /** base64url-encoded body bytes. Ausente em parts container. */
  data: z.string().optional(),
  size: z.number().optional(),
  attachmentId: z.string().optional(),
}).passthrough();

export type GmailBody = z.infer<typeof GmailBodySchema>;

export interface GmailMessagePart {
  mimeType: string;
  body?: GmailBody;
  parts?: GmailMessagePart[];
  headers?: GmailHeader[];
  filename?: string;
  partId?: string;
}

/**
 * Part recursivo (multipart/* tem children). Schema declarado via interface
 * para permitir self-reference em `parts: GmailMessagePart[]`.
 */
export const GmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string(),
    body: GmailBodySchema.optional(),
    parts: z.array(GmailMessagePartSchema).optional(),
    headers: z.array(GmailHeaderSchema).optional(),
    filename: z.string().optional(),
    partId: z.string().optional(),
  }).passthrough(),
);

// ---------------------------------------------------------------------------
// Message + Thread
// ---------------------------------------------------------------------------

export const GmailMessageSchema = z.object({
  id: z.string(),
  /** Epoch ms como string. Pode ser parseado com `new Date(Number(internalDate))`. */
  internalDate: z.string(),
  /**
   * Top-level payload. Garantimos que `headers` é array (não undefined) — bug-driver
   * em mensagens sem headers explícitos faz `getHeader()` lançar TypeError.
   */
  payload: z.object({
    mimeType: z.string(),
    headers: z.array(GmailHeaderSchema),
    body: GmailBodySchema.optional(),
    parts: z.array(GmailMessagePartSchema).optional(),
    filename: z.string().optional(),
    partId: z.string().optional(),
  }).passthrough(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  sizeEstimate: z.number().optional(),
}).passthrough();


export const GmailThreadSchema = z.object({
  id: z.string(),
  messages: z.array(GmailMessageSchema),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
}).passthrough();

export type GmailThread = z.infer<typeof GmailThreadSchema>;

// ---------------------------------------------------------------------------
// Threads list (search response)
// ---------------------------------------------------------------------------

export const GmailThreadSummarySchema = z.object({
  id: z.string(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
}).passthrough();

export const GmailThreadsListResponseSchema = z.object({
  threads: z.array(GmailThreadSummarySchema).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
}).passthrough();

export type GmailThreadsListResponse = z.infer<typeof GmailThreadsListResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + valida response de `threads/{id}?format=full`. Throws ZodError se shape inválido. */
export function parseGmailThread(raw: unknown): GmailThread {
  return GmailThreadSchema.parse(raw);
}

/** Parse + valida response de `threads?q=...`. */
export function parseGmailThreadsList(raw: unknown): GmailThreadsListResponse {
  return GmailThreadsListResponseSchema.parse(raw);
}
