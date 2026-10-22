/**
 * scripts/lib/diaria/d1-video-link-file.ts (#10772)
 *
 * I/O mínimo em volta de `d1-video-link.ts`: lê `_internal/05-video-url.txt`
 * da edição. Fail-soft — arquivo ausente é o caso normal (vídeo ainda não
 * existe) e arquivo inválido vira aviso: nunca derruba o publisher do D1.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { D1_VIDEO_URL_FILE, parseD1VideoUrlFile } from "./d1-video-link.ts";

export interface D1VideoUrlRead {
  url: string | null;
  /** Preenchido quando o arquivo existe mas não tem URL de vídeo válida. */
  warning: string | null;
}

export function readD1VideoUrl(editionDir: string): D1VideoUrlRead {
  const path = join(editionDir, D1_VIDEO_URL_FILE);
  if (!existsSync(path)) return { url: null, warning: null };
  try {
    return { url: parseD1VideoUrlFile(readFileSync(path, "utf8")), warning: null };
  } catch (e) {
    return { url: null, warning: `${D1_VIDEO_URL_FILE} ignorado: ${(e as Error).message}` };
  }
}
