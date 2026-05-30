/**
 * merge-scored-chunks.ts (#1611)
 *
 * Etapa 3 do scorer chunked-parallel (após os K agents `scorer-chunk`). Junta os
 * `{url, score}` de todos os chunks, reconstrói o pool completo a partir do
 * `categorized` original, e emite:
 *
 *   - all_scored: TODOS os artigos com score, ordenados por score desc. É o
 *     contrato que finalize-stage1.ts consome (join por URL exata).
 *   - finalists: os top-N artigos COMPLETOS (com score + bucket) que vão pro
 *     agent `scorer-select` escolher os 6 destaques + ordem editorial.
 *
 * Guard: se a contagem de artigos pontuados não bater com o pool, ECOA warning
 * no stderr e marca `incomplete: true` no manifest — um chunk pode ter falhado.
 * Artigos sem score recebem score 0 (finalize-stage1 depois os filtra por <40),
 * para nunca sumirem silenciosamente do all_scored.
 *
 * URLs são opacas (#720): join por igualdade de string, sem canonicalizar.
 *
 * Uso:
 *   npx tsx scripts/merge-scored-chunks.ts \
 *     --categorized data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
 *     --chunk-scores data/editions/{AAMMDD}/_internal/scoring-chunks/scored-chunk-0.json,...,scored-chunk-2.json \
 *     --allscored-out data/editions/{AAMMDD}/_internal/tmp-allscored.json \
 *     --finalists-out data/editions/{AAMMDD}/_internal/tmp-finalists.json \
 *     [--top 15]
 *
 * Output stdout: JSON manifest { pool_size, scored_count, finalists_count, incomplete }.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  flattenCategorized,
  type Article,
  type Categorized,
} from "./split-articles-for-scoring.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface ScorePair {
  url: string;
  score: number;
}

export interface ChunkScoreFile {
  all_scored?: ScorePair[];
  scored?: ScorePair[];
}

export interface Finalist {
  url: string;
  score: number;
  bucket: string;
  article: Article;
}

export interface MergeResult {
  all_scored: ScorePair[];
  finalists: Finalist[];
  pool_size: number;
  scored_count: number;
  missing_count: number; // pool_size - scored_count
  failed_chunks: number; // chunk files que não carregaram (ausente/corrompido)
  incomplete: boolean; // qualquer gap (scored_count < pool_size)
  /**
   * Perda CATASTRÓFICA — um chunk inteiro sumiu (failed_chunks > 0) ou o gap é
   * grande demais pra ser ruído de agente (> MAX_BENIGN_MISSING). Distingue
   * "1-2 artigos omitidos" (recuperável, segue com warning) de "~30 artigos —
   * uma fatia round-robin dos MELHORES — perdidos" (exige retry/single-call
   * fallback, senão o #1 highlight some silenciosamente). #1567 audit finding F.
   */
  catastrophic: boolean;
}

/** Gap ≤ isto = ruído recuperável de agente; acima (ou chunk inteiro perdido) = catastrófico. */
export const MAX_BENIGN_MISSING = 2;

const BUCKET_ORDER = ["lancamento", "pesquisa", "noticias", "tutorial"] as const;
function bucketOf(a: Article): string {
  const c = a.category;
  return (BUCKET_ORDER as readonly string[]).includes(c ?? "") ? (c as string) : "noticias";
}

/**
 * Lê e parseia os chunk files, tolerando arquivos ausentes/corrompidos. Um chunk
 * que falha (não escrito, truncado por socket error, JSON inválido) é PULADO com
 * warning — os demais chunks sobrevivem, e os artigos do chunk perdido caem no
 * guard `incomplete` do mergeChunks (score 0 → filtrados em finalize-stage1).
 * Sem isso, 1 chunk corrompido derrubaria todo o trabalho paralelo (#1611).
 */
export function loadChunks(
  paths: string[],
  readFile: (p: string) => string,
): { chunks: ChunkScoreFile[]; failed: string[] } {
  const chunks: ChunkScoreFile[] = [];
  const failed: string[] = [];
  for (const p of paths) {
    try {
      chunks.push(JSON.parse(readFile(p)));
    } catch (e) {
      failed.push(p);
      process.stderr.write(
        `WARN [merge-scored-chunks]: chunk ilegível pulado (${p}): ${(e as Error).message}\n`,
      );
    }
  }
  return { chunks, failed };
}

