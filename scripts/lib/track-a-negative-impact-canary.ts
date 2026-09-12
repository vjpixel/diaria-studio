/**
 * scripts/lib/track-a-negative-impact-canary.ts (#7980, Fase 6 da #7972)
 *
 * Canário OBRIGATÓRIO do Track A (#7972 mitigação I-1): "Track A pode
 * aprender a evitar `negative_impact` via rejeição estrutural — feature
 * excluída do treino (allowlist, já garantido por
 * `NON_CALIBRATABLE_FEATURES`/`TRACK_A_CANDIDATE_FEATURES` nunca incluir
 * `negative_impact`), canário de rank médio de candidatos
 * `negative_impact:true` entre os 15 finalistas monitorado a cada rodada;
 * pausa de novas promoções de Track A se essa média cair de forma
 * sustentada."
 *
 * Puro — recebe `ScoringFeatureRow[]` já lido pelo chamador (mesmo padrão
 * de `calibration-power-report.ts`/`calibrate-scoring-weights.ts`: script
 * de I/O lê disco, módulo de lib só calcula).
 *
 * ## Por que "rank entre os top-N por `score`" e não "rank em
 * `tmp-finalists.json`" literalmente
 *
 * `tmp-finalists.json` (`merge-scored-chunks.ts`, os top-15 reais que o
 * `scorer-select` viu) é um arquivo `tmp-*` — não persistido além da
 * duração do Stage 1 de cada edição, então não existe histórico dele pra
 * medir uma série temporal. `scoring-features.json`, por outro lado, JÁ
 * persiste `score` por candidato pra toda edição com backfill rodado —
 * então "top-N por `score`, ordenado desc" é uma reconstrução
 * RETROATIVA razoável do que teria sido a lista de finalistas (mesmo
 * critério de ranking, mesmo N), documentada como proxy, nunca
 * apresentada como o `tmp-finalists.json` real daquela edição.
 *
 * ## Semântica de "rank" e de "cair de forma sustentada"
 *
 * Rank é 1-indexado dentro do top-N (1 = maior score) — MENOR rank é
 * MELHOR (mais visível, mais perto do topo). "A média cair" (degradar)
 * significa o rank médio dos negative_impact:true PIORAR — ou porque o
 * NÚMERO de rank aumenta (empurrados pra mais longe do topo dentro do
 * top-N), ou porque eles somem do top-N inteiramente (tratado como pior
 * caso possível, rank sintético = N+1, nunca como "não aplicável" — sumir
 * do top-N É a degradação que o canário existe pra pegar, não um dado
 * ausente). `avg_rank_among_finalists` só é `null` quando não há NENHUM
 * candidato `negative_impact:true` em TODO o pool daquela edição (nem no
 * top-N, nem fora) — nesse caso não há o que medir, `null` é honesto (não
 * um 0 que pareceria "rank perfeito").
 */

import type { ScoringFeatureRow } from "./scoring-features.ts";

export interface EditionCanaryPoint {
  edition: string;
  /** Rank médio (1-indexado, menor=melhor) dos candidatos negative_impact:true — usa N+1 (pior rank possível dentro do top-N) pra quem não entrou no top-N. `null` = não aplicável (nenhum candidato negative_impact:true em TODO o pool desta edição). */
  avg_rank_among_finalists: number | null;
  /** Quantos candidatos negative_impact:true existem no pool TOTAL desta edição (top-N ou não). */
  negative_impact_pool_count: number;
  /** Quantos desses estão DENTRO do top-N (finalist pool reconstruído). */
  negative_impact_finalist_count: number;
  finalist_pool_size: number;
}

/**
 * Calcula o ponto do canário pra 1 edição. `rows` = todas as linhas de
 * `scoring-features.json` daquela edição (pool inteiro, não só top-N —
 * a função reconstrói o top-N ordenando por `score` desc, `null` por
 * último, desempate determinístico por `url`).
 */
