/**
 * use-melhor-slide-files.ts (#9568)
 *
 * Nomes de arquivo/chave e carimbo dos slides do carrossel do 4º post (item
 * USE MELHOR). Módulo FOLHA (só `node:fs`/`node:path`) de propósito:
 * `upload-images-public.ts` precisa destes nomes, e `use-melhor-carousel.ts`
 * importa `weekly-flat-card.ts`, que por sua vez importa
 * `upload-images-public.ts` — importar o carrossel de lá fecharia um ciclo de
 * módulos (`ReferenceError: Cannot access 'WEEKLY_FLAT_CARD_LAYOUT' before
 * initialization`). `use-melhor-carousel.ts` re-exporta tudo daqui.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Id da seção do 4º post. Espelha `USE_MELHOR_POST_ID` de `use-melhor-post.ts`
 * (não importado daqui pra manter o módulo folha — paridade travada em teste).
 */
const POST_ID = "um";

/** Nome do arquivo local (raiz da edição) de um slide do 4º post. */
export function useMelhorSlideFilename(slot: string): string {
  return `04-${POST_ID}-carousel-${slot}-4x5.jpg`;
}

/** Chave em `06-public-images.json` (`images`) de um slide do 4º post. */
export function useMelhorSlideImageKey(slot: string): string {
  return `${POST_ID}_carousel_${slot}`;
}

/** Carimbo próprio — separado do `.carousel-source-hash.json` de D1/D2/D3. */
export function useMelhorCarouselHashPath(editionDir: string): string {
  return resolve(editionDir, "_internal", ".use-melhor-carousel-hash.json");
}

export interface UseMelhorCarouselStamp {
  hash: string;
  slots: string[];
}

export function readUseMelhorCarouselStamp(editionDir: string): UseMelhorCarouselStamp | null {
  const p = useMelhorCarouselHashPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as Partial<UseMelhorCarouselStamp>;
    return typeof d.hash === "string" && Array.isArray(d.slots) ? { hash: d.hash, slots: d.slots } : null;
  } catch {
    return null;
  }
}
