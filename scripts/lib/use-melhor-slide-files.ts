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
 *
 * Só importa `node:*` — travado em `test/use-melhor-dispatch-9568.test.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Id da seção do 4º post em `03-social.md` (`## um`, sob `# Social` e
 * `# Curto`) — e o `destaque` das entries em `06-social-published.json` e na
 * fila do Worker. Fonte única; `use-melhor-post.ts` re-exporta.
 */
export const USE_MELHOR_POST_ID = "um";
const POST_ID = USE_MELHOR_POST_ID;

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
  /**
   * (#9630) Título da capa usado no render que gerou `hash`. A conferência de
   * staleness compara o `## um` atual contra ESTE título — não recalcula o
   * título a partir do `02-reviewed.md`, senão editar o título do item no
   * gate 4 (depois do Stage 3) marcaria a arte como defasada e derrubaria o
   * 4º post. Ausente em carimbos anteriores ao #9630 → quem confere usa o
   * título resolvido na hora (comportamento antigo).
   */
  cover_title?: string;
}

export function readUseMelhorCarouselStamp(editionDir: string): UseMelhorCarouselStamp | null {
  const p = useMelhorCarouselHashPath(editionDir);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as Partial<UseMelhorCarouselStamp>;
    if (typeof d.hash !== "string" || !Array.isArray(d.slots)) return null;
    return {
      hash: d.hash,
      slots: d.slots,
      ...(typeof d.cover_title === "string" && { cover_title: d.cover_title }),
    };
  } catch {
    return null;
  }
}
