/**
 * scripts/lib/shared/meta-graph.ts (#14124)
 *
 * Fonte única das versões da Graph API da Meta (`graph.facebook.com`). Antes
 * o literal da versão vivia em ~20 arquivos de `scripts/` e `workers/`; trocar
 * de versão quando a Meta aposentar uma passa a ser uma linha aqui.
 *
 * Duas constantes, uma por produto, de propósito com valores diferentes:
 *
 * - `META_GRAPH_VERSION`: Graph "social", o da publicação e leitura de
 *   Páginas do Facebook e da conta profissional do Instagram (publishers,
 *   coleta de seguidores, probes do Studio, Worker `linkedin-cron`).
 * - `META_ADS_GRAPH_VERSION`: Conversions API (CAPI), insights da conta de
 *   anúncios e Lead Ads (Worker `meta-leads`). Ficou numa versão anterior
 *   desde que entrou e nunca foi migrada junto com a social; unificar as duas
 *   é uma troca de versão de API (mudança de comportamento), fora do escopo
 *   da centralização.
 *
 * Threads (`graph.threads.net`, `v1.0`) é outra API com versionamento
 * próprio e fica em `scripts/lib/threads-api.ts`.
 *
 * Os overrides por env (`FACEBOOK_API_VERSION`, `INSTAGRAM_API_VERSION`,
 * `META_GRAPH_API_VERSION` nos `wrangler.toml`) continuam valendo: estas
 * constantes são só o default. Os `wrangler.toml` não importam TS, e a
 * igualdade deles com as constantes é travada por
 * `test/meta-graph-version-14124.test.ts`, que também reprova um literal de
 * versão novo fora deste módulo.
 *
 * Módulo puro, sem I/O: roda em Node e no runtime dos Workers.
 */

/** Versão da Graph API social (Facebook Pages + Instagram Graph). */
export const META_GRAPH_VERSION = "v25.0";

/** Versão da Graph API usada por CAPI, Ads insights e Lead Ads. */
export const META_ADS_GRAPH_VERSION = "v21.0";

/** Host da Graph API, sem versão. */
export const META_GRAPH_HOST = "https://graph.facebook.com";

/** `https://graph.facebook.com/{versão}`, sem barra no fim. */
export function metaGraphBase(version: string = META_GRAPH_VERSION): string {
  return `${META_GRAPH_HOST}/${version}`;
}
