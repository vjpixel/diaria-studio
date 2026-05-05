/**
 * drive-api.ts — Schemas Zod para responses da API Google Drive v3 (#649 Tier B)
 *
 * Bug-driver: #496 — divergência entre `meta.modifiedTime` (Drive API) e
 * `fileCache.drive_modifiedTime` (local cache). Quando a API muda formato
 * de timestamp ou retorna campo ausente, comparações silenciosamente
 * inválidas levam a CONFLICT falsos ou pushes que sobrescrevem edições.
 *
 * Estes schemas validam o boundary HTTP de `driveGetMetadata`,
 * `driveUploadFile` e `driveUpdateFile` — fail-loud em vez de NaN/undefined
 * propagando.
 *
 * Distinto do `drive-cache.ts` (Tier A) que valida o arquivo local
 * `data/drive-cache.json`.
 */

import { z } from "zod";

/**
 * ISO-8601 datetime que parseia com `new Date(...)`. Drive API v3 retorna
 * sempre em formato `2024-01-15T10:30:45.123Z`, mas se vier malformado (#496)
 * a comparação `new Date(s).getTime()` retorna NaN silenciosamente.
 */
const ZIsoDateTime = z.string().refine(
  (s) => !Number.isNaN(new Date(s).getTime()),
  { message: "modifiedTime must be a valid ISO datetime parseable by `new Date()`" },
);

// ---------------------------------------------------------------------------
// Get metadata response
// ---------------------------------------------------------------------------

export const DriveFileMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  modifiedTime: ZIsoDateTime,
  parents: z.array(z.string()).optional(),
  mimeType: z.string().optional(),
  size: z.string().optional(),
}).passthrough();

export type DriveFileMetadata = z.infer<typeof DriveFileMetadataSchema>;

// ---------------------------------------------------------------------------
// Upload / update response
// ---------------------------------------------------------------------------

export const DriveFileUploadResponseSchema = z.object({
  id: z.string().min(1),
  modifiedTime: ZIsoDateTime,
  mimeType: z.string(),
  name: z.string().optional(),
}).passthrough();

export type DriveFileUploadResponse = z.infer<typeof DriveFileUploadResponseSchema>;

// ---------------------------------------------------------------------------
// List response (driveList)
// ---------------------------------------------------------------------------

export const DriveFileListItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  modifiedTime: ZIsoDateTime.optional(),
  mimeType: z.string().optional(),
}).passthrough();

export const DriveFileListResponseSchema = z.object({
  files: z.array(DriveFileListItemSchema).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();

export type DriveFileListResponse = z.infer<typeof DriveFileListResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse + valida response de `GET /files/{id}?fields=...`. Throws ZodError. */
export function parseDriveFileMetadata(raw: unknown): DriveFileMetadata {
  return DriveFileMetadataSchema.parse(raw);
}

/** Parse + valida response de upload/update multipart. */
export function parseDriveFileUploadResponse(raw: unknown): DriveFileUploadResponse {
  return DriveFileUploadResponseSchema.parse(raw);
}

/** Parse + valida response de listagem (`GET /files?q=...`). */
export function parseDriveFileListResponse(raw: unknown): DriveFileListResponse {
  return DriveFileListResponseSchema.parse(raw);
}
