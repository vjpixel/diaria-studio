/**
 * bing.ts — constantes do Bing Webmaster Tools compartilhadas pelos scripts
 * de SEO (`bing-pull.ts`).
 *
 * As duas propriedades foram verificadas por DNS (CNAME, via API da
 * Cloudflare) em 11/ago/2026 — ver `docs/seo-notes.md` §Fato 3 pro histórico
 * completo da verificação (armadilhas de `AddSite`/`GetUserSites`/`SubmitFeed`
 * encontradas ao vivo). Diferente do Search Console (que usa a propriedade de
 * domínio única `sc-domain:diar.ia.br`, ver `lib/gsc.ts`), o BWT foi
 * verificado como DUAS propriedades de **prefixo de URL** — cada host é
 * consultado separadamente, com `siteUrl` completo (protocolo + barra final).
 */

/** Propriedade padrão consultada pelos scripts de BWT. */
export const BING_DEFAULT_SITE = "https://diar.ia.br/";

/** Base da API JSON do Bing Webmaster Tools (auth via query param `apikey`, não OAuth). */
export const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json/";
