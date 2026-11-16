#!/usr/bin/env npx tsx
/**
 * report-overnight-throughput.ts (#13271)
 *
 * CLI da leitura de vazão do overnight (`scripts/lib/overnight-throughput-report.ts`):
 * issues mergeadas por rodada e por hora, p50/p90 dos trechos do ciclo
 * (dispatch → PR → CI verde → merge), motivos de `pulada` e a cobertura dos
 * marcos do timeline. É a métrica de sucesso da #13271, lida com o mesmo
 * agregado antes e depois de cada mudança na rodada.
 *
 * Mesmo scan de `report-overnight-waves.ts` (diretórios `AAMMDD[a-z]?` de
 * `data/overnight/`, `--since` compara só o AAMMDD, plano ilegível é pulado).
 *
 * Uso:
 *   npx tsx scripts/report-overnight-throughput.ts --since 261023 [--top 10] [--json]
 *   npx tsx scripts/report-overnight-throughput.ts --plan data/overnight/{AAMMDD}/plan.json [--json]
 */
import { existsSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { aggregateThroughput, renderThroughputMarkdown } from "./lib/overnight-throughput-report.ts";
import { selectRounds } from "./report-overnight-waves.ts";

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const since = values.since;
  if (since && !/^\d{6}$/.test(since)) {
    console.error(`[report-overnight-throughput] --since exige AAMMDD (recebido: ${JSON.stringify(since)})`);
    process.exit(2);
  }
  if (values.plan && (since || values.dir)) {
    console.error("[report-overnight-throughput] --plan resume UMA rodada; não combina com --dir/--since");
    process.exit(2);
  }
  const top = values.top === undefined ? 10 : Number(values.top);
  if (!Number.isInteger(top) || top < 1) {
    console.error(`[report-overnight-throughput] --top exige inteiro >= 1 (recebido: ${JSON.stringify(values.top)})`);
    process.exit(2);
  }
  if (values.plan && !existsSync(values.plan)) {
    console.error(`[report-overnight-throughput] aviso: plan.json não encontrado em ${values.plan}`);
  }

  const rounds = selectRounds(values);
  const report = aggregateThroughput(rounds);
  if (flags.has("json")) {
    console.log(JSON.stringify({ rounds_dirs: rounds.map((r) => r.dir), ...report }, null, 2));
  } else {
    console.log(renderThroughputMarkdown(report, top));
  }
}