/** Extrai os pares {url, score} de um chunk (aceita `all_scored` ou `scored`). */
export function extractScores(chunk: ChunkScoreFile): ScorePair[] {
  const arr = chunk.all_scored ?? chunk.scored ?? [];
  return arr
    .filter((p) => p && typeof p.url === "string")
    .map((p) => ({ url: p.url, score: typeof p.score === "number" ? p.score : 0 }));
}

/**
 * Junta scores dos chunks ao pool. Cada artigo do pool recebe seu score (0 se
 * ausente). all_scored ordenado desc; finalists = top-N completos.
 *
 * Em caso de URL duplicada entre chunks (não deveria acontecer), o maior score
 * vence — defensivo.
 */
export function mergeChunks(
  categorized: Categorized,
  chunks: ChunkScoreFile[],
  topN: number,
  failedChunks = 0,
): MergeResult {
  const pool = flattenCategorized(categorized);

  const scoreByUrl = new Map<string, number>();
  for (const chunk of chunks) {
    for (const { url, score } of extractScores(chunk)) {
      const prev = scoreByUrl.get(url);
      if (prev == null || score > prev) scoreByUrl.set(url, score);
    }
  }

  let scoredCount = 0;
  const enriched = pool.map((article) => {
    const has = scoreByUrl.has(article.url);
    if (has) scoredCount++;
    const score = scoreByUrl.get(article.url) ?? 0;
    return { article, url: article.url, score, bucket: bucketOf(article) };
  });

  enriched.sort((a, b) => b.score - a.score);

  const all_scored: ScorePair[] = enriched.map((e) => ({ url: e.url, score: e.score }));
  const finalists: Finalist[] = enriched.slice(0, Math.max(0, topN));

  const missing = pool.length - scoredCount;

  return {
    all_scored,
    finalists,
    pool_size: pool.length,
    scored_count: scoredCount,
    missing_count: missing,
    failed_chunks: failedChunks,
    incomplete: missing > 0,
    catastrophic: failedChunks > 0 || missing > MAX_BENIGN_MISSING,
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const categorizedPath = args.categorized;
  const chunkScoresArg = args["chunk-scores"];
  const allscoredOut = args["allscored-out"];
  const finalistsOut = args["finalists-out"];
  const topN = parseInt(args.top ?? "15", 10);

  if (!categorizedPath || !chunkScoresArg || !allscoredOut || !finalistsOut) {
    console.error(
      "Uso: merge-scored-chunks.ts --categorized <tmp-dates-reviewed.json> --chunk-scores <f1,f2,...> --allscored-out <file> --finalists-out <file> [--top 15]",
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(resolve(ROOT, categorizedPath), "utf8"));
  const categorized: Categorized = raw.categorized ?? raw;

  const chunkFiles = chunkScoresArg.split(",").map((s) => s.trim()).filter(Boolean);
  const { chunks, failed } = loadChunks(chunkFiles, (f) =>
    readFileSync(resolve(ROOT, f), "utf8"),
  );

  const result = mergeChunks(categorized, chunks, topN, failed.length);

  writeFileSync(
    resolve(ROOT, allscoredOut),
    JSON.stringify({ all_scored: result.all_scored }, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(ROOT, finalistsOut),
    JSON.stringify({ finalists: result.finalists }, null, 2),
    "utf8",
  );

  if (result.catastrophic) {
    // Perda de chunk inteiro: NÃO é só warning — o orchestrator (1q.3) deve
    // retry o(s) chunk(s) e, se persistir, cair no single-call fallback (#1567 F).
    process.stderr.write(
      `ERROR [merge-scored-chunks]: perda CATASTRÓFICA — ${result.scored_count}/${result.pool_size} ` +
        `pontuados (${result.missing_count} sem score, ${result.failed_chunks} chunk(s) ilegível). ` +
        `Retry o(s) chunk(s) ou caia no single-call fallback antes de seguir.\n`,
    );
  } else if (result.incomplete) {
    process.stderr.write(
      `WARN [merge-scored-chunks]: ${result.scored_count}/${result.pool_size} artigos pontuados — ` +
        `${result.missing_count} sem score (gap pequeno, recuperável). Recebem score 0.\n`,
    );
  }

  process.stdout.write(
    JSON.stringify({
      pool_size: result.pool_size,
      scored_count: result.scored_count,
      finalists_count: result.finalists.length,
      missing_count: result.missing_count,
      failed_chunks: result.failed_chunks,
      incomplete: result.incomplete,
      catastrophic: result.catastrophic,
    }) + "\n",
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
