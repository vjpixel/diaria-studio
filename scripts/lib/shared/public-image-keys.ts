/**
 * Chaves e regra de presença de imagem pública por destaque, em
 * `06-public-images.json` (#7399).
 *
 * Extraído de `scripts/upload-images-public.ts` (que continha a única
 * implementação até então) pro review do PR #7596 — o consumidor original
 * (`assertCacheCompleteness`, no CLI de upload) e o novo consumidor
 * (`checkPublicImagesPopulated`, invariant de Stage 4) reimplementavam a
 * mesma regra "4:5 OU hero 2:1" em paralelo, exatamente a classe de drift
 * que causou a própria issue #7399 (check ficou desatualizado quando a
 * chave base 1x1 parou de ser uploadada). Módulo puro, sem dependência de
 * `.env`/rede/CLI — importável tanto pelo script de upload quanto pela
 * biblioteca de invariant checks sem herdar side effects de carregamento.
 */

/**
 * #7399: chave do hero 2:1 pra um destaque — fallback direto (sem passar
 * mais pelo 1:1 legado, que deixou de ser uploadado) quando o card 4:5
 * falta. D1 é a exceção de nomenclatura: seu 2:1 é a chave `cover`
 * (upload-a como capa do email, #1121), não `d1_2x1`; D2/D3 usam
 * `d{N}_2x1` (#2133/#2141).
 */
export function hero2x1KeyFor(destaque: string): string {
  return destaque === "d1" ? "cover" : `${destaque}_2x1`;
}

/**
 * #7399: "imagem presente pro destaque" é satisfeita por QUALQUER um dos
 * dois: o card 4:5 (`d{N}_4x5`) OU o hero 2:1 (`hero2x1KeyFor`, sempre
 * presente em edições normais — é o mesmo hero que o email usa). A chave
 * base 1x1 (`d1`/`d2`/`d3`) não é mais uploadada, então não entra na regra.
 */
export function isDestaqueImagePresent(
  images: Record<string, { url?: string } | undefined>,
  destaque: string,
): boolean {
  const has4x5 = !!images[`${destaque}_4x5`]?.url;
  const hasHero = !!images[hero2x1KeyFor(destaque)]?.url;
  return has4x5 || hasHero;
}
