#!/usr/bin/env npx tsx
/**
 * assemble-research-pool.ts (#4955)
 *
 * Monta o pool inicial de artigos (`tmp-articles-raw.json`) a partir dos
 * resultados agregados de researchers/discovery/RSS/websearch já gravados em
 * `researcher-results.json` (passo 1g do orchestrator Stage 1).
 *
 * Causa raiz do #4955: antes deste script, essa montagem era um passo
 * IMPLÍCITO do orchestrator (LLM) — sem schema/interface explícito no
 * playbook, o que permitia (e num caso ao vivo, 260811, causou) reconstrução
 * manual do objeto artigo campo-a-campo em vez de repasse verbatim. 9/10
 * artigos de uma edição chegaram ao Stage 4 sem `summary`, embora o campo
 * estivesse presente em `researcher-results.json` — o campo já estava
 * ausente no PRIMEIRO snapshot do pool (`tmp-articles-raw.json`), antes de
 * qualquer processamento downstream (dedup, categorize, scoring). Mesmo
 * racional de `assemble-scored.ts` (#1611/#720): assemblar em TS evita pedir
 * pro agent copiar array grande verbatim (risco de corrupção/perda de campo).
 *
 * Regra: cada artigo do output de um RunRecord com outcome/status "ok" ou
 * "empty" entra no pool com TODOS os campos originais preservados verbatim
 * (spread — nunca reconstrução campo a campo) + `source` do RunRecord quando
 * o artigo não já tiver o seu próprio (Path A/Brave já inclui `source` por
 * artigo — `fetch-websearch-batch.ts`; Path B/agents Haiku não —
 * `source-researcher.md`/`discovery-searcher.md`, só no nível do RunRecord).
 *
 * Runs com outcome/status `fail`/`timeout` são ignorados (mesma regra já
 * documentada em prosa no playbook — "Artigos de researchers com status !=
 * ok não entram na lista agregada").
 *
 * Merge-safe (mesmo padrão de `inject-inbox-urls.ts`/`load-carry-over.ts`):
 * se `--out` já existir (resume), artigos já presentes (por URL) são
 * preservados como estão; só entries novas (URL ainda não vista) são
 * anexadas — nunca sobrescreve um artigo já no pool.
 *
 * Uso:
 *   npx tsx scripts/assemble-research-pool.ts \
 *     --runs data/editions/{AAMMDD}/_internal/researcher-results.json \
 *     --out data/editions/{AAMMDD}/_internal/tmp-articles-raw.json
 *
 * Output stdout: JSON com { runs_total, runs_ok, articles_from_runs,
 * already_in_pool, injected, total_pool_size }.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Shape tolerante — cobre RunRecord de fetch-rss-batch.ts (`outcome`),
 * fetch-websearch-batch.ts (`outcome`) e o output cru dos agents
 * source-researcher/discovery-searcher (`status`). */
export interface RunRecordLike {
  source: string;
  outcome?: string;
  status?: string;
  articles?: Array<Record<string, unknown>> | null;
}

export interface PoolArticle {
  url: string;
  [key: string]: unknown;
}

const OK_OUTCOMES = new Set(["ok", "empty"]);

/** Uma run entra na lista agregada se outcome (ou status, fallback do
 * shape cru dos agents) for "ok" ou "empty". "fail"/"timeout" ficam fora
 * (mesma regra já documentada em prosa no playbook Stage 1 §1g). */
export function isOkRun(run: RunRecordLike): boolean {
  const marker = run.outcome ?? run.status;
  if (!marker) return false;
  return OK_OUTCOMES.has(marker);
}

/**
 * Achata os `articles[]` de runs "ok"/"empty" num array único, preservando
 * TODOS os campos originais de cada artigo verbatim (spread — nunca
 * reconstrução campo a campo, causa raiz do #4955). Garante `source`
 * presente em cada artigo: usa o do próprio artigo se já tiver (Path A),
 * senão cai pro `source` do RunRecord (Path B).
 */
export function flattenRunRecords(runs: RunRecordLike[]): PoolArticle[] {
  const out: PoolArticle[] = [];
  for (const run of runs) {
    if (!isOkRun(run)) continue;
    for (const article of run.articles ?? []) {
      if (!article || typeof article !== "object") continue;
      const a = article as Record<string, unknown>;
      if (typeof a.url !== "string" || a.url.length === 0) continue;
      out.push({
        ...a,
        url: a.url,
        source: typeof a.source === "string" && a.source.length > 0 ? a.source : run.source,
      } as PoolArticle);
    }
  }
  return out;
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runsPath = args["runs"];
  const outPath = args["out"];

  if (!runsPath || !outPath) {
    console.error(
      "Uso: assemble-research-pool.ts --runs <researcher-results.json> --out <tmp-articles-raw.json>",
    );
    process.exit(1);
  }

  const runsAbs = resolve(ROOT, runsPath);
  if (!existsSync(runsAbs)) {
    console.error(`Erro: ${runsAbs} não existe.`);
    process.exit(1);
  }

  let runs: RunRecordLike[];
  try {
    runs = JSON.parse(readFileSync(runsAbs, "utf8"));
  } catch (e) {
    console.error(`Erro lendo ${runsAbs}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!Array.isArray(runs)) {
    console.error("Input --runs deve ser um array JSON de RunRecord.");
    process.exit(1);
  }

  const fromRuns = flattenRunRecords(runs);

  const outAbs = resolve(ROOT, outPath);
  const existingPool = readJsonOrNull<PoolArticle[]>(outAbs) ?? [];
  const poolUrls = new Set(existingPool.map((a) => a.url));
  const newArticles = fromRuns.filter((a) => !poolUrls.has(a.url));
  const merged = [...existingPool, ...newArticles];

  writeFileAtomic(outAbs, JSON.stringify(merged, null, 2) + "\n");

  console.log(
    JSON.stringify({
      runs_total: runs.length,
      runs_ok: runs.filter(isOkRun).length,
      articles_from_runs: fromRuns.length,
      already_in_pool: fromRuns.length - newArticles.length,
      injected: newArticles.length,
      total_pool_size: merged.length,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
