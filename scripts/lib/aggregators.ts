/**
 * aggregators.ts
 *
 * Fonte única da lista de domínios/caminhos tratados como agregadores ou
 * roundup newsletters. A diar.ia.br nunca deve usar URLs destes domínios
 * como fonte primária — os subagentes de pesquisa devem extrair a URL
 * canônica do conteúdo original, ou descartar.
 *
 * Esta lista é espelhada como texto inline nos prompts de:
 *   - `.claude/agents/source-researcher.md`
 *   - `.claude/agents/discovery-searcher.md`
 *
 * Quando adicionar/remover um domínio aqui, atualizar também os prompts.
 * Os prompts usam a lista como instrução ao Haiku; este módulo é o
 * enforcement em código (safety net no dedup).
 */

/**
 * Hostnames (sem `www.`) que são agregadores ou roundups.
 */
export const AGGREGATOR_HOSTS = new Set<string>([
  // Agregadores clássicos
  "crescendo.ai",
  "flipboard.com",
  "techstartups.com",
  // Newsletters de roundup AI (curadoria/resumo de notícias alheias)
  "therundown.ai",
  "bensbites.co",
  "theneurondaily.com",
  "superhuman.ai",
  "theaipulse.beehiiv.com",
  "agentpulse.beehiiv.com",
  "aibreakfast.beehiiv.com",
  "alphasignal.ai",
  "archive.thedeepview.com",
  "recaply.co",
  "7min.ai",
  "track.newsletter.7min.ai",
  "evolvingai.io",
  "datamachina.com",
  "cyberman.ai",
  // Republishers BR de baixa qualidade editorial (reescrevem press releases sem análise própria)
  "docmanagement.com.br",
  // tldr.tech/ai tratado via AGGREGATOR_PATTERNS (o domínio raiz tem conteúdo primário)
]);

/**
 * Padrões (hostname+pathname, sem `www.`) para agregadores detectados por
 * caminho, não por hostname — ex: tldr.tech/ai é agregador mas tldr.tech/
 * em geral não é.
 */
export const AGGREGATOR_PATTERNS: RegExp[] = [/^tldr\.tech\/ai(\/|$)/i];

/**
 * #6440: nosso próprio host legado na Beehiiv (`diaria.beehiiv.com`, mais o
 * subdomínio de tracking `link.diaria.beehiiv.com`) — a única exceção ao
 * bloqueio blanket de `*.beehiiv.com` abaixo. `diar.ia.br` (custom domain,
 * host de marca) não é um `*.beehiiv.com` e não precisa de exceção aqui.
 */
const OUR_OWN_BEEHIIV_HOST = "diaria.beehiiv.com";

/**
 * #6440: newsletter de terceiro hospedada na Beehiiv (ex: `therundownai.
 * beehiiv.com/p/...`) é agregador — cobertura roundup de conteúdo alheio,
 * mesma classe editorial de `therundown.ai`/`bensbites.co`/etc já listados
 * acima. Antes só entradas individuais cadastradas manualmente pegavam isso
 * (`theaipulse.beehiiv.com` etc.) — qualquer subdomínio novo de terceiro
 * escapava até alguém adicionar à mão. Caso real 260828 (#6440):
 * `therundownai.beehiiv.com` chegou ao USE MELHOR sem bater nenhuma entrada
 * de `AGGREGATOR_HOSTS`. Bloqueio blanket: todo SUBDOMÍNIO de `*.beehiiv.com`
 * é agregador, exceto o nosso próprio host (`OUR_OWN_BEEHIIV_HOST`, acima).
 *
 * #6724: o domínio RAIZ `beehiiv.com`/`www.beehiiv.com` (página de marketing/
 * referral da própria Beehiiv, ex: link de disclosure `?via=Diaria` no bloco
 * "PARA ENCERRAR") NUNCA hospeda newsletter de terceiro — só subdomínios
 * hospedam conteúdo roundup. Bloquear a raiz produzia falso positivo no
 * nosso próprio link de referral. Checagem restrita a `host.endsWith(".beehiiv.com")`.
 */
function isThirdPartyBeehiivHost(host: string): boolean {
  const isBeehiivHost = host.endsWith(".beehiiv.com");
  if (!isBeehiivHost) return false;
  return host !== OUR_OWN_BEEHIIV_HOST && !host.endsWith("." + OUR_OWN_BEEHIIV_HOST);
}

/**
 * Retorna `true` se a URL deve ser tratada como agregador/roundup.
 */
export function isAggregator(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (AGGREGATOR_HOSTS.has(host)) return true;
    if (isThirdPartyBeehiivHost(host)) return true;
    const full = host + u.pathname;
    return AGGREGATOR_PATTERNS.some((p) => p.test(full));
  } catch {
    return false;
  }
}
