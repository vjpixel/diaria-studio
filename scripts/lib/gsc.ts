/**
 * gsc.ts — constantes do Google Search Console compartilhadas pelos scripts de
 * SEO (`seo-pull.ts`, `seo-index-check.ts`).
 *
 * Existe porque as duas pontas do loop de SEO nasceram em PRs paralelas (#4099
 * e #4106, 260727) e cada uma carregava o próprio literal da propriedade. Um
 * literal duplicado aqui não é cosmético: se a verificação no Search Console
 * mudar de forma e só um dos dois for atualizado, o outro passa a devolver 403
 * silenciosamente — e o script que falha é justamente o que deveria avisar que
 * a medição parou.
 */

/**
 * Propriedade padrão consultada na Search Console API.
 *
 * É uma **domain property** (`sc-domain:`), verificada em 260727 (#4089) via
 * TXT no Cloudflare — cobre todos os hosts e protocolos de diar.ia.br de uma vez.
 *
 * NÃO somar com o host antigo `https://diaria.beehiiv.com/`: a conta do OAuth é
 * `siteUnverifiedUser` nele (403 na Search Analytics), e hoje aquele host
 * responde 301 pra diar.ia.br, com os posts em self-canonical no domínio novo.
 * Esse default errado é a razão de `data/seo/` nunca ter existido antes do #4099.
 */
export const GSC_DEFAULT_SITE = "sc-domain:diar.ia.br";

/** Sitemap público do site (233 URLs em 260727: 223 edições + institucionais). */
export const DEFAULT_SITEMAP_URL = "https://diar.ia.br/sitemap.xml";
