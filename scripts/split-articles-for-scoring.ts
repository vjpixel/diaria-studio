/**
 * split-articles-for-scoring.ts (#1611)
 *
 * Etapa 1 do scorer chunked-parallel. Achata os buckets categorizados em uma
 * lista única e divide em N chunks de ~`chunk-size` artigos, preservando o
 * bucket de cada artigo (`category`). Cada chunk é gravado no MESMO shape que o
 * scorer espera (`{ categorized: { lancamento, pesquisa, noticias, tutorial } }`)
 * para que os agents `scorer-chunk` paralelos pontuem em wall-clock reduzido.
 *
 * Por que: o scorer Opus single-call gasta ~8min raciocinando sobre ~80-150
 * artigos numa passada só. Dividir em K chamadas paralelas (mesmo rubrico)
 * corta o wall-clock pro tempo do chunk mais lento. A seleção final dos 6
 * destaques continua holística (agent `scorer-select` sobre os finalistas do
 * merge) — ver merge-scored-chunks.ts + assemble-scored.ts.
 *
 * Determinístico e testável — a divisão é round-robin estável sobre a lista
 * achatada (ordem de bucket fixa), então o mesmo input sempre gera os mesmos
 * chunks.
 *
 * Uso:
 *   npx tsx scripts/split-articles-for-scoring.ts \
 *     --categorized data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
 *     --out-dir data/editions/{AAMMDD}/_internal/scoring-chunks \
 *     [--chunk-size 30]
 *
 * Output stdout: JSON manifest { total_articles, chunk_count, chunk_files[] }.
 * Quando total_articles <= chunk-size, emite 1 chunk só (o orchestrator pode
 * cair no caminho single-scorer nesse caso).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Ordem de bucket canônica — fixa para tornar a divisão determinística.
export const BUCKET_ORDER = ["lancamento", "pesquisa", "noticias", "tutorial"] as const;
export type Bucket = (typeof BUCKET_ORDER)[number];

export interface Article {
  url: string;
  title?: string;
  category?: string;
  [key: string]: unknown;
}

export type Categorized = Record<string, Article[]>;

export interface SplitManifest {
  total_articles: number;
  chunk_count: number;
  chunk_files: string[];
}

/** Achata os buckets na ordem canônica, preservando o bucket de cada artigo. */
export function flattenCategorized(categorized: Categorized): Article[] {
  const flat: Article[] = [];
  for (const bucket of BUCKET_ORDER) {
    for (const a of categorized[bucket] ?? []) flat.push(a);
  }
  // Buckets fora da ordem canônica (defensivo) — incluídos ao final.
  for (const key of Object.keys(categorized)) {
    if ((BUCKET_ORDER as readonly string[]).includes(key)) continue;
    for (const a of categorized[key] ?? []) flat.push(a);
  }
  return flat;
}

/** Mapeia um artigo de volta pro bucket categorizado (fallback noticias). */
function bucketOf(a: Article): Bucket {
  const c = a.category;
  return (BUCKET_ORDER as readonly string[]).includes(c ?? "")
    ? (c as Bucket)
    : "noticias";
}

/** Reconstrói o shape `categorized` a partir de uma lista de artigos. */
export function toCategorized(articles: Article[]): Categorized {
  const out: Categorized = { lancamento: [], pesquisa: [], noticias: [], tutorial: [] };
  for (const a of articles) out[bucketOf(a)].push(a);
  return out;
}

/**
 * Divide a lista achatada em `chunkCount` chunks via round-robin estável.
 * Round-robin (em vez de fatias contíguas) garante que cada chunk receba uma
 * mistura de buckets — evita que um chunk fique só com `noticias` e outro só
 * com `lancamento`, o que enviesaria a pontuação relativa intra-chunk.
 */
export function splitRoundRobin(articles: Article[], chunkCount: number): Article[][] {
  const chunks: Article[][] = Array.from({ length: chunkCount }, () => []);
  articles.forEach((a, i) => chunks[i % chunkCount].push(a));
  return chunks;
}

/** Quantos chunks pra um pool de `total` artigos com alvo `chunkSize`. */
export function chunkCountFor(total: number, chunkSize: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil(total / chunkSize));
}

export function buildChunks(
  categorized: Categorized,
  chunkSize: number,
): Categorized[] {
  const flat = flattenCategorized(categorized);
  const count = chunkCountFor(flat.length, chunkSize);
  if (count === 0) return [];
  return splitRoundRobin(flat, count).map(toCategorized);
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
  const outDir = args["out-dir"];
  const chunkSize = parseInt(args["chunk-size"] ?? "30", 10);

  if (!categorizedPath || !outDir) {
    console.error(
      "Uso: split-articles-for-scoring.ts --categorized <tmp-dates-reviewed.json> --out-dir <dir> [--chunk-size 30]",
    );
    process.exit(1);
  }
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    console.error(`--chunk-size inválido: ${args["chunk-size"]}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(resolve(ROOT, categorizedPath), "utf8"));
  // Aceita tanto { categorized: {...} } (tmp-dates-reviewed) quanto {...} direto.
  const categorized: Categorized = raw.categorized ?? raw;

  const chunks = buildChunks(categorized, chunkSize);
  const absOutDir = resolve(ROOT, outDir);
  mkdirSync(absOutDir, { recursive: true });

  const chunkFiles: string[] = [];
  chunks.forEach((chunk, i) => {
    const fileAbs = join(absOutDir, `scoring-chunk-${i}.json`);
    writeFileSync(fileAbs, JSON.stringify({ categorized: chunk }, null, 2), "utf8");
    // path relativo ao ROOT pro manifest (consumível pelo orchestrator).
    chunkFiles.push(join(outDir, `scoring-chunk-${i}.json`).replaceAll("\\", "/"));
  });

  const manifest: SplitManifest = {
    total_articles: flattenCategorized(categorized).length,
    chunk_count: chunks.length,
    chunk_files: chunkFiles,
  };
  process.stdout.write(JSON.stringify(manifest) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
