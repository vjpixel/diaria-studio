/**
 * aggregator-blocklist.ts (#717 hypothesis #5)
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
 * `.claude/agents/source-researcher.md`. Quando adicionar/remover entradas
 * aqui, atualizar o prompt na mesma PR (e vice-versa).
 *
 * Estratégia de match: substring case-insensitive. Cobre tanto domínio puro
 * (`aibreakfast.beehiiv.com`) quanto path-prefix (`perplexity.ai/page/`),
 * sem precisar de regex separado por entrada.
 */

import { extractHost } from "./url-utils.ts";

export interface BlocklistEntry {
  /** Substring que ativa o block. Match case-insensitive em URL completa. */
  pattern: string;
  /** Categoria pra mensagem de log. */
  category:
    | "classic_aggregator"
    | "ai_roundup_newsletter"
    | "br_republisher"
    | "perplexity_non_primary";
}

/**
 * Lista canônica. Mantida em sync manual com source-researcher.md
 * (lista textual no prompt).
 */
export const AGGREGATOR_BLOCKLIST: readonly BlocklistEntry[] = [
  // Agregadores clássicos
  { pattern: "crescendo.ai", category: "classic_aggregator" },
  { pattern: "flipboard.com", category: "classic_aggregator" },
  { pattern: "techstartups.com", category: "classic_aggregator" },

  // Newsletters de roundup AI (curadoria/resumo)
  { pattern: "therundown.ai", category: "ai_roundup_newsletter" },
  { pattern: "tldr.tech/ai", category: "ai_roundup_newsletter" },
  { pattern: "bensbites.co", category: "ai_roundup_newsletter" },
  { pattern: "theneurondaily.com", category: "ai_roundup_newsletter" },
  { pattern: "superhuman.ai", category: "ai_roundup_newsletter" },
  { pattern: "theaipulse.beehiiv.com", category: "ai_roundup_newsletter" },
  { pattern: "agentpulse.beehiiv.com", category: "ai_roundup_newsletter" },
  { pattern: "aibreakfast.beehiiv.com", category: "ai_roundup_newsletter" },
  { pattern: "alphasignal.ai", category: "ai_roundup_newsletter" },
  { pattern: "archive.thedeepview.com", category: "ai_roundup_newsletter" },
  { pattern: "recaply.co", category: "ai_roundup_newsletter" },
  { pattern: "7min.ai", category: "ai_roundup_newsletter" },
  { pattern: "evolvingai.io", category: "ai_roundup_newsletter" },
  { pattern: "datamachina.com", category: "ai_roundup_newsletter" },
  { pattern: "cyberman.ai", category: "ai_roundup_newsletter" },

  // Republishers BR (reescrevem press releases sem análise própria)
  { pattern: "docmanagement.com.br", category: "br_republisher" },

  // Perplexity: bloqueado por padrão, exceto research.* e /hub/ (tratados em isPerplexityPrimary)
  { pattern: "perplexity.ai", category: "perplexity_non_primary" },
];

/**
 * Sub-paths/sub-domínios da Perplexity que SÃO fontes primárias (própria
 * Perplexity, não roundup de terceiros). Esses URLs escapam do block.
 */
const PERPLEXITY_PRIMARY_PATTERNS: readonly string[] = [
  "research.perplexity.ai",
  "perplexity.ai/hub/",
];

function isPerplexityPrimary(urlLower: string): boolean {
  return PERPLEXITY_PRIMARY_PATTERNS.some((p) => urlLower.includes(p));
}

export interface BlockResult {
  blocked: boolean;
  /** Categoria do match (presente quando blocked=true). */
  category?: BlocklistEntry["category"];
  /** Pattern que casou (presente quando blocked=true). */
  pattern?: string;
}

/**
 * Checa se uma URL é de fonte agregadora conhecida. Match substring
 * case-insensitive na URL completa (host + path).
 *
 * Regras especiais:
 * - perplexity.ai bloqueado, exceto sub-paths/domains primários
 *   (research.perplexity.ai, /hub/).
 *
 * Retorna `{ blocked: false }` quando URL inválida (defensive — caller
 * decide se loga ou não).
 */
export function isAggregator(url: string): BlockResult {
  if (typeof url !== "string" || url.length === 0) return { blocked: false };

  const lower = url.toLowerCase();

  // Perplexity primary paths escapam do block
  if (isPerplexityPrimary(lower)) return { blocked: false };

  for (const entry of AGGREGATOR_BLOCKLIST) {
    if (lower.includes(entry.pattern.toLowerCase())) {
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
  skipped: Array<Source & { category: BlocklistEntry["category"]; pattern: string }>;
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

// Re-export pra ergonomia em quem importa
export { extractHost };
