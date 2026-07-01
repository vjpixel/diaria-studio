/**
 * types.ts — Tipos compartilhados entre o worker e o script de build.
 *
 * O JSON agregado pelo script local (build-diaria-dashboard-data.ts) e
 * lido pelo Worker (index.ts) segue este schema. Exportado aqui para que
 * ambos os lados usem os mesmos tipos sem duplicação.
 */

// ─── Saúde das fontes (data/source-health.json + data/sources/*.jsonl) ────────

export interface SourceHealthEntry {
  name: string;
  slug: string;
  attempts: number;
  successes: number;
  failures: number;
  timeouts: number;
  /** Taxa de sucesso 0-100 */
  success_rate_pct: number;
  /** Streak de falhas duras consecutivas no fim do histórico */
  consecutive_failures: number;
  last_success_iso: string | null;
  last_failure_iso: string | null;
  last_duration_ms: number | null;
  /** "verde" | "amarelo" | "vermelho" */
  status: "verde" | "amarelo" | "vermelho";
}

// ─── CTR por edição (data/link-ctr-table.csv) ─────────────────────────────────

export interface CtrByCategoryRow {
  category: string;
  link_count: number;
  total_clicks: number;
  avg_ctr_pct: number;
  max_ctr_pct: number;
}

export interface CtrSummary {
  total_editions: number;
  total_links: number;
  top_categories: CtrByCategoryRow[];
  /** Top 10 links por CTR (unique_verified_clicks / unique_opens) */
  top_links: Array<{
    date: string;
    post_title: string;
    anchor: string;
    /**
     * Título do destaque resolvido a partir de 01-approved.json (#2556).
     * Populado quando anchor = "Aprofunde" (âncora genérica pré-mar/2026).
     * Null quando o join é lossy ou anchor já é o título (links novos).
     */
    highlight_title: string | null;
    base_url: string;
    category: string;
    ctr_pct: number;
    unique_verified_clicks: number;
  }>;
}

// ─── Timeline overnight (data/overnight/*/plan.json) ──────────────────────────

export interface OvernightRun {
  /** Diretório da rodada (ex: "260611") */
  edition: string;
  started_at: string | null;
  total_issues: number;
  merged: number;
  draft: number;
  pulada: number;
  in_progress: number;
  /** Duração total da rodada em ms (null se não finalizada ou sem timestamps) */
  duration_ms: number | null;
  /** Unidade mais lenta: label + duração em ms */
  slowest_unit: { label: string; duration_ms: number } | null;
}

// ─── Use Melhor por edição (data/editions/*/  _internal/01-approved.json + link-ctr-table.csv) ──

export interface UseMelhorItem {
  /** URL canônica do item (de approved.json — pode diferir da publicada) */
  url: string;
  title: string;
  /** CTR (%) — null se URL não foi encontrada no CSV (join lossy) */
  ctr_pct: number | null;
  /** Cliques únicos verificados — null se não encontrado no CSV */
  unique_verified_clicks: number | null;
}

export interface UseMelhorEditionEntry {
  /** AAMMDD da edição */
  edition: string;
  items: UseMelhorItem[];
  /** Quantos itens tinham match no CTR CSV */
  ctr_matched: number;
  /** Quantos itens NÃO tinham match (join lossy) */
  ctr_unmatched: number;
}

export interface UseMelhorSummary {
  /** Número de edições com pelo menos 1 item Use Melhor */
  total_editions_with_use_melhor: number;
  /** AAMMDD da primeira edição com Use Melhor */
  first_edition: string | null;
  /** Entradas por edição (mais recente primeiro) */
  editions: UseMelhorEditionEntry[];
  /** Top 10 itens por CTR (todos os tempos) */
  top_items: Array<{
    edition: string;
    url: string;
    title: string;
    ctr_pct: number;
    unique_verified_clicks: number;
  }>;
  /** Total de itens com match no CTR vs total publicados (cobertura do join) */
  coverage: {
    total_items: number;
    matched: number;
    unmatched: number;
    coverage_pct: number;
  };
}

// ─── Poll É IA? (workers/poll KV — push via script externo) ──────────────────

export interface PollEiaEditionEntry {
  /** AAMMDD */
  edition: string;
  /** Total de votos (sem votos de teste do editor) */
  total_votes: number;
  /** Votos na opção A */
  voted_a: number;
  /** Votos na opção B */
  voted_b: number;
  /** Porcentagem de acertos (null se abaixo do threshold ou resposta correta não configurada) */
  pct_correct: number | null;
  /** Qual opção era a correta ("A", "B", ou null se não configurado) */
  correct_choice: string | null;
  /** Contagem bruta de acertos — permite agregação mensal exata (#2773), em vez
   *  de aproximar via média ponderada de pct_correct já arredondado. */
  correct_count: number;
}

