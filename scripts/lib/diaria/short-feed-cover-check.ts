/**
 * short-feed-cover-check.ts (#12100) — a capa chegou ao feed de Shorts?
 *
 * O `thumbnails.set` troca a miniatura 16:9 do Short (`maxresdefault.jpg`), mas
 * a aba Shorts do canal mostra outra imagem, escolhida à parte. #12251
 * (medido pelo editor na rede da página do canal, 04/11/2026): a aba carrega
 * `i.ytimg.com/vi/{id}/sardefault.jpg` quando o Short tem miniatura vertical
 * própria e cai no frame automático (`oar2.jpg`/`oar1.jpg`) quando não tem. O
 * `oar2`, que o #12100 media, é frame automático sempre — por isso ele dava
 * "frame" até nos 6 Shorts que mostravam a capa na aba. 404 no `sardefault` =
 * sem capa vertical; 200 não basta (o uIwtuFBqGkg tinha `sardefault` com um
 * frame), por isso a comparação de imagem continua.
 *
 * Este módulo compara o `sardefault` com a capa local (`04-youtube-short-capa.jpg`)
 * por hash perceptual de diferença (dHash 16x16, 256 bits). Puro sobre os
 * bytes das imagens; o fetch fica no CLI `scripts/check-short-feed-cover.ts`.
 *
 * Por que dHash e não comparação de pixels: a imagem do feed é reencodada pelo YouTube
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
 *
 * Remedido em 08/11/2026 (#12377 item 4) contra o `sardefault.jpg` REAL
 * (1080x1920, o que a aba Shorts carrega desde o #12251) de 10 Shorts: os 6
 * que mostram a capa na aba (WEAmxrYpr1E, 4Sdq1thhSAA, 27q1xuvBUc4,
 * UYllsanoQqw, X4j2u-WxFvk, K3GqRK5gFds), o uIwtuFBqGkg e 5jX3X0sgMtg,
 * BQkZjUGWTDQ e 5CZ0zFFJ4RM.
 * - `sardefault` x capa local aplicada, nos 7 com a imagem em `data/editions`
 *   (4Sdq1thhSAA, K3GqRK5gFds, X4j2u-WxFvk pela `-D`, 5jX3X0sgMtg,
 *   BQkZjUGWTDQ, 5CZ0zFFJ4RM, e uIwtuFBqGkg contra `04-short-capa-still.jpg`):
 *   0,000 a 0,020. O YouTube não recorta nem reescala a miniatura vertical de
 *   forma que o dHash perceba. 27q1xuvBUc4, UYllsanoQqw e WEAmxrYpr1E não têm
 *   a capa local; entram só nas linhas de baixo.
 * - `sardefault` x `04-youtube-short-capa.jpg` quando a capa aplicada foi
 *   outra variante do MESMO desenho (X4j2u-WxFvk/261023: o editor subiu a
 *   `-D`, que dá 0,008; o arquivo canônico dá 0,176). É a margem mais
 *   apertada do lado "capa".
 * - `sardefault` x frame automático do mesmo Short (`oar2`): 0,266 a 0,484.
 * - `sardefault` x capa de outra edição: 0,371 a 0,566.
 * O limiar 0,2 continua entre 0,176 e 0,266, sem mudança. Travado em
 * `test/short-feed-cover-threshold-12377.test.ts`; quem mudar o limiar
 * remede e atualiza as duas pontas lá.
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

/** #12251: `sem-capa-vertical` = `sardefault.jpg` deu 404 (a aba mostra o frame automático). */
export type FeedCoverVerdict = "capa" | "frame-automatico" | "sem-capa-vertical";

export interface FeedCoverAssessment {
  verdict: FeedCoverVerdict;
  /** Fração de bits diferentes (0 = idênticas). */
  distance: number;
  threshold: number;
}

/** Compara a imagem do feed (`sardefault.jpg`, #12251) com a capa local. */
export async function assessFeedCover(feedImage: Buffer, cover: Buffer, threshold = FEED_COVER_MATCH_MAX_DISTANCE): Promise<FeedCoverAssessment> {
  const distance = hashDistance(await dHash(feedImage), await dHash(cover));
  return { verdict: distance <= threshold ? "capa" : "frame-automatico", distance, threshold };
}
