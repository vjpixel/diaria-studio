/**
 * aggregator-blocklist.ts (#717 hypothesis #5, hardened in #838)
 *
 * Lista canônica dos domínios/paths que `source-researcher` (Haiku) já trata
 * como agregadores e nunca retorna como URL primária. Quando uma fonte
 * cadastrada bate nesta lista, dispatchar o agent é desperdício — ele vai
 * gastar 1 WebSearch + ~5 WebFetch e voltar com `articles: []`.
 *
 * Pre-flight check em `orchestrator-stage-1-research.md` (step 1f) usa esta
 * lib pra pular dispatch antes de gastar Haiku tokens. Source-researcher.md
 * mantém a lista pra fallback se algum URL escapa do filtro determinístico.
 *
 * IMPORTANTE: lista deve ficar sincronizada com o agent prompt em
 * `.claude/agents/source-researcher.md`. Drift é detectado por
 * `test/aggregator-blocklist.test.ts` (#838).
 *
 * Estratégia de match (#838 hardening): match estrutural via parsing de URL
 * (hostname + pathname), não substring. Isso previne false-positives onde
 * `techstartups.com` matcharia `sometechstartups.com.fakedomain.com`,
 * `perplexity.ai` matcharia `perplexity.airline.com`, etc.
 */

import { extractHost } from "./url-utils.ts";

/**
 * Tipo da entrada determina semântica de match:
 *
 * - **`domain`**: pattern é hostname (ex: `crescendo.ai`,
 *   `aibreakfast.beehiiv.com`). Matcha quando `extractHost(url) === pattern`
 *   OU quando o host é um subdomínio (`extractHost(url).endsWith("." + pattern)`).
 *   Não matcha hosts que só compartilham sufixo textual (`fake-crescendo.ai`).
 *
 * - **`path_prefix`**: pattern é `host/path-prefix` (ex: `tldr.tech/ai`).
 *   Matcha quando `extractHost === host` E `pathname === /path` ou
 *   `pathname.startsWith("/path/")`. Não matcha `/path-something-else`
 *   como path completo.
 */
export interface DomainBlocklistEntry {
  type: "domain";
  pattern: string;
  category: BlocklistCategory;
}

export interface PathPrefixBlocklistEntry {
  type: "path_prefix";
  pattern: string;
  category: BlocklistCategory;
}

export type BlocklistEntry = DomainBlocklistEntry | PathPrefixBlocklistEntry;

export type BlocklistCategory =
  | "classic_aggregator"
  | "ai_roundup_newsletter"
  | "br_republisher"
  | "perplexity_non_primary";

/**
 * Lista canônica. Mantida em sync manual com source-researcher.md
 * (lista textual no prompt). Drift detectado por test em CI (#838).
 */
export const AGGREGATOR_BLOCKLIST: readonly BlocklistEntry[] = [
  // Agregadores clássicos
  { type: "domain", pattern: "crescendo.ai", category: "classic_aggregator" },
  { type: "domain", pattern: "flipboard.com", category: "classic_aggregator" },
  { type: "domain", pattern: "techstartups.com", category: "classic_aggregator" },

  // Newsletters de roundup AI (curadoria/resumo)
  { type: "domain", pattern: "therundown.ai", category: "ai_roundup_newsletter" },
  { type: "path_prefix", pattern: "tldr.tech/ai", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "bensbites.co", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "theneurondaily.com", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "superhuman.ai", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "theaipulse.beehiiv.com", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "agentpulse.beehiiv.com", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "aibreakfast.beehiiv.com", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "alphasignal.ai", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "archive.thedeepview.com", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "recaply.co", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "7min.ai", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "evolvingai.io", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "datamachina.com", category: "ai_roundup_newsletter" },
  { type: "domain", pattern: "cyberman.ai", category: "ai_roundup_newsletter" },

  // Republishers BR (reescrevem press releases sem análise própria)
  { type: "domain", pattern: "docmanagement.com.br", category: "br_republisher" },

  // Perplexity: bloqueado por padrão, exceto research.* e /hub/ (escape em isPerplexityPrimary)
  { type: "domain", pattern: "perplexity.ai", category: "perplexity_non_primary" },
];

