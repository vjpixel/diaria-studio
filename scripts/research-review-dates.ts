#!/usr/bin/env npx tsx
/**
 * research-review-dates.ts (#1112)
 *
 * Filtro 1 do research-reviewer extraído pra script determinístico.
 *
 * Antes (research-reviewer agent Haiku): agente flattena buckets, dispara
 * verify-dates.ts via Bash, faz aplicação mecânica das datas verified
 * (`changed && !fetch_failed`), e dispara filter-date-window.ts pra remover
 * artigos fora da janela. Tudo determinístico — o LLM só orquestrava.
 *
 * Agora (este script): mesma lógica, em TS direto. Elimina ~1 Haiku call
 * por edição e variance entre runs. Agent fica só com Filtro 2 (topic dedup).
 *
 * Uso:
 *   npx tsx scripts/research-review-dates.ts \
 *     --in data/editions/{AAMMDD}/_internal/tmp-filtered.json \
 *     --out data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
 *     --edition-dir data/editions/{AAMMDD}/ \
 *     --anchor-iso 2026-05-12 \
 *     --edition-iso 2026-05-13 \
 *     --window-days 3 \
 *     [--bodies-dir data/editions/{AAMMDD}/_internal/_forensic/link-verify-bodies] \
 *     [--verify-cache data/link-verify-cache.json]
 *
 * Input: JSON com `{ kept: { lancamento, pesquisa, noticias, tutorial, video } }`
 *        (output de filter-date-window.ts no passo 1o) ou `{ lancamento, ... }` direto.
 *
 * Output: JSON com:
 *   {
 *     "categorized": { lancamento, radar, use_melhor, video },
 *     "stats": {
 *       "total_input": N,
 *       "date_corrected": M,
 *       "fetch_failed": P,
 *       "removed_date_window": Q,
 *       "total_output": R,
 *       "removals": [{ url, reason, detail }, ...]
 *     }
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { verifyDate, type DateVerifyResult } from "./verify-dates.ts";
import type { VerifyDateOptions } from "./lib/verify-options.ts";
import { loadCache as loadVerifyCache } from "./lib/url-verify-cache.ts";
import { filterDateWindow } from "./filter-date-window.ts";

/** Local copy do ArticleInput de verify-dates.ts (interface não-exportada lá). */
interface ArticleInput {
  url: string;
  date: string;
}

interface Args {
  in: string;
  out: string;
  editionDir: string;
  anchorIso: string;
  editionIso: string;
  windowDays: number;
  bodiesDir?: string;
  verifyCache?: string;
  // #1554 P2: path para link-verify-all.json (output do verify-accessibility).
  // Quando presente, pre-extracted published_date é usado em vez de re-fetch.
  // Convencionalmente: {edition-dir}/_internal/link-verify-all.json
  linkVerifyJson?: string;
}

// #1554 P2: shape mínima do link-verify-all.json entry
interface LinkVerifyEntry {
  url: string;
  finalUrl?: string;
  verdict?: string;
  published_date?: string | null;
  published_date_note?: string;
}

interface ArticleEntry {
  url: string;
  date?: string;
  date_unverified?: boolean;
  [k: string]: unknown;
}

interface CategorizedShape {
  lancamento?: ArticleEntry[];
  radar?: ArticleEntry[];
  use_melhor?: ArticleEntry[];
  video?: ArticleEntry[];
  [k: string]: unknown;
}

const BUCKET_KEYS = ["lancamento", "radar", "use_melhor", "video"] as const;

export interface ReviewStats {
  total_input: number;
  date_corrected: number;
  fetch_failed: number;
  removed_date_window: number;
  total_output: number;
  removals: Array<{ url: string; reason: string; detail: string }>;
}

/**
 * Pure (sans network IO): aplica resultados de verifyDate a um categorized,
 * mutando `target.date` quando `changed && !fetch_failed`, e copiando
 * `date_unverified` direto do output do script (#226 — não recalcula).
 *
 * Exportado pra teste — testa a lógica de apply sem precisar fazer fetch real.
 */
