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
 *
 * #4777 estendeu o helper pros outros 3 Workers com host próprio (poll/
 * eia., artigo-mensal/artigo., artigos/especial.) que ficaram de fora do
 * #4546 (escopo daquela issue era sitemap de curadoria; o robots entrou só
 * como consequência dos 3 Workers que já eram estáticos):
 *
 *   - `sitemapUrl` agora é OPCIONAL — nem todo host tem `/sitemap.xml`
 *     próprio (ex: `eia.diar.ia.br`, jogo dinâmico por edição, não índice de
 *     conteúdo estático). Omitido, a linha `Sitemap:` simplesmente não
 *     aparece, em vez de forçar um valor incorreto.
 *   - `extraDisallowPaths` (opcional) bloqueia paths específicos pra TODOS
 *     os crawlers (`User-agent: *`), além do `Allow: /` geral — caso de uso
 *     concreto: `eia.diar.ia.br` bloqueia `/vote` (URLs de voto são
 *     rastreáveis a partir da versão web do post mas não têm valor de
 *     índice nenhum, só gastam rastreamento).
 *
 * Validação de forma (#4782 achado 5): `extraDisallowPaths` sem `/` inicial
 * viraria `Disallow: vote` (path relativo, semântica diferente do path
 * absoluto pretendido) silenciosamente — e `sitemapUrl` sem esquema viraria
 * uma `Sitemap:` que nenhum crawler consegue resolver. Os dois casos agora
 * lançam erro explícito na hora de montar o robots.txt, em vez de produzir
 * um arquivo publicado com o bug sem nenhum sinal.
 */

/** Bots que continuam bloqueados nos subdomínios de curadoria — ver docstring do módulo. */
export const CURADORIA_BLOCKED_BOTS = ["Amazonbot", "CloudflareBrowserRenderingCrawler"] as const;

export interface RenderCuradoriaRobotsTxtOptions {
  /**
   * Paths adicionais bloqueados pra TODOS os crawlers (`User-agent: *`),
   * além do `Allow: /` geral (#4777). Ex.: `["/vote"]` pra `eia.diar.ia.br`.
   */
  extraDisallowPaths?: readonly string[];
}

/**
 * Monta o `robots.txt` de um Worker de curadoria. `sitemapUrl`, quando
 * informado, é a URL absoluta do `/sitemap.xml` PRÓPRIO daquele host (ex:
 * `https://cursos.diar.ia.br/sitemap.xml`) — nunca a do host principal;
 * omitido (host sem sitemap próprio), a linha `Sitemap:` não é emitida.
 *
 * Lança `Error` (falha na hora de montar a constante, não em produção) se
 * `sitemapUrl` não for uma URL absoluta http(s) ou se algum
 * `extraDisallowPaths` não começar com `/` (#4782 achado 5).
 */
export function renderCuradoriaRobotsTxt(
  sitemapUrl?: string,
  options: RenderCuradoriaRobotsTxtOptions = {},
): string {
  const { extraDisallowPaths = [] } = options;
  if (sitemapUrl !== undefined && !/^https?:\/\//.test(sitemapUrl)) {
    throw new Error(
      `renderCuradoriaRobotsTxt: sitemapUrl deve ser uma URL absoluta http(s) — recebeu ${JSON.stringify(sitemapUrl)}.`,
    );
  }
  for (const path of extraDisallowPaths) {
    if (!path.startsWith("/")) {
      throw new Error(
        `renderCuradoriaRobotsTxt: extraDisallowPaths deve conter paths começando com "/" — recebeu ${JSON.stringify(path)} ` +
          `("Disallow: ${path}" sem a barra é um path relativo, não o path absoluto pretendido).`,
      );
    }
  }
  const blocks = CURADORIA_BLOCKED_BOTS.map((bot) => `User-agent: ${bot}\nDisallow: /`).join("\n\n");
  const extraDisallowLines = extraDisallowPaths.map((p) => `Disallow: ${p}`).join("\n");
  const allowSection = extraDisallowLines ? `Allow: /\n${extraDisallowLines}` : "Allow: /";
  const sitemapSection = sitemapUrl ? `\nSitemap: ${sitemapUrl}\n` : "";
  return `User-agent: *
Content-Signal: search=yes,ai-train=yes,use=reference
${allowSection}

${blocks}
${sitemapSection}`;
}

/**
 * Verifica o mínimo de correção de um `robots.txt` já renderizado: o bloco
 * `User-agent: *` declara `Allow: /` e NÃO declara um `Disallow: /` genérico
 * (que bloquearia tudo pra todo mundo — o mesmo efeito do default bloqueante
 * da Cloudflare que este módulo existe pra evitar). Não confunde com um
 * `Disallow: /algum-path` específico (ex: `/vote`), que é uma linha válida
 * dentro do mesmo bloco. Usado pelo guard de regressão (#4782 achado 2) —
 * antes ele só checava "arquivo não vazio", que um `robots.txt` estático
 * copiado do default bloqueante da Cloudflare também passaria.
 */
export function robotsTxtAllowsGeneralCrawling(robotsTxt: string): boolean {
  // Blocos separam-se por linha em branco (`\n\s*\n`) — mesma convenção do
  // formato robots.txt e do que `renderCuradoriaRobotsTxt` produz. Achar o
  // bloco inteiro do `User-agent: *` como string fixa (em vez de tentar
  // capturar seu fim via regex lazy + `$`) evita a armadilha de `$` com a
  // flag `m` casar fim-de-LINHA (qualquer `\n`), não fim-de-string — o que
  // fazia a versão anterior desta função capturar um corpo vazio sempre.
  const blocks = robotsTxt.split(/\n\s*\n/);
  const starBlock = blocks.find((b) => /^User-agent:\s*\*\s*$/m.test(b));
  if (!starBlock) return false;
  const hasAllowRoot = /^Allow:\s*\/\s*$/m.test(starBlock);
  const hasGenericDisallowRoot = /^Disallow:\s*\/\s*$/m.test(starBlock);
  return hasAllowRoot && !hasGenericDisallowRoot;
}
