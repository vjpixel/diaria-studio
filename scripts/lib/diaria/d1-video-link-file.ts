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
import { isNoVideoEdition } from "./d1-no-video.ts";

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

/**
 * #12588: o link que os posts do D1 (X, Threads, Facebook) usam. Igual ao
 * `readD1VideoUrl`, mas a edição marcada sem vídeo (`_internal/no-video.json`,
 * #11125) não leva link, mesmo com `05-video-url.txt` presente: o marcador
 * vence a URL, como já valia na newsletter (`newsletter-parse.ts`). Antes
 * disso os publishers sociais ignoravam o marcador, e o pré-requisito da
 * Etapa 5 dizia ao editor que o D1 sairia sem o link quando não saía.
 */
export function readD1VideoUrlForPosts(editionDir: string): D1VideoUrlRead {
  if (isNoVideoEdition(editionDir)) return { url: null, warning: null };
  return readD1VideoUrl(editionDir);
}