export function applyVerifyResults(
  categorized: CategorizedShape,
  results: DateVerifyResult[],
): { dateCorrected: number; fetchFailed: number } {
  let dateCorrected = 0;
  let fetchFailed = 0;
  // Indexa por URL pra lookup O(1)
  const byUrl = new Map<string, DateVerifyResult>();
  for (const r of results) byUrl.set(r.url, r);

  for (const bucket of BUCKET_KEYS) {
    const arr = categorized[bucket];
    if (!Array.isArray(arr)) continue;
    for (const article of arr) {
      const result = byUrl.get(article.url);
      if (!result) continue;
      if (result.changed && !result.fetch_failed && result.verified_date) {
        article.date = result.verified_date;
        dateCorrected++;
      }
      if (result.fetch_failed) {
        fetchFailed++;
      }
      // #226: copia direto, não recalcula. Só true quando fetch_failed.
      article.date_unverified = result.date_unverified;
    }
  }
  return { dateCorrected, fetchFailed };
}

/**
 * Pure: extrai categorized do input, aceitando wrapper `{ kept: {...} }` (output
 * de filter-date-window) ou shape direto. Preserva campos extras top-level
 * (clusters, etc).
 */
export function unwrapCategorized(input: unknown): CategorizedShape {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.kept && typeof obj.kept === "object") {
      return obj.kept as CategorizedShape;
    }
    return obj as CategorizedShape;
  }
  throw new Error("Input não é um objeto categorized válido");
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--in") args.in = argv[++i];
    else if (k === "--out") args.out = argv[++i];
    else if (k === "--edition-dir") args.editionDir = argv[++i];
    else if (k === "--anchor-iso") args.anchorIso = argv[++i];
    else if (k === "--edition-iso") args.editionIso = argv[++i];
    else if (k === "--window-days") args.windowDays = Number(argv[++i]);
    else if (k === "--bodies-dir") args.bodiesDir = argv[++i];
    else if (k === "--verify-cache") args.verifyCache = argv[++i];
    else if (k === "--link-verify-json") args.linkVerifyJson = argv[++i]; // #1554 P2
  }
  for (const required of ["in", "out", "editionDir", "anchorIso", "editionIso", "windowDays"] as const) {
    if (args[required] === undefined) {
      throw new Error(`--${required.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())} obrigatório`);
    }
  }
  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const categorized = unwrapCategorized(JSON.parse(readFileSync(resolve(args.in), "utf8")));

  // Flatten pra lista de artigos
  const articles: ArticleInput[] = [];
  for (const bucket of BUCKET_KEYS) {
    const arr = categorized[bucket];
    if (!Array.isArray(arr)) continue;
    for (const article of arr) {
      articles.push({ url: article.url, date: article.date ?? "" });
    }
  }
  const totalInput = articles.length;

  // Cutoff = anchor - windowDays (pra arxiv pre-skip)
  const cutoffDate = new Date(args.anchorIso + "T00:00:00Z");
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - args.windowDays);
  const cutoffIso = cutoffDate.toISOString().split("T")[0] ?? args.anchorIso;

  // Verify cache pode não existir ainda — passar null nesse caso
  const verifyCacheMap = args.verifyCache && existsSync(args.verifyCache)
    ? loadVerifyCache(args.verifyCache)
    : null;

  const opts: VerifyDateOptions = {
    cutoffIso,
    bodiesDir: args.bodiesDir ?? null,
    verifyCache: verifyCacheMap,
  };

  // #1554 P2: pre-load published_date map from link-verify-all.json.
  // Quando verify-accessibility já extraiu a data, podemos pular o verifyDate
  // (que faria HTTP GET + parse). Cobre o caso comum onde HEAD+GET aconteceu
  // 1x no step 1i — não há razão pra refetch em 1p1.
  const preExtractedDates = new Map<string, { date: string | null; note: string }>();
  const linkVerifyPath = args.linkVerifyJson
    ?? resolve(args.editionDir, "_internal", "link-verify-all.json");
  if (existsSync(linkVerifyPath)) {
    try {
      const entries = JSON.parse(readFileSync(linkVerifyPath, "utf8")) as LinkVerifyEntry[];
      for (const entry of entries) {
        if (typeof entry.published_date !== "undefined") {
          preExtractedDates.set(entry.url, {
            date: entry.published_date ?? null,
            note: entry.published_date_note ?? "no-date-found",
          });
          // Indexar também por finalUrl quando difere (redirects)
          if (entry.finalUrl && entry.finalUrl !== entry.url) {
            preExtractedDates.set(entry.finalUrl, {
              date: entry.published_date ?? null,
              note: entry.published_date_note ?? "no-date-found",
            });
          }
        }
      }
      console.error(
        `[research-review-dates] pre-extracted dates loaded: ${preExtractedDates.size} entries from ${linkVerifyPath}`,
      );
    } catch (e) {
      console.error(`[research-review-dates] warn: failed to load ${linkVerifyPath}: ${(e as Error).message}`);
    }
  }

  // verify-dates em paralelo controlado (10 a fio — mesmo padrão do script CLI).
  // Pré-skip: artigos com published_date pré-extraído (#1554 P2) montam
  // DateVerifyResult sintético sem fetch.
  const results: DateVerifyResult[] = [];
  const CONCURRENCY = 10;
  const articlesToFetch: ArticleInput[] = [];
  const preSkipResults: Array<{ index: number; result: DateVerifyResult }> = [];
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const pre = preExtractedDates.get(article.url);
    if (pre && pre.date) {
      // Hit: pre-extracted date disponível. Skip verifyDate.
      const normalized = pre.date;
      const changed = normalized !== article.date;
      preSkipResults.push({
        index: i,
        result: {
          url: article.url,
          original_date: article.date,
          verified_date: normalized,
          changed,
          fetch_failed: false,
          date_unverified: false,
          note: `pre-extracted:${pre.note}`,
        },
      });
    } else {
      articlesToFetch.push(article);
    }
  }
  if (preSkipResults.length > 0) {
    console.error(
      `[research-review-dates] pre-skipped ${preSkipResults.length}/${articles.length} via link-verify cache (#1554 P2)`,
    );
  }
  // Resto vai pro verifyDate normal
  const fetchResults: DateVerifyResult[] = [];
  for (let i = 0; i < articlesToFetch.length; i += CONCURRENCY) {
    const batch = articlesToFetch.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((a) => verifyDate(a, opts)));
    fetchResults.push(...batchResults);
  }
  // Reassemblar na ordem original (preSkip + fetch). A applyVerifyResults usa
  // URL como chave de match, então a ordem do array results não importa.
  results.push(...preSkipResults.map((p) => p.result));
  results.push(...fetchResults);

  const { dateCorrected, fetchFailed } = applyVerifyResults(categorized, results);

  // Filter date window com datas atualizadas. CategorizedInput exige
  // lancamento/pesquisa/noticias presentes — garantir defaults vazios pra
  // input mal-formado.
  const filterInput = {
    lancamento: categorized.lancamento ?? [],
    radar: categorized.radar ?? [],
    use_melhor: categorized.use_melhor ?? [],
    video: categorized.video ?? [],
  } as Parameters<typeof filterDateWindow>[0];
  const filterResult = filterDateWindow(
    filterInput,
    args.anchorIso,
    args.windowDays,
    args.editionIso,
  );

  const totalOutput = BUCKET_KEYS.reduce((sum, b) => {
    const arr = (filterResult.kept as Record<string, unknown>)[b];
    return sum + (Array.isArray(arr) ? arr.length : 0);
  }, 0);

  const stats: ReviewStats = {
    total_input: totalInput,
    date_corrected: dateCorrected,
    fetch_failed: fetchFailed,
    removed_date_window: filterResult.removed.length,
    total_output: totalOutput,
    removals: filterResult.removed.map((r) => ({
      url: r.url,
      reason: "date_window",
      detail: r.detail,
    })),
  };

  writeFileSync(
    args.out,
    JSON.stringify({ categorized: filterResult.kept, stats }, null, 2),
    "utf8",
  );

  process.stderr.write(
    `[research-review-dates] input=${totalInput}, date_corrected=${dateCorrected}, fetch_failed=${fetchFailed}, removed_window=${filterResult.removed.length}, output=${totalOutput}\n`,
  );
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("research-review-dates.ts");
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[research-review-dates] fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