export function computeEditionCanary(edition: string, rows: readonly ScoringFeatureRow[], topN = 15): EditionCanaryPoint {
  const negativeImpactCount = rows.filter((r) => r.negative_impact === true).length;
  if (negativeImpactCount === 0) {
    return { edition, avg_rank_among_finalists: null, negative_impact_pool_count: 0, negative_impact_finalist_count: 0, finalist_pool_size: Math.min(topN, rows.length) };
  }

  const sorted = [...rows].sort((a, b) => {
    const scoreA = a.score ?? -Infinity;
    const scoreB = b.score ?? -Infinity;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.url.localeCompare(b.url); // desempate determinístico
  });
  const finalistPoolSize = Math.min(topN, sorted.length);

  const ranks: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].negative_impact !== true) continue;
    const rank = i < topN ? i + 1 : topN + 1; // fora do top-N = pior rank possível (topN+1), nunca "não avaliado"
    ranks.push(rank);
  }
  const negativeImpactFinalistCount = ranks.filter((r) => r <= topN).length;
  const avgRank = ranks.reduce((sum, r) => sum + r, 0) / ranks.length;

  return {
    edition,
    avg_rank_among_finalists: avgRank,
    negative_impact_pool_count: negativeImpactCount,
    negative_impact_finalist_count: negativeImpactFinalistCount,
    finalist_pool_size: finalistPoolSize,
  };
}

export interface CanaryTrendOptions {
  /** Quantas rodadas mais recentes contam como "sustentado" — default 3 (mesmo espírito do "3 edições sem reconhecimento" citado em check-calibration-regression.ts, #7978, ainda pendência lá; aqui já implementado porque o canário é avaliável desde a 1ª rodada, sem depender de nenhuma calibração real ter acontecido). */
  sustainedRounds?: number;
  /** Quantos pontos de rank (pior) acima da baseline conta como degradação real, não ruído — default 1.0 (1 posição de rank já é um efeito discreto neste contexto de N pequeno, top-15). */
  degradationThreshold?: number;
}

export interface CanaryTrendResult {
  baseline_avg_rank: number | null;
  recent_points: EditionCanaryPoint[];
  /** `true` sse as últimas `sustainedRounds` rodadas AVALIÁVEIS (avg_rank_among_finalists !== null) degradaram, TODAS, além do limiar em relação à baseline — ou sumiram do top-N (rank == N+1) em todas elas. */
  pause_recommended: boolean;
  reasons: string[];
}

/**
 * Analisa a série de pontos (1 por edição, cronológica) e decide se o
 * canário recomenda PAUSAR novas promoções de Track A. Puro,
 * determinístico — mesma lista de pontos sempre produz a mesma decisão.
 *
 * Baseline = média de `avg_rank_among_finalists` de TODOS os pontos
 * avaliáveis EXCETO as últimas `sustainedRounds` (histórico anterior à
 * janela recente que está sendo julgada — nunca a baseline inclui a
 * própria janela que está sendo comparada contra ela, senão a
 * comparação é circular). Pontos com `avg_rank_among_finalists === null`
 * (nenhum negative_impact naquela edição) são ignorados tanto na
 * baseline quanto na janela recente — não contam nem a favor nem contra
 * (não há o que medir).
 */
export function analyzeCanaryTrend(points: readonly EditionCanaryPoint[], opts: CanaryTrendOptions = {}): CanaryTrendResult {
  const sustainedRounds = opts.sustainedRounds ?? 3;
  const degradationThreshold = opts.degradationThreshold ?? 1.0;

  const evaluable = points.filter((p) => p.avg_rank_among_finalists !== null);
  if (evaluable.length <= sustainedRounds) {
    return {
      baseline_avg_rank: null,
      recent_points: evaluable.slice(-sustainedRounds),
      pause_recommended: false,
      reasons: [`histórico insuficiente (${evaluable.length} edição(ões) avaliável(is), precisa de mais que ${sustainedRounds} pra ter baseline + janela recente separadas) — canário não pode se pronunciar ainda, nunca lido como "sem degradação".`],
    };
  }

  const historical = evaluable.slice(0, evaluable.length - sustainedRounds);
  const recent = evaluable.slice(-sustainedRounds);
  const baseline = historical.reduce((sum, p) => sum + (p.avg_rank_among_finalists as number), 0) / historical.length;

  const degradedFlags = recent.map((p) => (p.avg_rank_among_finalists as number) - baseline > degradationThreshold);
  const allDegraded = degradedFlags.every(Boolean);

  const reasons: string[] = [];
  if (allDegraded) {
    reasons.push(
      `rank médio de negative_impact:true degradou (piorou) além do limiar de ${degradationThreshold} em TODAS as últimas ${sustainedRounds} rodadas avaliáveis vs. baseline histórica ${baseline.toFixed(2)} — pausar novas promoções de Track A até investigar.`,
    );
  }

  return { baseline_avg_rank: baseline, recent_points: recent, pause_recommended: allDegraded, reasons };
}