export interface PollEiaLeaderboardEntry {
  /** Nickname ou email (parcialmente mascarado) */
  display_name: string;
  /** Total de acertos */
  correct: number;
  /** Total de participações */
  total: number;
  /** Streak atual */
  streak: number;
}

export interface PollEiaSummary {
  /** Fonte dos dados (para rastreabilidade) */
  source: "push" | "stub";
  /** AAMMDD da última edição com dados de poll */
  last_edition: string | null;
  /** Entradas por edição (mais recente primeiro, máx 20) */
  editions: PollEiaEditionEntry[];
  /** Top 10 do leaderboard (votos de teste do editor excluídos) */
  leaderboard: PollEiaLeaderboardEntry[];
  /** Timestamp da última atualização dos dados */
  updated_at: string | null;
}

// ─── Top links por cliques absolutos — últimas 5 edições (#2558) ─────────────

export interface TopClickedRecentItem {
  /** Data da edição (AAMMDD) */
  edition: string;
  /** Título da edição (post_title do CSV) */
  post_title: string;
  /** Âncora do link (anchor do CSV) */
  anchor: string;
  /** URL base do link */
  base_url: string;
  /** Categoria do link */
  category: string;
  /** Cliques únicos verificados */
  unique_verified_clicks: number;
}

export interface TopClickedRecentSummary {
  /** As últimas 5 edições (AAMMDD) usadas como janela */
  window_editions: string[];
  /** Top 10 links por cliques absolutos nas últimas 5 edições */
  top_items: TopClickedRecentItem[];
}

// ─── Perfil de audiência (#2560) ─────────────────────────────────────────────

export interface AudienceCtrCategoryRow {
  category: string;
  ctr_pct: number;
  link_count: number;
}

export interface AudienceSurveyItem {
  label: string;
  weight: number;
  count: number;
}

export interface AudienceSummary {
  /** Data de atualização (YYYY-MM-DD) */
  updated_at: string | null;
  /** Assinantes ativos */
  subscribers: number | null;
  /** Respondentes do survey */
  survey_respondents: number | null;
  /** Links analisados */
  links_analyzed: number | null;
  /** CTR por categoria, ordenado por CTR desc */
  ctr_by_category: AudienceCtrCategoryRow[];
  /** CTR médio geral */
  avg_ctr_pct: number | null;
  /** Preferências declaradas de conteúdo (survey) */
  content_preferences: AudienceSurveyItem[];
  /** Nível de conhecimento em IA (survey) */
  knowledge_levels: AudienceSurveyItem[];
  /** Setores de atuação (survey) */
  sectors: AudienceSurveyItem[];
}

// ─── Seções stub (dados não disponíveis localmente ainda) ────────────────────

export interface StubSection {
  /** Identificador da seção stub */
  id: string;
  /** Descrição do que virá quando os dados estiverem disponíveis */
  description: string;
  /** Issue que implementará a fonte de dados */
  tracking_issue: string;
}

// ─── Payload final do KV ─────────────────────────────────────────────────────

export interface DashboardData {
  /** ISO timestamp da última agregação local */
  generated_at: string;
  /** Versão do schema (para detectar incompatibilidade no Worker) */
  schema_version: number;

  source_health: {
    entries: SourceHealthEntry[];
    total: number;
    verde: number;
    amarelo: number;
    vermelho: number;
    generated_at: string;
  };

  ctr: CtrSummary | null;

  overnight: {
    runs: OvernightRun[];
    total_runs: number;
  };

  /** Use Melhor histórico por edição — null se nenhuma edição com Use Melhor encontrada */
  use_melhor: UseMelhorSummary | null;

  /** Poll É IA? por edição — null se dados não disponíveis (requer push do workers/poll) */
  poll_eia: PollEiaSummary | null;

  /** Top 10 links por cliques absolutos nas últimas 5 edições — null se CSV ausente (#2558) */
  top_clicked_recent: TopClickedRecentSummary | null;

  /** Perfil de audiência extraído de context/audience-profile.md (#2560) — null se arquivo ausente */
  audience: AudienceSummary | null;

  /** Seções que ainda não têm dados disponíveis */
  stubs: StubSection[];
}
