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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Casa uma chave de slide do 4º post em `06-public-images.json` e devolve o slot. */
const USE_MELHOR_IMAGE_KEY_RE = new RegExp(`^${POST_ID}_carousel_(cover|p\\d+|cta)$`);

/** Pure: slot de uma chave `um_carousel_{slot}`, ou `null` se não for chave do 4º post. */
export function useMelhorSlotFromImageKey(key: string): string | null {
  return key.match(USE_MELHOR_IMAGE_KEY_RE)?.[1] ?? null;
}

/**
 * Pure (#9795): chaves de slide do 4º post em `images` (`06-public-images.json`)
 * cujo arquivo local não existe mais. Caso típico (edição 261007): o `## um`
 * foi reescrito com menos parágrafos, `gen-carousel-cards.ts` apagou
 * `04-um-carousel-p4/p5`, mas o cache de upload seguia com
 * `um_carousel_p4`/`p5` — URLs de slides que não fazem mais parte do
 * carrossel. `keepSlots` (os slots do carimbo atual) nunca entram na lista:
 * slide ATUAL com arquivo sumido é outro problema (#5085 — o upload já avisa
 * e mantém), não sobra de render antigo.
 */
export function staleUseMelhorImageKeys(
  images: Record<string, unknown>,
  editionDir: string,
  keepSlots: readonly string[] = [],
  fileExists: (p: string) => boolean = existsSync,
): string[] {
  const keep = new Set(keepSlots);
  return Object.keys(images).filter((key) => {
    const slot = useMelhorSlotFromImageKey(key);
    if (slot === null || keep.has(slot)) return false;
    return !fileExists(resolve(editionDir, useMelhorSlideFilename(slot)));
  });
}

/**
 * (#9795) Remove de `{editionDir}/06-public-images.json` as chaves de slide do
 * 4º post que sobraram de um render com mais slides (ver
 * `staleUseMelhorImageKeys`). Escrita atômica (tmp + rename). Fail-soft:
 * arquivo ausente/ilegível → `[]` sem tocar em nada. Devolve as chaves removidas.
 */
export function pruneStaleUseMelhorPublicImages(editionDir: string, keepSlots: readonly string[] = []): string[] {
  const p = resolve(editionDir, "06-public-images.json");
  if (!existsSync(p)) return [];
  let data: { images?: Record<string, unknown> };
  try {
    data = JSON.parse(readFileSync(p, "utf8")) as { images?: Record<string, unknown> };
  } catch {
    return [];
  }
  const images = data?.images;
  if (!images || typeof images !== "object") return [];
  const stale = staleUseMelhorImageKeys(images, editionDir, keepSlots);
  if (stale.length === 0) return [];
  for (const k of stale) delete images[k];
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
  return stale;
}
