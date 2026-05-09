/**
 * fetch-poll-stats.ts (#469)
 *
 * Busca estatísticas de votação do Worker de poll para uma edição.
 * Substitui fetch-beehiiv-poll-stats.ts na migração para o sistema próprio.
 *
 * Uso:
 *   npx tsx scripts/fetch-poll-stats.ts --edition 260502 --out data/editions/260502/_internal/04-eia-poll-stats.json
 *
 * Output JSON (compatível com compute-eia-poll-stats.ts):
 *   { edition, total_responses, correct_pct, skipped, previous_edition }
 *
 * Variáveis de ambiente:
 *   POLL_WORKER_URL    URL base do Worker (default: https://diar-ia-poll.diaria.workers.dev)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";
const MIN_RESPONSES = 5;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idx = (f: string) => args.indexOf(f);
  const get = (f: string) => idx(f) !== -1 ? args[idx(f) + 1] : undefined;

  const edition = get("--edition");
  const outPath = get("--out");

  if (!edition) {
    console.error("Uso: fetch-poll-stats.ts --edition AAMMDD [--out <path>]");
    process.exit(1);
  }

  const url = `${POLL_WORKER_URL}/stats?edition=${edition}`;
  let data: {
    total?: number;
    correct_pct?: number | null;
    correct_answer?: string | null;
    correct_count?: number;
  } = {};

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json() as typeof data;
  } catch (err) {
    console.warn(`[fetch-poll-stats] Falha ao buscar stats da edição ${edition}: ${(err as Error).message}`);
    data = {};
  }

  const total = data.total ?? 0;
  const belowThreshold = total < MIN_RESPONSES;
  // Schema compatível com consumers (eia-compose.ts, load-carry-over.ts):
  // pct_correct (não correct_pct), below_threshold (boolean).
  const pctCorrect = belowThreshold ? null : (data.correct_pct ?? null);

  const output = {
    edition,
    total_responses: total,
    correct_responses: data.correct_count ?? 0,
    pct_correct: pctCorrect,
    correct_choice: data.correct_answer ?? null,
    below_threshold: belowThreshold,
    skipped: belowThreshold ? `fewer_than_${MIN_RESPONSES}_responses` : undefined,
    source: "poll-worker",
    fetched_at: new Date().toISOString(),
  };

  const result = JSON.stringify(output, null, 2);

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result, "utf8");
    console.log(`[fetch-poll-stats] Gravado em ${outPath} (total=${total}, pct_correct=${pctCorrect})`);
  } else {
    process.stdout.write(result + "\n");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
