/**
 * topic-cluster.ts
 *
 * Agrupa artigos cobrindo o mesmo tema usando embedding similarity (Gemini
 * text-embedding-004) com fallback para Jaccard similarity de tokens.
 * Reduz buckets poluídos com N artigos do mesmo evento (ex: Google Cloud
 * Next coberto por blog.google + techtudo.com.br).
 *
 * Threshold default:
 *   - cosine (com GEMINI_API_KEY):  0.85  (documentado no CLI como --threshold 0.85)
 *   - Jaccard (fallback sem key):   0.5   (mais tolerante — tokens são esparsos)
 *
 * Uso:
 *   npx tsx scripts/topic-cluster.ts --in <categorized.json> --out <clustered.json> [--threshold 0.85]
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
  /** @deprecated use similarity_min instead — kept for backwards compat */
  jaccard_min: number;
  similarity_min: number;
  similarity_method: "cosine" | "jaccard";
}

export interface CategorizedInput {
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
}

export interface ClusterOutput extends CategorizedInput {
  clusters: Cluster[];
}

/**
 * Fetches a text embedding from the Gemini text-embedding-004 model.
 * Returns null when GEMINI_API_KEY is absent or the request fails.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "models/text-embedding-004",
          content: { parts: [{ text }] },
        }),
      }
    );
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? null;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between two vectors.
 * Returns 1.0 for identical vectors and -1.0 for opposite vectors.
 * Returns 0 for zero-length vectors to avoid division by zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

const STOPWORDS = new Set([
  "a", "o", "e", "um", "uma", "de", "da", "do", "em", "para", "por", "com",
  "que", "se", "na", "no", "as", "os", "ao", "aos", "das", "dos", "pela",
  "pelo", "pelas", "pelos", "is", "the", "an", "of", "in", "for", "to",
  "and", "on", "at", "by", "with", "are", "was", "were", "be", "been",
  "this", "that", "it", "as", "or", "but", "not",
]);

// Abreviações curtas (≤3 chars) com significado editorial forte em tech/IA.
// Excluídas do filtro de comprimento mínimo (#324).
const TECH_SHORT_TOKENS = new Set(["ia", "ai", "ml", "llm", "api", "gpt", "ui", "ux", "ceo", "cto", "br"]);

/**
 * Tokeniza título + summary: lowercase, remove diacritics, split por
 * não-alfanumerics, remove stopwords e tokens curtos (< 4 chars, exceto
 * TECH_SHORT_TOKENS como "ia", "llm", etc.) (#324).
 */
export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set<string>();
  for (const t of tokens) {
    if (t.length < 4 && !TECH_SHORT_TOKENS.has(t)) continue;
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
 * Cluster greedy usando Jaccard similarity (síncrono).
 * Itera artigos em ordem, assigna a cluster existente se Jaccard >= threshold
 * com qualquer membro; senão cria novo.
 */
export function clusterArticles(
  articles: Article[],
  threshold: number,
): Array<{ members: Article[]; similarityMin: number; method: "jaccard" }> {
  const tokensByArt = articles.map((a) => tokenize(articleText(a)));
  const clusters: Array<{
    members: Article[];
    memberTokens: Set<string>[];
    similarityMin: number;
    method: "jaccard";
  }> = [];

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
          c.similarityMin = Math.min(c.similarityMin, sim);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
    if (!assigned) {
      clusters.push({ members: [art], memberTokens: [toks], similarityMin: 1, method: "jaccard" });
    }
  }

  return clusters.map((c) => ({ members: c.members, similarityMin: c.similarityMin, method: c.method }));
}

/**
 * Cluster greedy usando cosine similarity de embeddings (assíncrono).
 *
 * Faz batch de todas as chamadas de embedding ANTES de comparar pares (N
 * chamadas, não N²). Se qualquer embedding falhar, usa o vetor nulo e o
 * par cai abaixo do threshold — safe degradation.
 *
 * Se nenhum embedding retornar, recai silenciosamente no Jaccard.
 */
