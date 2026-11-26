/**
 * scripts/lib/public-images-file.ts (#14125)
 *
 * Leitura best-effort de `06-public-images.json` para resolver o carrossel
 * diário (#6095/#6104). Antes vivia copiada em `publish-facebook.ts` e
 * `publish-threads.ts`; os dois re-exportam esta função com o mesmo nome.
 *
 * Contrato: ausência do arquivo OU JSON corrompido nunca lança. Os dois
 * degradam para "sem carrossel" (`{}`), preservando o tudo-ou-nada de
 * `resolveCarouselImageUrls` (`daily-carousel-card.ts`) e nunca abortando o
 * dispatch. O JSON corrompido gera um `WARN` em stderr.
 */
import { existsSync, readFileSync } from "node:fs";

export type PublicImagesFile = { images?: Record<string, { url?: string }> };

export function loadPublicImagesFile(publicImagesPath: string): PublicImagesFile {
  if (!existsSync(publicImagesPath)) return {};
  try {
    return JSON.parse(readFileSync(publicImagesPath, "utf8")) as PublicImagesFile;
  } catch (e: any) {
    console.warn(`WARN: falha ao parsear ${publicImagesPath} (${e.message}) — seguindo sem carrossel.`);
    return {};
  }
}
