/**
 * topic-cluster.ts
 *
 * Agrupa artigos cobrindo o mesmo tema usando Jaccard similarity de tokens
 * de título + summary. Reduz buckets poluídos com N artigos do mesmo evento
 * (ex: Google Cloud Next coberto por blog.google + techtudo.com.br).
 *
 * Threshold default 0.5 é mais tolerante que o 0.85 de `dedup.ts` — dedup
 * só pega reescritas quase literais, clustering pega mesmo evento com
 * ângulos variantes.
 *
 * Uso:
 *   npx tsx scripts/topic-cluster.ts --in <categorized.json> --out <clustered.json> [--threshold 0.5]
 *
 * Input:  { lancamento: Article[], pesquisa: Article[], noticias: Article[] }
 * Output: mesmo shape + { clusters: ClusterMetadata[] } com os artigos
 *         "runners-up" removidos dos buckets e capturados nos clusters
 *         pra rastreabilidade.
 *
 * Ranking intra-cluster:
 *   1. Fonte cadastrada (discovered_source=false) antes de discovered.
 *   2. Score maior primeiro (se presente).
 *   3. Ordem original como desempate final.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Article {
  url: string;
  title?: string;
  summary?: string;
  discovered_source?: boolean;
  score?: number;
  category?: string;
  [key: string]: unknown;
}

export interface Cluster {
  top_url: string;
  member_urls: string[];
  jaccard_min: number;
}

export interface CategorizedInput {
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
}

export interface ClusterOutput extends CategorizedInput {
  clusters: Cluster[];
}

const STOPWORDS = new Set([
  "a", "o", "e", "um", "uma", "de", "da", "do", "em", "para", "por", "com",
  "que", "se", "na", "no", "as", "os", "ao", "aos", "das", "dos", "pela",
  "pelo", "pelas", "pelos", "is", "the", "an", "of", "in", "for", "to",
  "and", "on", "at", "by", "with", "are", "was", "were", "be", "been",
  "this", "that", "it", "as", "or", "but", "not",
]);

/**
 * Tokeniza título + summary: lowercase, remove diacritics, split por
 * não-alfanumerics, remove stopwords e tokens curtos (< 4 chars pra
 * focar em palavras de conteúdo).
 */
export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set<string>();
  for (const t of tokens) {
    if (t.length < 4) continue;
    if (STOPWORDS.has(t)) continue;
    set.add(t);
  }
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const unionSize = a.size + b.size - intersect;
  return unionSize === 0 ? 0 : intersect / unionSize;
}

function articleText(a: Article): string {
  return `${a.title ?? ""}\n${a.summary ?? ""}`;
}

/**
 * Cluster greedy: itera artigos em ordem, assigna a cluster existente se
 * Jaccard >= threshold com qualquer membro; senão cria novo.
 */
export function clusterArticles(
  articles: Article[],
  threshold: number,
): Array<{ members: Article[]; jaccardMin: number }> {
  const tokensByArt = articles.map((a) => tokenize(articleText(a)));
  const clusters: Array<{ members: Article[]; memberTokens: Set<string>[]; jaccardMin: number }> = [];

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const toks = tokensByArt[i];
    let assigned = false;
    for (const c of clusters) {
      for (let j = 0; j < c.members.length; j++) {
        const sim = jaccard(toks, c.memberTokens[j]);
        if (sim >= threshold) {
          c.members.push(art);
          c.memberTokens.push(toks);
          c.jaccardMin = Math.min(c.jaccardMin, sim);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
    if (!assigned) {
      clusters.push({ members: [art], memberTokens: [toks], jaccardMin: 1 });
    }
  }

  return clusters.map((c) => ({ members: c.members, jaccardMin: c.jaccardMin }));
}

/**
 * Dentro de cada cluster, rankeia por: fonte cadastrada > discovered,
 * score maior > menor, ordem original como desempate.
 */
export function rankWithinCluster(members: Article[]): Article[] {
  return [...members]
    .map((a, originalIndex) => ({ a, originalIndex }))
    .sort((x, y) => {
      const xDisc = x.a.discovered_source ? 1 : 0;
      const yDisc = y.a.discovered_source ? 1 : 0;
      if (xDisc !== yDisc) return xDisc - yDisc;
      const xScore = typeof x.a.score === "number" ? x.a.score : -Infinity;
      const yScore = typeof y.a.score === "number" ? y.a.score : -Infinity;
      if (xScore !== yScore) return yScore - xScore;
      return x.originalIndex - y.originalIndex;
    })
    .map((w) => w.a);
}

/**
 * Aplica cluster + ranking a um bucket, retornando só os "top" de cada
 * cluster + a metadata dos clusters (com runners-up pra rastreabilidade).
 */
export function clusterBucket(
  articles: Article[],
  threshold: number,
): { kept: Article[]; clusters: Cluster[] } {
  const clusters = clusterArticles(articles, threshold);
  const kept: Article[] = [];
  const clusterMeta: Cluster[] = [];
  for (const c of clusters) {
    const ranked = rankWithinCluster(c.members);
    kept.push(ranked[0]);
    if (ranked.length > 1) {
      clusterMeta.push({
        top_url: ranked[0].url,
        member_urls: ranked.map((a) => a.url),
        jaccard_min: Number(c.jaccardMin.toFixed(3)),
      });
    }
  }
  return { kept, clusters: clusterMeta };
}

export function clusterCategorized(
  input: CategorizedInput,
  threshold: number,
): ClusterOutput {
  const l = clusterBucket(input.lancamento, threshold);
  const p = clusterBucket(input.pesquisa, threshold);
  const n = clusterBucket(input.noticias, threshold);
  return {
    lancamento: l.kept,
    pesquisa: p.kept,
    noticias: n.kept,
    clusters: [...l.clusters, ...p.clusters, ...n.clusters],
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inPath = args.in;
  const outPath = args.out;
  const threshold = args.threshold ? parseFloat(args.threshold) : 0.5;

  if (!inPath) {
    console.error("Uso: topic-cluster.ts --in <categorized.json> [--out <clustered.json>] [--threshold 0.5]");
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(inPath, "utf8")) as CategorizedInput;
  const result = clusterCategorized(input, threshold);

  const totalIn = input.lancamento.length + input.pesquisa.length + input.noticias.length;
  const totalOut = result.lancamento.length + result.pesquisa.length + result.noticias.length;
  console.error(
    `topic-cluster: ${totalIn} in → ${totalOut} kept, ${result.clusters.length} cluster(s) com runners-up (threshold=${threshold})`,
  );

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

const _argv1 = process.argv[1] ?? "";
if (process.argv[1] && import.meta.url === `file://${_argv1}` || import.meta.url === fileURLToPath(import.meta.url)) {
  // CLI guard simples
}
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
