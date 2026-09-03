#!/usr/bin/env node
/**
 * scripts/metrics-cli.ts (#7295)
 *
 * 1º script de PRODUÇÃO a importar `lib/metrics/registry` — antes desta
 * issue, nenhum importava (só `test/metrics-registry.test.ts` e
 * `test/metrics-metas.test.ts` exercitavam o registry, achado central da
 * #7295). Fecha o gap: computa as 4 métricas de AQUISIÇÃO (`cadastros-dia`
 * e as 3 derivadas) para uma janela, wireando `AcquisitionMetricDeps` a
 * partir do store real (`scripts/lib/metrics/acquisition-store-deps.ts`) —
 * inclusive `subscriptionCoverageLow`, que antes só chegava a um
 * `console.warn` inline dentro de `getStoreCounts` e nunca virava
 * `qualidade: 'indeterminado'` em lugar nenhum.
 *
 * Uso:
 *   npx tsx scripts/metrics-cli.ts [--de AAAA-MM-DD] [--ate AAAA-MM-DD] [--db <path>] [--json]
 *
 * Sem `--de`/`--ate`, a janela é o dia de hoje em BRT. Stdout: tabela (ou
 * JSON com `--json`) com 1 linha por métrica de aquisição — `valor`,
 * `qualidade`, `motivo`. Exit 0 sempre que o cálculo roda (mesmo
 * `indeterminado` é resultado válido, nunca erro) — exit 1 só se `data/`
 * estiver ausente ou o store não abrir.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { buildAcquisitionDepsFromStore, brtDayKey } from "./lib/metrics/acquisition-store-deps.ts";
import type { CapturaLogEntry } from "./lib/metrics/captura-log.ts";
import { getMetric, type Janela } from "./lib/metrics/registry.ts";

/** Mesmo path que `diaria-subscribers-ingest-kit.ts` usa (`DEFAULT_CAPTURA_LOG_PATH`)
 *  — recomputado aqui em vez de importado para não puxar o CLI de ingestão
 *  inteiro (com seu próprio parsing de argv) só por uma constante de path. */
function defaultCapturaLogPath(dbPath: string): string {
  return resolve(dirname(dbPath), "..", "metrics", "captura-log.jsonl");
}

/** Lê `captura-log.jsonl` linha a linha — arquivo ausente (nenhuma captura
 *  rodou ainda) é `[]`, nunca erro: o guard de `hasCaptureOnDay` já trata
 *  isso como "dia sem coleta" → `indeterminado`. */
function readCapturaLog(path: string): CapturaLogEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const entries: CapturaLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as CapturaLogEntry);
    } catch {
      // Linha corrompida (escrita parcial concorrente) — pulada, não aborta
      // o resto da leitura. Mesmo espírito fail-soft do resto do épico.
    }
  }
  return entries;
}

const ACQUISITION_METRIC_IDS = [
  "cadastros-dia",
  "cadastros-nao-pago-nao-reativacao-dia",
  "cadastros-organicos-dia",
  "cadastros-indeterminados-dia",
] as const;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dataRoot = dirname(dirname(dbPath));
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot}`);
    console.error("   (data/ mora no OneDrive como junction — ver CLAUDE.md setup, passo 2b)");
    process.exit(1);
  }

  const hoje = brtDayKey(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  const de = getArg(argv, "de") || hoje;
  const ate = getArg(argv, "ate") || de;
  const janela: Janela = { de, ate, granularidade: "dia", fuso: "BRT" };

  let db: ReturnType<typeof openDiariaSubscribersDb>;
  try {
    db = openDiariaSubscribersDb(dbPath);
  } catch (err) {
    console.error(`❌ não foi possível abrir o store (${dbPath}): ${(err as Error).message}`);
    process.exit(1);
  }

  const capturaLog = readCapturaLog(defaultCapturaLogPath(dbPath));
  const deps = buildAcquisitionDepsFromStore(db, capturaLog);

  const results: Array<{ id: string; valor: number | null; qualidade: string; motivo: string | null }> = [];
  for (const id of ACQUISITION_METRIC_IDS) {
    const def = getMetric(id);
    if (!def) throw new Error(`[metrics-cli] métrica "${id}" não encontrada no registry`);
    const resultado = await def.computar({ janela, deps });
    results.push({ id, valor: resultado.valor, qualidade: resultado.qualidade, motivo: resultado.motivo });
  }
  db.close();

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify({ janela, resultados: results }, null, 2));
    return;
  }
  console.log(`Janela: ${de}..${ate} (BRT)`);
  console.table(results);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
