/**
 * Chaves de `06-public-images.json` que pertencem a UMA posição de destaque, e
 * a invalidação (remoção) dessas chaves quando o conteúdo da posição muda
 * (#11252).
 *
 * Antes deste módulo, só o `reorder-destaques.ts` (#8679, e por tabela o
 * `promote-to-destaque.ts`) removia as chaves da posição afetada. Os dois
 * scripts de TROCA (`swap-destaques.ts`, item fora do pool; `swap-destaque.ts`,
 * item do pool) apagavam as imagens locais `04-d{N}-*` e deixavam o cache
 * intocado: na edição 261027 a chave `d3_2x1` seguiu apontando pra arte do
 * destaque ANTIGO e o e-mail de teste do Kit saiu com a imagem de outro assunto.
 * Fonte única da lista de chaves por posição pros três caminhos.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAROUSEL_SLIDE_SLOTS } from "./daily-carousel-card.ts";
import { D1_PLAY_IMAGE_KEY } from "./diaria/d1-video-hero.ts";
import { hero2x1KeyFor } from "./shared/public-image-keys.ts";

/**
 * Todas as chaves de `06-public-images.json` cuja arte é da posição `pos`:
 * hero 2:1 (`cover` no D1, `d{N}_2x1` no D2/D3), card 4:5, os 4 slides do
 * carrossel, a chave base 1:1 legada (`d{N}`, pré-#7399, ainda presente em
 * caches antigos) e, no D1, a cópia do hero com o convite (`d1_play`, #10784 —
 * derivada do hero, então fica velha junto com ele).
 */
export function publicImageKeysForPosition(pos: number): string[] {
  const d = `d${pos}`;
  return [
    hero2x1KeyFor(d),
    ...(pos === 1 ? [D1_PLAY_IMAGE_KEY] : []),
    `${d}_4x5`,
    ...CAROUSEL_SLIDE_SLOTS.map((slot) => `${d}_carousel_${slot}`),
    d,
  ];
}

export interface PublicImagesInvalidation {
  changed: boolean;
  removedKeys: string[];
  data: unknown;
}

/**
 * Remove de `data.images` todas as chaves das posições pedidas. Pure — não
 * lê nem grava disco. Shape fora do esperado (sem `images`, `images` não-objeto)
 * devolve `changed: false` com `data` intocado, mesmo contrato de
 * `invalidatePublicImagesForReorder`.
 */
export function invalidatePublicImagesForPositions(
  data: unknown,
  positions: readonly number[],
): PublicImagesInvalidation {
  const rawImages = data && typeof data === "object" ? (data as { images?: unknown }).images : undefined;
  if (!rawImages || typeof rawImages !== "object" || Array.isArray(rawImages)) {
    return { changed: false, removedKeys: [], data };
  }
  const images = { ...(rawImages as Record<string, unknown>) };
  const removedKeys: string[] = [];
  for (const pos of positions) {
    for (const key of publicImageKeysForPosition(pos)) {
      if (key in images) {
        delete images[key];
        removedKeys.push(key);
      }
    }
  }
  if (removedKeys.length === 0) return { changed: false, removedKeys: [], data };
  return { changed: true, removedKeys, data: { ...(data as object), images } };
}

export interface PublicImagesFilePlan {
  /** Path de `06-public-images.json` da edição. */
  path: string;
  /** Conteúdo novo a gravar; ausente quando não há nada a remover (ou o arquivo não existe/é ilegível). */
  content?: string;
  removedKeys: string[];
  /** Arquivo existe mas não deu pra ler/parsear — nada removido, precisa de atenção. */
  error?: string;
}

/**
 * Lê `06-public-images.json` da edição e planeja a invalidação das posições.
 * Não grava: o chamador junta `content` ao próprio lote verificado
 * (`writeFilesVerified`). Arquivo ausente = nada a fazer (upload ainda não
 * rodou). JSON ruim vira `error` em vez de lançar — o swap já mexeu nos
 * outros arquivos e não pode abortar no meio por causa do cache.
 */
export function planPublicImagesInvalidation(
  editionDir: string,
  positions: readonly number[],
): PublicImagesFilePlan {
  const path = resolve(editionDir, "06-public-images.json");
  if (!existsSync(path)) return { path, removedKeys: [] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { path, removedKeys: [], error: (e as Error).message ?? String(e) };
  }
  const result = invalidatePublicImagesForPositions(data, positions);
  if (!result.changed) return { path, removedKeys: [] };
  return { path, removedKeys: result.removedKeys, content: JSON.stringify(result.data, null, 2) + "\n" };
}

/** Aviso padrão pós-invalidação (mesmo texto nos scripts de troca). */
export function publicImagesInvalidatedWarning(removedKeys: readonly string[]): string {
  return (
    `06-public-images.json: removidas ${removedKeys.length} chave(s) da(s) posição(ões) trocada(s) ` +
    `(${removedKeys.join(", ")}) — depois de gerar as imagens novas, rodar upload-images-public.ts ` +
    `--mode newsletter e --mode social (#11252).`
  );
}
