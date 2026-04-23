/**
 * aggregators.ts
 *
 * Fonte única da lista de domínios/caminhos tratados como agregadores ou
 * roundup newsletters. A Diar.ia nunca deve usar URLs destes domínios
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
 * Retorna `true` se a URL deve ser tratada como agregador/roundup.
 */
export function isAggregator(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (AGGREGATOR_HOSTS.has(host)) return true;
    const full = host + u.pathname;
    return AGGREGATOR_PATTERNS.some((p) => p.test(full));
  } catch {
    return false;
  }
}
