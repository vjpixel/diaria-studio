/**
 * cover-image.ts (#5131)
 *
 * Dimensão fixa da capa 2:1 gerada pelo pipeline diário (`scripts/image-generate.ts`,
 * saída D1 `04-d1-2x1.jpg` — sempre 1600×800). É essa mesma imagem que vira
 * `thumbnail_url` do post na Beehiiv via upload (#2341, `beehiiv-cover-upload.ts`)
 * — o Beehiiv não expõe dimensão de imagem na API, então quem consome
 * `coverImageUrl` (via `titles-cache.json`, ver `generate-arquivo-titles.ts`)
 * pra montar `og:image:width`/`og:image:height` assume este valor fixo em
 * vez de o cache carregar `width`/`height` redundantes por entrada.
 *
 * Consumido por `workers/arquivo/src/render-archive.ts` (og:image da raiz) e
 * `scripts/build-hub-page.ts` (og:image dos hubs) — extraído aqui pra não
 * duplicar o literal `1600`/`800` nos dois lugares.
 */
export const COVER_IMAGE_WIDTH = 1600;
export const COVER_IMAGE_HEIGHT = 800;
