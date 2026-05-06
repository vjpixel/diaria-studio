/**
 * article.ts (#650 Tier C) — tipos compartilhados de artigos editoriais.
 *
 * Antes deste módulo, `Article` estava definido em pelo menos 2 lugares com
 * shapes ligeiramente diferentes:
 * - `scripts/categorize.ts` (campos básicos)
 * - `scripts/render-categorized-md.ts` (mais campos: score, rank, highlight…)
 *
 * Esta é a definição canônica unificada. Outros scripts que precisarem de
 * subset específico podem usar `Pick<Article, ...>` ou criar alias local.
 */

/**
 * Estrutura canônica de artigo na pipeline editorial. Inclui todos os campos
 * potencialmente populados ao longo do pipeline (post-categorize, post-scorer,
 * post-enrichment).
 *
 * O escape hatch `[key: string]: unknown` é mantido por compatibilidade —
 * caller pode receber JSON com campos não-mapeados (debugging, novos hooks
 * sendo testados). Eliminar quando todos os usos forem migrados pra Zod
 * schemas estritos.
 */
export interface Article {
  /** URL canônico (já dedupado, normalizado) */
  url: string;

  // ---- Identificação básica ------------------------------------------------
  title?: string;
  summary?: string;
  /** Tipo declarado pela fonte (lançamento/pesquisa/notícia) — pista pra
   *  categorize.ts decidir bucket quando o domínio é ambíguo. */
  type_hint?: string;

  // ---- Datas (#496, #649) --------------------------------------------------
  /** Data de publicação no formato ISO 8601. */
  date?: string;
  /** Algumas pipelines gravam `published_at` em vez de `date`. */
  published_at?: string;
  /** True quando a data não pôde ser verificada via verify-dates (timeout, 403). */
  date_unverified?: boolean;

  // ---- Scoring (set pelo scorer) -------------------------------------------
  /** Score 0-100 atribuído pelo scorer. */
  score?: number;
  /** Marcador inline de destaque (formato legado pré-#229). */
  highlight?: boolean;
  /** Rank 1..6 do scorer (formato inline). */
  rank?: number;

  // ---- Origem do artigo ----------------------------------------------------
  /** True para artigos vindos de submissões do editor (inject-inbox-urls.ts). */
  editor_submitted?: boolean;
  /** True para artigos vindos de discovery-searcher (queries abertas). */
  discovered_source?: boolean;

  // ---- Enrichment (#487 — fonte primária) ----------------------------------
  /** Notícia que provavelmente cobre um lançamento e merece busca por fonte
   *  primária oficial. Setado por `enrich-primary-source.ts`. */
  launch_candidate?: boolean;
  /** Domínio sugerido pra buscar a fonte primária do lançamento. */
  suggested_primary_domain?: string;

  /** Escape hatch — campos não mapeados (debugging, hooks experimentais). */
  [key: string]: unknown;
}
