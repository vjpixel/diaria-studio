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
 * Exit code 1 SÓ quando `pause_recommended === true` (degradação
 * sustentada de verdade detectada). Histórico insuficiente pra avaliar
 * (`analyzeCanaryTrend` com poucos pontos avaliáveis) sai com exit 0 —
 * NÃO é degradação, mas também não deve ler como "canário verde": o
 * texto impresso deixa claro que o veredito é "não avaliável ainda", e
 * `trigger-track-a-calibration.ts` (o único chamador automatizado deste
 * script) trata esse caso separadamente, nunca como sinal positivo.
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
    console.log(`pausar novas promoções de Track A: ${trend.pause_recommended ? "SIM" : "não"}`);
    for (const r of trend.reasons) console.log(`  - ${r}`);
  }

  process.exit(trend.pause_recommended ? 1 : 0);
}
