/**
 * short-feed-cover-check.ts (#12100) — a capa chegou ao feed de Shorts?
 *
 * O `thumbnails.set` troca a miniatura 16:9 do Short (`maxresdefault.jpg`), mas
 * o feed de Shorts e a aba Shorts do canal mostram outra imagem,
 * `i.ytimg.com/vi/{id}/oar2.jpg` (1080x1920, proporção original), escolhida à
 * parte: frame automático ou a miniatura posta à mão no app do YouTube. Medido
 * em 04/11/2026: nenhum dos 9 Shorts públicos mostrava a capa no `oar2`.
 *
 * Este módulo compara o `oar2` com a capa local (`04-youtube-short-capa.jpg`)
 * por hash perceptual de diferença (dHash 16x16, 256 bits). Puro sobre os
 * bytes das imagens; o fetch fica no CLI `scripts/check-short-feed-cover.ts`.
 *
 * Por que dHash e não comparação de pixels: o `oar2` é reencodado pelo YouTube
 * (outra qualidade, às vezes outro tamanho), e a capa local pode ter outra
 * resolução. O hash de gradientes resiste a isso e ainda separa a capa (com o
 * lettering do título no topo) de um frame qualquer do mesmo vídeo.
 */

import sharp from "sharp";

/** Lado do hash: 16x16 = 256 bits. */
export const DHASH_SIZE = 16;

/**
 * Distância máxima (fração dos bits) para dizer "é a capa". Calibrado em
 * 04/11/2026 com os Shorts 5jX3X0sgMtg (261103) e 4Sdq1thhSAA (261030): a
 * capa local contra ela mesma reencodada em metade do tamanho, ou contra o
 * miolo do `maxresdefault.jpg` (onde o `thumbnails.set` a pôs), dá 0,07 a
 * 0,09; contra o frame automático do `oar2`, 0,36 a 0,47; capa de uma edição
 * contra a de outra, 0,50. O limiar fica entre os dois grupos.
 */
export const FEED_COVER_MATCH_MAX_DISTANCE = 0.2;

/** dHash: imagem em cinza (DHASH_SIZE+1)xDHASH_SIZE, bit = pixel maior que o vizinho da direita. */
export async function dHash(image: Buffer): Promise<Uint8Array> {
  const w = DHASH_SIZE + 1;
  const h = DHASH_SIZE;
  const { data } = await sharp(image).rotate().grayscale().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const bits = new Uint8Array(DHASH_SIZE * DHASH_SIZE);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < DHASH_SIZE; x++) {
      bits[y * DHASH_SIZE + x] = data[y * w + x] > data[y * w + x + 1] ? 1 : 0;
    }
  }
  return bits;
}

/** Fração de bits diferentes entre dois hashes do mesmo tamanho. */
export function hashDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`hashes de tamanhos diferentes (${a.length} x ${b.length})`);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff / a.length;
}

export type FeedCoverVerdict = "capa" | "frame-automatico";

export interface FeedCoverAssessment {
  verdict: FeedCoverVerdict;
  /** Fração de bits diferentes (0 = idênticas). */
  distance: number;
  threshold: number;
}

/** Compara a imagem do feed (`oar2.jpg`) com a capa local. */
export async function assessFeedCover(feedImage: Buffer, cover: Buffer, threshold = FEED_COVER_MATCH_MAX_DISTANCE): Promise<FeedCoverAssessment> {
  const distance = hashDistance(await dHash(feedImage), await dHash(cover));
  return { verdict: distance <= threshold ? "capa" : "frame-automatico", distance, threshold };
}
