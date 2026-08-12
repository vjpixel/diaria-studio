/**
 * robots-txt.ts (#4546)
 *
 * `robots.txt` PRÓPRIO pros Workers de curadoria (cursos, livros, arquivo) —
 * roda ao lado do robots.txt DEFAULT gerenciado pela Cloudflare, que bloqueia
 * 9 crawlers via `Disallow: /` sem que ninguém tenha escolhido isso: é o
 * comportamento nativo de qualquer Worker num domínio proxiado pela
 * Cloudflare (ver CLAUDE.md, princípio "Crawlers de IA ficam liberados nas
 * nossas superfícies"). Confirmado ao vivo em `cursos.diar.ia.br/robots.txt`
 * (#4546): `Disallow: /` pra Amazonbot, Applebot-Extended, Bytespider,
 * CCBot, ClaudeBot, CloudflareBrowserRenderingCrawler, Google-Extended,
 * GPTBot e meta-externalagent.
 *
 * **Correção (#4910, 10/08/2026): este robots.txt NÃO substitui o bloco
 * gerenciado da Cloudflare — é ANEXADO depois dele, no mesmo arquivo
 * servido.** Verificado ao vivo nos 6 Workers com host público: os 6
 * respondem HTTP 200 e servem o delimitador `# BEGIN Cloudflare Managed
 * content`, com 11 linhas `Disallow: /` no total, nesta ordem — as 9 do
 * bloco gerenciado da Cloudflare vêm PRIMEIRO, as 2 deste módulo
 * (`CURADORIA_BLOCKED_BOTS`, abaixo) vêm DEPOIS. Como um grupo
 * `User-agent:` nomeado vence o curinga `*` por especificidade (RFC 9309),
 * os 7 crawlers que o #4546 quis liberar (GPTBot, ClaudeBot, CCBot,
 * Google-Extended, Bytespider, meta-externalagent, Applebot-Extended)
 * continuam com `Disallow: /` vindo do bloco da Cloudflare — servir este
 * arquivo próprio não desfaz isso; os dois blocos convivem, e o arquivo
 * final chega a ter dois grupos `User-agent: *` com `Content-Signal`
 * contraditório entre si (`ai-train=no` no da Cloudflare, `ai-train=yes`
 * no deste módulo).
 *
 * Por que o efeito prático de #4546 não quebra mesmo assim: o objetivo
 * daquela decisão nunca foi "destravar citação" — quem de fato governa
 * recuperação/citação por assistente (OAI-SearchBot, Claude-SearchBot,
 * PerplexityBot, Googlebot, Bingbot) não está bloqueado em nenhum dos dois
 * blocos, então cai no `User-agent: *` com `Allow: /` e lê o conteúdo
 * normalmente. O que de fato NÃO se concretiza é a intenção declarada
 * sobre corpus de treino/Common Crawl pros 7 crawlers acima — bloqueio de
 * plataforma, não deste código, que só um desligamento do robots.txt
 * gerenciado nas configurações da zona Cloudflare resolve (ação de
 * dashboard do editor, fora deste módulo; ver #4910 pra um smoke-test
 * agendado que audita o arquivo SERVIDO, não só o que este módulo produz).
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
 *
 * `feedUrl` (opcional, #5127) declara o feed RSS/Atom do host junto do
 * `Sitemap:`, via a linha não-padrão `Feed:` — não existe diretiva oficial
 * de feed no protocolo robots.txt (RFC 9309 só define `Sitemap:`), mas é uma
 * convenção informal que alguns agregadores já leem, e é o que a issue
 * #5127 item 4 pede explicitamente ("declarar o feed no robots.txt, junto
 * ao Sitemap: já existente"). Mesma validação de forma de `sitemapUrl`
 * (precisa ser URL absoluta http(s)); omitido, nenhuma linha `Feed:`
 * aparece — hoje só `arquivo.diar.ia.br` passa isso (é o único host com
 * `/feed.xml`).
 */

/** Bots que continuam bloqueados nos subdomínios de curadoria — ver docstring do módulo. */
export const CURADORIA_BLOCKED_BOTS = ["Amazonbot", "CloudflareBrowserRenderingCrawler"] as const;

export interface RenderCuradoriaRobotsTxtOptions {
  /**
   * Paths adicionais bloqueados pra TODOS os crawlers (`User-agent: *`),
   * além do `Allow: /` geral (#4777). Ex.: `["/vote"]` pra `eia.diar.ia.br`.
   * Tipo `` `/${string}` `` pega em `tsc` o erro de path relativo sem barra
   * inicial que a validação em runtime abaixo também recusa (#4782 achado 5).
   */
  extraDisallowPaths?: readonly `/${string}`[];
  /** URL absoluta do feed RSS/Atom PRÓPRIO daquele host (#5127) — ver nota
   * `feedUrl` na docstring do módulo. Omitido: nenhuma linha `Feed:` é
   * emitida. */
  feedUrl?: string;
}

/**
 * Monta o `robots.txt` de um Worker de curadoria. `sitemapUrl`, quando
 * informado, é a URL absoluta do `/sitemap.xml` PRÓPRIO daquele host (ex:
 * `https://cursos.diar.ia.br/sitemap.xml`) — nunca a do host principal;
 * omitido (host sem sitemap próprio), a linha `Sitemap:` não é emitida.
 * `options.feedUrl` (#5127), quando informado, declara `Feed:` junto —
 * ver docstring do módulo.
 *
 * Lança `Error` (falha na hora de montar a constante, não em produção) se
 * `sitemapUrl`/`feedUrl` não forem URLs absolutas http(s) ou se algum
 * `extraDisallowPaths` não começar com `/` (#4782 achado 5).
 */
export function renderCuradoriaRobotsTxt(
  sitemapUrl?: string,
  options: RenderCuradoriaRobotsTxtOptions = {},
): string {
  const { extraDisallowPaths = [], feedUrl } = options;
  if (sitemapUrl !== undefined && !/^https?:\/\//.test(sitemapUrl)) {
    throw new Error(
      `renderCuradoriaRobotsTxt: sitemapUrl deve ser uma URL absoluta http(s) — recebeu ${JSON.stringify(sitemapUrl)}.`,
    );
  }
  if (feedUrl !== undefined && !/^https?:\/\//.test(feedUrl)) {
    throw new Error(
      `renderCuradoriaRobotsTxt: feedUrl deve ser uma URL absoluta http(s) — recebeu ${JSON.stringify(feedUrl)}.`,
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
  const sitemapLine = sitemapUrl ? `Sitemap: ${sitemapUrl}\n` : "";
  const feedLine = feedUrl ? `Feed: ${feedUrl}\n` : "";
  const sitemapSection = sitemapLine || feedLine ? `\n${sitemapLine}${feedLine}` : "";
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
  // fazia um primeiro rascunho desta função (descartado ainda no design,
  // nunca commitado) capturar um corpo vazio sempre.
  const blocks = robotsTxt.split(/\n\s*\n/);
  const starBlock = blocks.find((b) => /^User-agent:\s*\*\s*$/m.test(b));
  if (!starBlock) return false;
  const hasAllowRoot = /^Allow:\s*\/\s*$/m.test(starBlock);
  const hasGenericDisallowRoot = /^Disallow:\s*\/\s*$/m.test(starBlock);
  return hasAllowRoot && !hasGenericDisallowRoot;
}
