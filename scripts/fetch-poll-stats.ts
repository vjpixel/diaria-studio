/**
 * fetch-poll-stats.ts (#469)
 *
 * Busca estatísticas de votação do Worker de poll para uma edição.
 * Substitui fetch-beehiiv-poll-stats.ts na migração para o sistema próprio.
 *
 * Uso:
 *   npx tsx scripts/fetch-poll-stats.ts --edition 260502 --out data/editions/260502/_internal/04-eia-poll-stats.json
 *   npx tsx scripts/fetch-poll-stats.ts --edition 2605-06 --brand clarice --out ...  (#2948: mensal)
 *
 * Output JSON (compatível com eia-compose.ts — consumer real):
 *   { edition, total_responses, correct_responses, pct_correct,
 *     correct_choice, below_threshold, skipped?, source, fetched_at }
 *
 * Substitui o fluxo antigo (fetch-beehiiv-poll-stats.ts → poll-responses.json
 * → compute-eia-poll-stats.ts → 04-eia-poll-stats.json). Worker já agrega via
 * counter no /vote — não precisa middle step.
 *
 * `--brand clarice` (#2948): busca o leaderboard da Clarice News (mensal) em
 * vez da Diar.ia (diária, default). Mesma convenção de `close-poll.ts` — brand
 * ausente/"diaria" não anexa `&brand=` na query (compat com o Worker, que já
 * default-a pra "diaria" via `parseBrandParam`).
 *
 * Variáveis de ambiente:
 *   POLL_WORKER_URL    URL base do Worker (default: https://eia.diar.ia.br —
 *                      domínio de marca, #3904; poll.diaria.workers.dev segue
 *                      ativo só por compat de links já enviados)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { dohFetch } from "./lib/doh-fetch.ts"; // #1365 — DoH fallback pra UDP/53 broken
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts"; // #3904

const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL;
const MIN_RESPONSES = 5;

export type PollBrand = "diaria" | "clarice";

export interface PollStatsOutput {
  edition: string;
  total_responses: number;
  correct_responses: number;
  pct_correct: number | null;
  correct_choice: string | null;
  below_threshold: boolean;
  skipped?: string;
  source: string;
  fetched_at: string;
}

export interface FetchPollStatsOptions {
  brand?: PollBrand;
  workerUrl?: string;
}

/**
 * Busca as stats de `/stats?edition=...` do Worker poll (com `&brand=...`
 * quando não-default) e monta o output no shape consumido por
 * `eia-compose.ts`/`buildPrevResultLine`. Extraído do CLI (#2948) para ser
 * reusável pelo pipeline mensal (`monthly-render.ts` →
 * `fetchMonthlyEiaPrevResultLine`) sem invocar um subprocesso.
 *
 * Nunca lança — falha de rede vira `total_responses: 0` (o mesmo
 * fail-soft que o CLI sempre teve), o caller decide o que fazer com stats
 * vazias (tipicamente: omitir a linha "Resultado da última edição").
 */
export async function fetchPollStats(
  edition: string,
  opts: FetchPollStatsOptions = {},
): Promise<PollStatsOutput> {
  const brand = opts.brand && opts.brand !== "diaria" ? opts.brand : undefined;
  const workerUrl = opts.workerUrl ?? POLL_WORKER_URL;
  const brandQ = brand ? `&brand=${brand}` : "";
  const url = `${workerUrl}/stats?edition=${edition}${brandQ}`;

  let data: {
    total?: number;
    correct_pct?: number | null;
    correct_answer?: string | null;
    correct_count?: number;
  } = {};

  try {
    const res = await dohFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.warn(
      `[fetch-poll-stats] Falha ao buscar stats da edição ${edition}${brand ? ` (brand=${brand})` : ""}: ${(err as Error).message}`,
    );
    data = {};
  }

  const total = data.total ?? 0;
  const belowThreshold = total < MIN_RESPONSES;
  // Schema compatível com consumers (eia-compose.ts, load-carry-over.ts):
  // pct_correct (não correct_pct), below_threshold (boolean).
  const pctCorrect = belowThreshold ? null : (data.correct_pct ?? null);

  return {
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
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idx = (f: string) => args.indexOf(f);
  const get = (f: string) => idx(f) !== -1 ? args[idx(f) + 1] : undefined;

  const edition = get("--edition");
  const outPath = get("--out");
  const brand = get("--brand") === "clarice" ? "clarice" : undefined;

  if (!edition) {
    console.error("Uso: fetch-poll-stats.ts --edition AAMMDD [--brand clarice] [--out <path>]");
    process.exit(1);
  }

  const output = await fetchPollStats(edition, { brand });

  const result = JSON.stringify(output, null, 2);

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result, "utf8");
    console.log(`[fetch-poll-stats] Gravado em ${outPath} (total=${output.total_responses}, pct_correct=${output.pct_correct})`);
  } else {
    process.stdout.write(result + "\n");
  }
}

// CLI guard (#cli-guard): só roda main() quando invocado direto, não em import
// (senão testes que importam `fetchPollStats` disparariam o CLI real).
if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
