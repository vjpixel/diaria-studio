#!/usr/bin/env tsx
/**
 * scripts/check-track-a-negative-impact-canary.ts (#7980, Fase 6 da #7972)
 *
 * CLI fina sobre `scripts/lib/track-a-negative-impact-canary.ts` — lê
 * `scoring-features.json` de toda edição disponível (via `loadEditionRows`,
 * já reusado por `calibration-power-report.ts`/`calibrate-scoring-
 * weights.ts` — mesma leitura de disco, sem duplicar o parsing; a
 * exigência de `01-approved.json` também presente que `loadEditionRows`
 * carrega junto é inofensiva aqui, os dois arquivos são sempre escritos
 * juntos no Stage 1 real), monta a série cronológica e decide se o
 * canário obrigatório do Track A (#7972 mitigação I-1) recomenda pausar
 * novas promoções.
 *
 * Rodar A CADA rodada de calibração do Track A — `trigger-track-a-
 * calibration.ts` chama isto antes de considerar qualquer candidato.
 * Também pode rodar isolado (monitoramento contínuo, análogo a
 * `check-calibration-regression.ts`).
 *
 * Uso:
 *   npx tsx scripts/check-track-a-negative-impact-canary.ts [--editions-dir DIR] [--json]
 *
 * Exit code 1 quando `pause_recommended === true` (degradação sustentada
 * de verdade detectada) OU `assessable === false` (histórico ainda
 * insuficiente) — fail-closed (achado de review do #7980, P1, alta
 * confiança: uma versão anterior deste script só falhava em
 * `pause_recommended`, e histórico insuficiente saía com exit 0,
 * indistinguível de "avaliado, sem degradação" pra quem só olhasse o
 * exit code — exatamente o cenário que um canário OBRIGATÓRIO não pode
 * deixar passar batido). `trigger-track-a-calibration.ts` usa o mesmo
 * campo `assessable` pra gate, não só o exit code deste CLI.
 */
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { loadEditionRows } from "./calibration-power-report.ts";
import { computeEditionCanary, analyzeCanaryTrend, type EditionCanaryPoint } from "./lib/track-a-negative-impact-canary.ts";

const ROOT = resolve(import.meta.dirname, "..");

export function computeCanarySeries(editionsRoot: string, topN = 15): EditionCanaryPoint[] {
  const { editions } = loadEditionRows(editionsRoot);
  return editions.map((ed) => computeEditionCanary(ed.edition, ed.rows, topN));
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const json = process.argv.includes("--json");

  const points = computeCanarySeries(editionsRoot);
  const trend = analyzeCanaryTrend(points);

  if (json) {
    console.log(JSON.stringify({ points, trend }, null, 2));
  } else {
    console.log(`[check-track-a-negative-impact-canary] ${points.length} edição(ões) na série.`);
    for (const p of points) {
      const rankLabel = p.avg_rank_among_finalists === null ? "n/d (sem negative_impact:true no pool)" : p.avg_rank_among_finalists.toFixed(2);
      console.log(`  ${p.edition}: rank médio=${rankLabel}  pool=${p.negative_impact_pool_count}  no top-N=${p.negative_impact_finalist_count}/${p.finalist_pool_size}`);
    }
    console.log("");
    console.log(`baseline: ${trend.baseline_avg_rank === null ? "n/d" : trend.baseline_avg_rank.toFixed(2)}`);
    console.log(`avaliável: ${trend.assessable ? "sim" : "NÃO (histórico insuficiente)"}`);
    console.log(`pausar novas promoções de Track A: ${trend.pause_recommended ? "SIM" : trend.assessable ? "não" : "N/A (ainda não avaliável — tratar como bloqueio, não como aprovação)"}`);
    for (const r of trend.reasons) console.log(`  - ${r}`);
  }

  // Fail-closed (achado de review do #7980, P1): "ainda não avaliável" bloqueia
  // igual a "degradação detectada" — nunca lido como canário verde. Mesmo
  // campo (`assessable`) que `trigger-track-a-calibration.ts` usa pra gate.
  process.exit(trend.pause_recommended || !trend.assessable ? 1 : 0);
}
