/**
 * scripts/lib/calibration-reader-signal.ts (#7978, Camada 5 da #7972)
 *
 * Contra-sinal de LEITOR pro monitoramento pós-merge de uma calibração
 * (#7978 ponto 8: "check-calibration-regression.ts roda... mais um
 * contra-sinal de leitor: CTR real, unsubscribe, reclamação"). Puro —
 * recebe linhas já lidas de `data/link-ctr-table.csv`
 * (`date,unique_opens,unique_verified_clicks,...`, ver CLAUDE.md), nunca lê
 * disco. `scripts/check-calibration-regression.ts` é quem lê o CSV real e
 * chama isto.
 *
 * Métrica: CTR real médio (`unique_verified_clicks/unique_opens`,
 * agregado por dia — nunca `ctr_pct` da própria linha, que já é por
 * link/seção, não por dia) na janela ANTES de `appliedAt` vs. na janela
 * DEPOIS. Delta negativo grande é o sinal de alarme — não decide sozinho
 * se é a calibração ou ruído (#7972 já registra esse tipo de ambiguidade
 * como pendência editorial, não mecânica).
 */

export interface CtrRow {
  date: string; // YYYY-MM-DD
  unique_opens: number;
  unique_verified_clicks: number;
}

export interface ReaderSignalWindow {
  days: number;
  avg_ctr_pct: number | null;
  row_count: number;
}

export interface ReaderSignalDelta {
  before: ReaderSignalWindow;
  after: ReaderSignalWindow;
  /** `after.avg_ctr_pct - before.avg_ctr_pct`, em pontos percentuais. `null` se um dos dois lados não tiver dado suficiente. */
  delta_pp: number | null;
}

function ctrForDay(rows: readonly CtrRow[]): number | null {
  let opens = 0;
  let clicks = 0;
  for (const r of rows) {
    opens += r.unique_opens;
    clicks += r.unique_verified_clicks;
  }
  if (opens === 0) return null;
  return (clicks / opens) * 100;
}

/**
 * `windowDays` de cada lado de `appliedAtIso` (data ISO ou YYYY-MM-DD).
 * Linha no dia exato de `appliedAtIso` entra na janela DEPOIS (a
 * calibração já estava em produção naquele dia).
 */
export function computeReaderSignalDelta(rows: readonly CtrRow[], appliedAtIso: string, windowDays = 7): ReaderSignalDelta {
  const applied = new Date(appliedAtIso.slice(0, 10)).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const before: CtrRow[] = [];
  const after: CtrRow[] = [];
  for (const r of rows) {
    const t = new Date(r.date).getTime();
    if (Number.isNaN(t)) continue;
    const diffDays = (t - applied) / dayMs;
    if (diffDays < 0 && diffDays >= -windowDays) before.push(r);
    else if (diffDays >= 0 && diffDays < windowDays) after.push(r);
  }

  const beforeAvg = ctrForDay(before);
  const afterAvg = ctrForDay(after);

  return {
    before: { days: windowDays, avg_ctr_pct: beforeAvg, row_count: before.length },
    after: { days: windowDays, avg_ctr_pct: afterAvg, row_count: after.length },
    delta_pp: beforeAvg !== null && afterAvg !== null ? afterAvg - beforeAvg : null,
  };
}

/**
 * Limiar de alarme — queda de CTR ≥ `THRESHOLD_PP` pontos percentuais
 * conta como "regressão de leitor" candidata. Escolhido como uma
 * fração pequena e nomeada, não um valor mágico sem justificativa: o
 * corpus histórico ainda não tem NENHUMA calibração real pra calibrar
 * este limiar contra ruído natural dia-a-dia — pendência nomeada (#7978).
 * Revisitar assim que a 1ª calibração real passar por este monitor.
 */
export const READER_REGRESSION_THRESHOLD_PP = 1.0;

export function isReaderRegression(delta: ReaderSignalDelta): boolean {
  return delta.delta_pp !== null && delta.delta_pp <= -READER_REGRESSION_THRESHOLD_PP;
}
