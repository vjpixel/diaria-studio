/**
 * bing.ts — constantes do Bing Webmaster Tools compartilhadas pelos scripts
 * de SEO (`bing-pull.ts`).
 *
 * As quatro propriedades estão verificadas por DNS (CNAME, via API da
 * Cloudflare) desde 19/08/2026 — ver `docs/seo-notes.md` §Fato 13 e §Fato 3 pro histórico
 * completo da verificação (armadilhas de `AddSite`/`GetUserSites`/`SubmitFeed`
 * encontradas ao vivo). Diferente do Search Console (que usa a propriedade de
 * domínio única `sc-domain:diar.ia.br`, ver `lib/gsc.ts`), o BWT foi
 * verificado como QUATRO propriedades de **prefixo de URL** — cada host é
 * consultado separadamente, com `siteUrl` completo (protocolo + barra final).
 */

/** Propriedade padrão consultada pelos scripts de BWT. */
export const BING_DEFAULT_SITE = "https://diar.ia.br/";

/** Base da API JSON do Bing Webmaster Tools (auth via query param `apikey`, não OAuth). */
export const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json/";

/**
 * Os 4 hosts do projeto (#5621) — `diar.ia.br`, `arquivo.diar.ia.br`,
 * `livros.diar.ia.br` e `cursos.diar.ia.br` — estão cadastrados/verificados
 * no BWT desde 19/08/2026 (ver `docs/seo-notes.md` §Fato 13).
 * Mantido aqui como o registro único dos 4 hosts verificados no BWT —
 * `bing-pull.ts --mode site --site all` itera esta lista com falha
 * per-site tolerada (host ainda não verificado não derruba os outros 3).
 */
export const BING_KNOWN_SITES: readonly string[] = [
  "https://diar.ia.br/",
  "https://arquivo.diar.ia.br/",
  "https://livros.diar.ia.br/",
  "https://cursos.diar.ia.br/",
];
