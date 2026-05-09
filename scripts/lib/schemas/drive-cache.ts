/**
 * drive-cache.ts — Schema Zod para data/drive-cache.json (#632 Tier A)
 *
 * Bug-driver: #496 — cache stale causava false-positive conflicts quando
 * drive_modifiedTime dessincronia. Schema valida que os campos usados
 * na comparação de conflito existem com os tipos esperados.
 */

import { z } from "zod";

export const FileEntrySchema = z.object({
  drive_file_id: z.string(),
  drive_modifiedTime: z.string(),
  last_pushed_mtime: z.number(),
  push_count: z.number().int().min(0),
  drive_mimeType: z.string().optional(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

export const EditionCacheSchema = z.object({
  day_folder_id: z.string(),
  files: z.record(z.string(), FileEntrySchema),
  subfolder_ids: z.record(z.string(), z.string()).optional(),
});

export type EditionCache = z.infer<typeof EditionCacheSchema>;

export const DriveCacheSchema = z.object({
  edicoes_folder_id: z.string().optional(),
  editions: z.record(z.string(), EditionCacheSchema),
});

export type DriveCache = z.infer<typeof DriveCacheSchema>;

// (parseDriveCache removido em #1008 — schema exportado pra uso direto se
// futuro consumer aparecer; helper extra era dead code)
