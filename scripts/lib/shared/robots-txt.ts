/**
 * robots-txt.ts (#4546)
 *
 * `robots.txt` PRÓPRIO pros Workers de curadoria (cursos, livros, arquivo) —
 * substitui o robots.txt DEFAULT gerenciado pela Cloudflare, que bloqueia 9
 * crawlers via `Disallow: /` sem que ninguém tenha escolhido isso: é o
 * comportamento nativo de qualquer Worker num domínio proxiado pela
 * Cloudflare (ver CLAUDE.md, princípio "Crawlers de IA ficam liberados nas
 * nossas superfícies"). Confirmado ao vivo em `cursos.diar.ia.br/robots.txt`
 * (#4546): `Disallow: /` pra Amazonbot, Applebot-Extended, Bytespider,
 * CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler, Google-Extended,
 * GPTBot e meta-externalagent.
 *
 * Decisão do editor (#4546, comentário 03/ago): liberar os 7 crawlers de
 * assistente/treino nos subdomínios de curadoria, alinhando com o host
 * principal `diar.ia.br` (Beehiiv), que não bloqueia nenhum deles — quem
 * pergunta a um assistente é a mesma consulta que já encontrou essas páginas
 * no Google, e o conteúdo é curadoria e link, não texto autoral das edições.
 * A remoção é SELETIVA, não geral: continuam bloqueados só Amazonbot (o host
 * principal já bloqueia; liberar seria mudança que ninguém pediu) e
 * CloudflareBrowserRenderingCrawler (infra de renderização, não assistente
 * — não faz sentido revisar via este princípio). `Content-Signal.ai-train`
 * sobe pra `yes`, refletindo a mesma liberação (o editor autorizou manter o
 * bloco, "com ai-train revisto pra refletir a decisão").
 *
 * `Sitemap:` aponta pro `/sitemap.xml` PRÓPRIO do host (não pro sitemap do
 * host principal) — fecha #4546 junto do sitemap em si: sem isso o Google
 * só descobre esses sitemaps por submissão manual/API.
 */

/** Bots que continuam bloqueados nos subdomínios de curadoria — ver docstring do módulo. */
export const CURADORIA_BLOCKED_BOTS = ["Amazonbot", "CloudflareBrowserRenderingCrawler"] as const;

/**
 * Monta o `robots.txt` de um Worker de curadoria. `sitemapUrl` é a URL
 * absoluta do `/sitemap.xml` PRÓPRIO daquele host (ex:
 * `https://cursos.diar.ia.br/sitemap.xml`) — nunca a do host principal.
 */
export function renderCuradoriaRobotsTxt(sitemapUrl: string): string {
  const blocks = CURADORIA_BLOCKED_BOTS.map((bot) => `User-agent: ${bot}\nDisallow: /`).join("\n\n");
  return `User-agent: *
Content-Signal: search=yes,ai-train=yes,use=reference
Allow: /

${blocks}

Sitemap: ${sitemapUrl}
`;
}
