/**
 * drive-cache.ts (#829)
 *
 * Helpers puros pra ler `data/drive-cache.json` produzido por
 * `scripts/drive-sync.ts`. Extraído de `scripts/check-drive-push.ts`
 * pra que outras libs possam consumir sem importar de um CLI script
 * (lib → script é inversão da fronteira usual).
 *
 * `check-drive-push.ts` re-exporta `readDriveCache` e `getPushCount`
 * pra retrocompat — código existente que importa de lá continua funcionando.
 */

import { existsSync, readFileSync } from "node:fs";

export interface DriveCacheFile {
  push_count?: number;
  drive_file_id?: string;
  [key: string]: unknown;
}

export interface DriveCacheEdition {
  day_folder_id?: string;
  files?: Record<string, DriveCacheFile>;
  [key: string]: unknown;
}

export interface DriveCache {
  editions?: Record<string, DriveCacheEdition>;
  [key: string]: unknown;
}

/**
 * Lê e valida o drive-cache.json de forma segura.
 * Retorna null (com warn) se o arquivo não existe ou tem schema inesperado.
 */
export function readDriveCache(cachePath: string): DriveCache | null {
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as DriveCache;
  } catch {
    return null;
  }
}

/**
 * Retorna o push_count de um arquivo em uma edição, ou null se não encontrado.
 * Nunca lança — schema inesperado retorna null.
 */
export function getPushCount(
  cache: DriveCache,
  edition: string,
  filename: string,
): number | null {
  try {
    const editionEntry = cache.editions?.[edition];
    if (!editionEntry || typeof editionEntry !== "object") return null;
    const fileEntry = editionEntry.files?.[filename];
    if (!fileEntry || typeof fileEntry !== "object") return null;
    const count = fileEntry.push_count;
    return typeof count === "number" && count > 0 ? count : null;
  } catch {
    return null;
  }
}
