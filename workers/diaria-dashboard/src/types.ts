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

  /** Seções que ainda não têm dados disponíveis */
  stubs: StubSection[];
}