/**
 * Sub-paths/sub-domínios da Perplexity que SÃO fontes primárias (própria
 * Perplexity, não roundup de terceiros). Esses URLs escapam do block.
 *
 * Atenção: o teste de drift em `test/aggregator-blocklist.test.ts`
 * referencia `research.perplexity.ai` e `/hub/` por nome — manter sincronizado.
 */
function isPerplexityPrimary(host: string, pathname: string): boolean {
  if (host === "research.perplexity.ai") return true;
  if (host === "perplexity.ai" || host.endsWith(".perplexity.ai")) {
    if (pathname === "/hub" || pathname.startsWith("/hub/")) return true;
  }
  return false;
}

export interface BlockResult {
  blocked: boolean;
  /** Categoria do match (presente quando blocked=true). */
  category?: BlocklistCategory;
  /** Pattern que casou (presente quando blocked=true). */
  pattern?: string;
}

/**
 * Match domain entry: host === pattern ou host é subdomínio do pattern.
 */
function matchesDomain(host: string, pattern: string): boolean {
  if (host === pattern) return true;
  if (host.endsWith("." + pattern)) return true;
  return false;
}

/**
 * Match path_prefix entry: pattern = "host/path", host bate exato e
 * pathname é o path exato ou começa com path + "/".
 */
function matchesPathPrefix(host: string, pathname: string, pattern: string): boolean {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx < 0) return false; // pattern malformado: requer "/"
  const patternHost = pattern.slice(0, slashIdx);
  const patternPath = pattern.slice(slashIdx); // includes leading "/"
  if (host !== patternHost) return false;
  if (pathname === patternPath) return true;
  if (pathname.startsWith(patternPath + "/")) return true;
  return false;
}

/**
 * Checa se uma URL é de fonte agregadora conhecida. Match estrutural
 * via URL parsing — host (com suporte a subdomínio) ou host+path-prefix.
 *
 * Regras especiais:
 * - perplexity.ai bloqueado, exceto sub-paths/domains primários
 *   (research.perplexity.ai, /hub/).
 *
 * Retorna `{ blocked: false }` quando URL é inválida (defensive — caller
 * decide se loga ou não).
 */
export function isAggregator(url: string): BlockResult {
  if (typeof url !== "string" || url.length === 0) return { blocked: false };

  const host = extractHost(url);
  if (host === null) return { blocked: false };
  const hostLower = host.toLowerCase();

  let pathname: string;
  try {
    pathname = new URL(url).pathname || "/";
  } catch {
    return { blocked: false };
  }
  const pathLower = pathname.toLowerCase();

  // Perplexity primary paths escapam do block
  if (isPerplexityPrimary(hostLower, pathLower)) return { blocked: false };

  for (const entry of AGGREGATOR_BLOCKLIST) {
    const patternLower = entry.pattern.toLowerCase();
    const matched =
      entry.type === "domain"
        ? matchesDomain(hostLower, patternLower)
        : matchesPathPrefix(hostLower, pathLower, patternLower);
    if (matched) {
      return {
        blocked: true,
        category: entry.category,
        pattern: entry.pattern,
      };
    }
  }

  return { blocked: false };
}

/**
 * Conveniência: dada uma lista de fontes `{name, url}`, separa em
 * `kept` (não bloqueadas) e `skipped` (bloqueadas com motivo).
 */
export interface Source {
  name: string;
  url: string;
}

export interface FilterResult {
  kept: Source[];
  skipped: Array<Source & { category: BlocklistCategory; pattern: string }>;
}

export function filterSources(sources: Source[]): FilterResult {
  const kept: Source[] = [];
  const skipped: FilterResult["skipped"] = [];
  for (const s of sources) {
    const result = isAggregator(s.url);
    if (result.blocked) {
      skipped.push({
        ...s,
        category: result.category!,
        pattern: result.pattern!,
      });
    } else {
      kept.push(s);
    }
  }
  return { kept, skipped };
}