export async function clusterArticlesWithEmbeddings(
  articles: Article[],
  threshold: number,
): Promise<Array<{ members: Article[]; similarityMin: number; method: "cosine" | "jaccard" }>> {
  // Batch: buscar todos os embeddings em paralelo
  const texts = articles.map((a) => articleText(a));
  const embeddingResults = await Promise.all(texts.map((t) => embedText(t)));

  const allNull = embeddingResults.every((e) => e === null);
  if (allNull) {
    // Fallback total para Jaccard
    console.warn("topic-cluster: GEMINI_API_KEY ausente ou todos os embeddings falharam — usando Jaccard como fallback");
    return clusterArticles(articles, threshold);
  }

  // Greedy cluster com cosine similarity
  const clusters: Array<{
    members: Article[];
    memberEmbeddings: (number[] | null)[];
    memberTokens: Set<string>[];
    similarityMin: number;
    method: "cosine" | "jaccard";
  }> = [];

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const emb = embeddingResults[i];
    const toks = tokenize(articleText(art));
    let assigned = false;

    for (const c of clusters) {
      for (let j = 0; j < c.members.length; j++) {
        let sim: number;
        const otherEmb = c.memberEmbeddings[j];
        if (emb !== null && otherEmb !== null) {
          sim = cosineSimilarity(emb, otherEmb);
        } else {
          // Fallback por par: ambos precisam de embedding; se um faltou, usa Jaccard
          sim = jaccard(toks, c.memberTokens[j]);
        }
        if (sim >= threshold) {
          c.members.push(art);
          c.memberEmbeddings.push(emb);
          c.memberTokens.push(toks);
          c.similarityMin = Math.min(c.similarityMin, sim);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
    if (!assigned) {
      clusters.push({
        members: [art],
        memberEmbeddings: [emb],
        memberTokens: [toks],
        similarityMin: 1,
        method: "cosine",
      });
    }
  }

  return clusters.map((c) => ({ members: c.members, similarityMin: c.similarityMin, method: c.method }));
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
 *
 * Usa embeddings quando GEMINI_API_KEY está disponível; fallback para Jaccard.
 * Threshold padrão para cosine: 0.85. Threshold padrão para Jaccard: 0.5.
 */
export async function clusterBucket(
  articles: Article[],
  threshold: number,
): Promise<{ kept: Article[]; clusters: Cluster[] }> {
  const clusters = await clusterArticlesWithEmbeddings(articles, threshold);
  const kept: Article[] = [];
  const clusterMeta: Cluster[] = [];
  for (const c of clusters) {
    const ranked = rankWithinCluster(c.members);
    kept.push(ranked[0]);
    if (ranked.length > 1) {
      const sim = Number(c.similarityMin.toFixed(3));
      clusterMeta.push({
        top_url: ranked[0].url,
        member_urls: ranked.map((a) => a.url),
        jaccard_min: sim, // backwards compat alias
        similarity_min: sim,
        similarity_method: c.method,
      });
    }
  }
  return { kept, clusters: clusterMeta };
}

export async function clusterCategorized(
  input: CategorizedInput,
  threshold: number,
): Promise<ClusterOutput> {
  const [l, p, n] = await Promise.all([
    clusterBucket(input.lancamento, threshold),
    clusterBucket(input.pesquisa, threshold),
    clusterBucket(input.noticias, threshold),
  ]);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inPath = args.in;
  const outPath = args.out;

  // Default threshold differs by method:
  //   cosine (GEMINI_API_KEY present): 0.85
  //   Jaccard (fallback):              0.5
  // The CLI flag --threshold overrides both.
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  const defaultThreshold = hasKey ? 0.85 : 0.5;
  const threshold = args.threshold ? parseFloat(args.threshold) : defaultThreshold;

  if (!inPath) {
    console.error(
      "Uso: topic-cluster.ts --in <categorized.json> [--out <clustered.json>] [--threshold 0.85]",
    );
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(inPath, "utf8")) as CategorizedInput;
  const result = await clusterCategorized(input, threshold);

  const totalIn = input.lancamento.length + input.pesquisa.length + input.noticias.length;
  const totalOut = result.lancamento.length + result.pesquisa.length + result.noticias.length;
  const method = result.clusters[0]?.similarity_method ?? (hasKey ? "cosine" : "jaccard");
  console.error(
    `topic-cluster: ${totalIn} in → ${totalOut} kept, ${result.clusters.length} cluster(s) com runners-up (threshold=${threshold}, method=${method})`,
  );

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
