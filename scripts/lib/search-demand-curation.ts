/**
 * search-demand-curation.ts (#8370 Peça 1)
 *
 * Demanda de busca real (Google Keyword Planner, #8366/#8476) como FONTE de
 * queries de discovery — complementa (não substitui) as ~10 queries estáticas
 * PT/EN escritas à mão + how-to (#2278) + impacto-negativo (#3916/#3918).
 *
 * Contexto (issue #8370): os 3 sinais que o scorer usa (formulário, CTR por
 * categoria, as 49 fontes cadastradas) são todos ENDÓGENOS — derivam de
 * escolhas editoriais anteriores e fecham um loop de reforço (big-tech foi de
 * 26% pra 67% dos destaques). O `discovery-searcher` é o único mecanismo
 * exógeno da pipeline, mas as queries que ele roda são estáticas. Esta peça
 * injeta um sinal genuinamente exógeno: termos que o público de fato busca no
 * Google, filtrados pra NICHO (não pra volume de marca, que reforçaria o
 * mesmo loop — ver `docs`/comentário 18/09/2026 na issue).
 *
 * Filtro de elegibilidade (decidido na issue, não escolha deste módulo):
 *   competição LOW/MEDIUM + volume médio mensal entre ~200 e ~5.000/mês —
 *   nicho alcançável, não o topo de marca (`gemini` = 30,4M/mês é ruído de
 *   marca, `impactos da ia no mercado de trabalho` = 480/mês LOW é o alvo).
 *
 * Fail-soft por completo: sem `data/seo/google-keywords-*.json` (Keyword
 * Planner nunca rodou, ou rodou e falhou), retorna `[]` — nunca lança, nunca
 * bloqueia o Stage 1 (mesmo padrão de `getHowToDiscoveryQueries`/
 * `getNegativeImpactDiscoveryQueries`, que também nunca faltam uma edição).
 *
 * Puro por padrão (`filterDemandKeywords`, `pickSearchDemandDiscoveryQueries`);
 * as duas funções de I/O (`findLatestKeywordPlannerFile`,
 * `loadSearchDemandIdeas`) ficam isoladas no fim do arquivo.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { KeywordIdea } from "./google-keyword-planner.ts";

/** Nicho alcançável — abaixo disso o termo não sustenta um destaque; acima,
 *  é volume de marca/celebridade que reforça o mesmo loop que a issue quer
 *  quebrar (ver #8370, "Por que demanda de busca NÃO entra como peso no
 *  score" — o raciocínio vale igual pra seleção de query de discovery). */
export const SEARCH_DEMAND_MIN_VOLUME = 200;
export const SEARCH_DEMAND_MAX_VOLUME = 5000;

const ELIGIBLE_COMPETITION = new Set(["LOW", "MEDIUM"]);

/** Nome do arquivo diário gerado por `google-keyword-pull.ts`. */
const KEYWORD_FILE_RE = /^google-keywords-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Filtra ideias de keyword pelo critério de elegibilidade da Peça 1: LOW/MEDIUM
 * + volume no range de nicho. `avgMonthlySearches: null` (Google não devolveu
 * volume) é descartado — sem volume não há como confirmar que é nicho, não
 * ruído. Puro.
 */
export function filterDemandKeywords(
  ideas: readonly KeywordIdea[],
  opts: { minVolume?: number; maxVolume?: number } = {},
): KeywordIdea[] {
  const min = opts.minVolume ?? SEARCH_DEMAND_MIN_VOLUME;
  const max = opts.maxVolume ?? SEARCH_DEMAND_MAX_VOLUME;
  return ideas.filter((idea) => {
    if (!ELIGIBLE_COMPETITION.has(idea.competition)) return false;
    if (idea.avgMonthlySearches === null) return false;
    return idea.avgMonthlySearches >= min && idea.avgMonthlySearches <= max;
  });
}

/**
 * Escolhe `count` termos elegíveis para virar query de discovery nesta edição.
 * Rotação pseudo-determinística por `editionNum` — mesmo esquema de
 * `getHowToDiscoveryQueries`/`getNegativeImpactDiscoveryQueries`: varia dia a
 * dia sem repetir sempre o mesmo termo, sem precisar de estado entre edições.
 * Ordena por volume desc antes de rotacionar, pra que o índice seja estável
 * entre chamadas com o mesmo input (dedup/sort não é determinístico vindo da
 * API crua). Puro.
 */
export function pickSearchDemandDiscoveryQueries(
  ideas: readonly KeywordIdea[],
  editionNum: number,
  count = 2,
  opts: { minVolume?: number; maxVolume?: number } = {},
): string[] {
  const eligible = filterDemandKeywords(ideas, opts)
    .slice()
    .sort((a, b) => (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0));
  const total = eligible.length;
  if (total === 0) return [];
  const safeBase = Number.isFinite(editionNum) ? editionNum : 0;
  const safeCount = Math.min(count, total);
  const queries: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < safeCount; i++) {
    const idx = (safeBase + i) % total;
    if (seen.has(idx)) continue; // clamp já evita isso, defesa extra.
    seen.add(idx);
    queries.push(eligible[idx].keyword);
  }
  return queries;
}

// ---------------------------------------------------------------------------
// I/O — isolado do miolo puro acima.
// ---------------------------------------------------------------------------

/**
 * Acha o `data/seo/google-keywords-{YYYY-MM-DD}.json` mais recente (por data
 * no nome do arquivo, não mtime — reprodutível independente de quando o
 * arquivo foi tocado no disco). `null` se o diretório não existe ou está
 * vazio — nunca lança (#738-adjacent: ausência de pull mensal não é MCP
 * indisponível, é apenas "ainda não rodou este mês").
 */
export function findLatestKeywordPlannerFile(
  rootDir: string,
  dirRel = "data/seo",
): string | null {
  const dirAbs = resolve(rootDir, dirRel);
  if (!existsSync(dirAbs)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return null;
  }
  const dated = entries
    .map((name) => ({ name, match: name.match(KEYWORD_FILE_RE) }))
    .filter((e): e is { name: string; match: RegExpMatchArray } => e.match !== null)
    .sort((a, b) => (a.match[1] < b.match[1] ? 1 : a.match[1] > b.match[1] ? -1 : 0));
  if (dated.length === 0) return null;
  return resolve(dirAbs, dated[0].name);
}

/**
 * Lê o pull mais recente e devolve `kept` (já filtrado de ruído de marca por
 * `partitionIdeas` no momento do pull — ver `google-keyword-pull.ts`). Fail-soft
 * total: arquivo ausente, ilegível ou com shape inesperado vira `[]`.
 */
export function loadSearchDemandIdeas(rootDir: string, dirRel = "data/seo"): KeywordIdea[] {
  const path = findLatestKeywordPlannerFile(rootDir, dirRel);
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { kept?: unknown };
    return Array.isArray(parsed.kept) ? (parsed.kept as KeywordIdea[]) : [];
  } catch {
    return [];
  }
}
