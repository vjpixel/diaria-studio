/**
 * lib/twitter-weight.ts (#10180) — peso de um post no X (limite de 280).
 *
 * Módulo FOLHA (sem imports): extraído de `scripts/prep-twitter-posts.ts`,
 * que continua reexportando os três símbolos. O lint `curto-x-weight`
 * (`scripts/lib/lint-checks/curto-x-weight.ts`, Stage 2 e Stage 4) usa o
 * MESMO cálculo que o Stage 5 aplica antes de enviar ao Buffer. Um contador
 * próprio no lint poderia divergir, e o gate aprovaria um post que o Stage 5
 * depois pula.
 */

/** Limite de caracteres por tweet. */
export const TWITTER_CHAR_LIMIT = 280;

/**
 * Peso que o X (t.co) atribui a QUALQUER URL dentro de um post, independente
 * do comprimento literal — desde #3994. `text.length` cru superestima o custo
 * de uma URL longa (#4285/#4264 adendo do editor): `{edition_url}` resolve
 * pra `https://diar.ia.br/p/{slug}`, tipicamente 40-80 chars literais, mas o
 * X sempre conta 23 na hora de aplicar o limite de 280. Sem essa correção,
 * um slug longo derrubava o post pro `skipped` sem que ele de fato
 * estourasse no X.
 */
export const TWITTER_URL_WEIGHT = 23;

/** Reconhece URLs http(s) dentro do texto do post, pra fins de contagem ponderada. */
const URL_RE = /https?:\/\/\S+/g;

/**
 * Calcula o comprimento "ponderado" de um post do X, contando cada URL como
 * `TWITTER_URL_WEIGHT` chars (t.co) em vez do comprimento literal — o mesmo
 * critério que o X usa de verdade pra aplicar o limite de 280 (#4285/#4264
 * adendo do editor, #3994). Texto sem nenhuma URL: idêntico a `text.length`.
 */
export function computeTwitterWeightedLength(text: string): number {
  let delta = 0;
  for (const match of text.matchAll(URL_RE)) {
    delta += TWITTER_URL_WEIGHT - match[0].length;
  }
  return text.length + delta;
}
