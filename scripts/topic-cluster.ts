/**
 * topic-cluster.ts
 *
 * Agrupa artigos cobrindo o mesmo tema usando embedding similarity (Gemini)
 * com fallback para Jaccard similarity de tokens. Reduz buckets poluídos com
 * N artigos do mesmo evento (ex: Google Cloud Next coberto por blog.google +
 * techtudo.com.br).
 *
 * Modelo de embedding (#4654): `text-embedding-004` foi descontinuado pelo
 * Gemini (404) — confirmado ao vivo na edição 260806, 167/167 embeddings
 * falharam e o script caiu no fallback Jaccard SEM sinal visível pro editor
 * (só `console.warn`). Ponto único de config agora é
 * `platform.config.json > gemini.embedding_model` (mesmo padrão de
 * `gemini.translate_model` em eia-compose.ts), com fallback pro modelo
 * estável default (`DEFAULT_EMBEDDING_MODEL`) — ver `resolveEmbeddingModel`.
 *
 * Threshold default:
 *   - cosine (com GEMINI_API_KEY):  0.85  (documentado no CLI como --threshold 0.85)
 *   - Jaccard (fallback sem key):   0.5   (mais tolerante — tokens são esparsos)
 *
 * Uso:
 *   npx tsx scripts/topic-cluster.ts --in <categorized.json> --out <clustered.json> [--threshold 0.85] [--log-root-dir <path>]
 *
 * Input:  { lancamento: Article[], radar: Article[], use_melhor: Article[], video: Article[] }
 * Output: mesmo shape + { clusters: ClusterMetadata[], embedding_health: EmbeddingStats }
 *         com os artigos "runners-up" removidos dos buckets e capturados nos
 *         clusters pra rastreabilidade.
 *
 * Ranking intra-cluster:
 *   1. Fonte cadastrada (discovered_source=false) antes de discovered.
 *   2. Score maior primeiro (se presente).
 *   3. Ordem original como desempate final.
 *
 * Falha silenciosa (#4654): quando `--out` é passado, `embedding_health` é
 * também escrito num sidecar `topic-cluster-stats.json` na mesma pasta —
 * `scripts/lib/stage-1-validator.ts` (`validateEmbeddingHealth`) lê esse
 * arquivo e vira um WARN visível no gate humano da Etapa 1 quando
 * `key_present=true` e `failed>0` (GEMINI_API_KEY configurada mas o modelo
 * falhou — não é o caso esperado de "sem key = Jaccard por design"). Além
 * disso, falha com key presente também vai pro `data/run-log.jsonl`
 * (level `error` se 100% falhou, `warn` se parcial).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeCategorizedBuckets } from "./lib/categorized-buckets.ts"; // #1671
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";

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
  radar: Article[];
  use_melhor: Article[];
  video: Article[];
}

/**
 * Saúde do embedding batch (#4654) — visível pro editor via
 * `stage-1-validator.ts` (`validateEmbeddingHealth`), nunca só um
 * `console.warn` perdido no stderr.
 *
 * `key_present=false` é o caminho ESPERADO (sem GEMINI_API_KEY, Jaccard por
 * design) — nunca vira warning loud. `key_present=true` com `failed>0` é o
 * sinal real de degradação (modelo saiu do catálogo, quota, rede).
 */
export interface EmbeddingStats {
  model: string;
  key_present: boolean;
  attempted: number;
  failed: number;
  fail_rate: number;
  fallback_triggered: boolean;
  /**
   * Mensagem de erro quando `platform.config.json` existe mas não pôde ser
   * lido/parseado (#4654 fix segunda camada — mesma classe de "sinal
   * engolido" que o embedding fail-rate, um passo antes: se o config está
   * corrompido, `model` já é o default, sem confirmação editorial nenhuma).
   * `null`/ausente = config lido normalmente (ou ausente por design).
   */
  config_error?: string | null;
}

export interface ClusterOutput extends CategorizedInput {
  clusters: Cluster[];
  embedding_health: EmbeddingStats;
}

// #4654: text-embedding-004 saiu do catálogo Gemini (404). gemini-embedding-001
// é estável e não-preview (checado via ListModels na issue, 260805) — usado
// como fallback quando platform.config.json > gemini.embedding_model está
// ausente/ilegível.
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

export interface EmbeddingModelResolution {
  model: string;
  /** Mensagem de erro se `platform.config.json` existe mas não pôde ser
   *  lido/parseado. `null` = leitura OK (campo presente, ausente, ou o
   *  arquivo inteiro não existe — isso é caminho esperado, não erro). */
  configError: string | null;
}

/**
 * Resolve o modelo de embedding a partir de `platform.config.json >
 * gemini.embedding_model`, com fallback pra `DEFAULT_EMBEDDING_MODEL` quando
 * o campo está ausente ou o config não é legível (mesmo padrão de
 * `gemini.translate_model` em `eia-compose.ts`, #4654). Config corrompida
 * nunca é uma falha silenciosa — loga o motivo em stderr antes de cair no
 * default, e devolve o motivo em `configError` pra `main()` também rotear
 * pelo `run-log.jsonl` e pelo sidecar (achado #2 do fleet review do #4654 —
 * antes disso o único sinal era o `console.error`, a mesma classe de bug que
 * este PR existe pra matar, um nível acima).
 */
export function resolveEmbeddingModelWithDiagnostics(
  rootDir: string = process.cwd(),
): EmbeddingModelResolution {
  try {
    const cfgPath = resolve(rootDir, "platform.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      gemini?: { embedding_model?: string };
    };
    if (
      typeof cfg?.gemini?.embedding_model === "string" &&
      cfg.gemini.embedding_model.length > 0
    ) {
      return { model: cfg.gemini.embedding_model, configError: null };
    }
    return { model: DEFAULT_EMBEDDING_MODEL, configError: null };
  } catch (e) {
    const message = (e as Error).message;
    console.error(
      `topic-cluster: platform.config.json não lido (${message}); usando embedding_model default '${DEFAULT_EMBEDDING_MODEL}'`,
    );
    return { model: DEFAULT_EMBEDDING_MODEL, configError: message };
  }
}

/**
 * Wrapper de compat — só o `model`, sem diagnóstico. Usado por callers que
 * não precisam propagar `configError` (ex: testes existentes). `main()` usa
 * `resolveEmbeddingModelWithDiagnostics` diretamente pra não perder o sinal.
 */
export function resolveEmbeddingModel(rootDir: string = process.cwd()): string {
  return resolveEmbeddingModelWithDiagnostics(rootDir).model;
}

/**
 * Fetches a text embedding from the given Gemini embedding model.
 * Returns null when GEMINI_API_KEY is absent or the request fails.
 */
export async function embedText(
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
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
  if (a.size === 0 && b.size === 0) return 1; // #679: dois vazios = semanticamente idênticos
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

/** Constrói `EmbeddingStats` pro caso "sem GEMINI_API_KEY" — esperado por design, nunca warning loud. */
function noKeyStats(model: string): EmbeddingStats {
  return { model, key_present: false, attempted: 0, failed: 0, fail_rate: 0, fallback_triggered: true };
}

/**
 * Cluster greedy usando cosine similarity de embeddings (assíncrono).
 *
 * Faz batch de todas as chamadas de embedding ANTES de comparar pares (N
 * chamadas, não N²). Se qualquer embedding falhar, usa o vetor nulo e o
 * par cai abaixo do threshold — safe degradation.
 *
 * #4654: quando GEMINI_API_KEY está presente e os embeddings falham (modelo
 * fora do catálogo, quota, rede), o fallback pra Jaccard continua existindo
 * mas agora é reportado em `EmbeddingStats` — `key_present=true` distingue
 * essa degradação real do caminho esperado "sem key = Jaccard por design"
 * (`key_present=false`, nunca tratado como falha).
 */
export async function clusterArticlesWithEmbeddings(
  articles: Article[],
  threshold: number,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<{
  clusters: Array<{ members: Article[]; similarityMin: number; method: "cosine" | "jaccard" }>;
  stats: EmbeddingStats;
}> {
  // Sem key: nem tenta a API — caminho esperado, não é uma falha (#4654).
  if (!process.env.GEMINI_API_KEY) {
    return { clusters: clusterArticles(articles, Math.min(threshold, 0.5)), stats: noKeyStats(model) };
  }

  // Batch: buscar todos os embeddings em paralelo
  const texts = articles.map((a) => articleText(a));
  const embeddingResults = await Promise.all(texts.map((t) => embedText(t, model)));

  const attempted = embeddingResults.length;
  const failed = embeddingResults.filter((e) => e === null).length;
  const allNull = attempted > 0 && failed === attempted;
  const stats: EmbeddingStats = {
    model,
    key_present: true,
    attempted,
    failed,
    fail_rate: attempted > 0 ? failed / attempted : 0,
    fallback_triggered: allNull,
  };

  if (allNull) {
    // Fallback total para Jaccard.
    // Usa threshold Jaccard padrão (0.5) em vez do threshold cosine passado (0.85):
    // threshold=0.85 para Jaccard é extremamente alto e produziria quase zero clusters.
    const jaccardThreshold = Math.min(threshold, 0.5);
    console.warn(
      `topic-cluster: todos os ${attempted} embeddings falharam (model=${model}, GEMINI_API_KEY presente) — usando Jaccard com threshold=${jaccardThreshold}`,
    );
    return { clusters: clusterArticles(articles, jaccardThreshold), stats };
  }
  if (failed > 0) {
    console.warn(
      `topic-cluster: ${failed}/${attempted} embeddings falharam (model=${model}) — degradação parcial, fallback por-par pra Jaccard onde faltou`,
    );
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

  return {
    clusters: clusters.map((c) => ({ members: c.members, similarityMin: c.similarityMin, method: c.method })),
    stats,
  };
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
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<{ kept: Article[]; clusters: Cluster[]; stats: EmbeddingStats }> {
  const { clusters, stats } = await clusterArticlesWithEmbeddings(articles, threshold, model);
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
  return { kept, clusters: clusterMeta, stats };
}

/**
 * Agrega `EmbeddingStats` de N buckets num único sumário (#4654) — soma
 * attempted/failed, `key_present`/`fallback_triggered` são `true` se
 * qualquer bucket teve. `model` vem do primeiro bucket com `attempted > 0`
 * (todos os buckets usam o mesmo model — resolvido uma vez em `main()`).
 */
export function aggregateEmbeddingStats(statsList: EmbeddingStats[]): EmbeddingStats {
  const withAttempts = statsList.find((s) => s.attempted > 0);
  const model = withAttempts?.model ?? statsList[0]?.model ?? DEFAULT_EMBEDDING_MODEL;
  const attempted = statsList.reduce((sum, s) => sum + s.attempted, 0);
  const failed = statsList.reduce((sum, s) => sum + s.failed, 0);
  return {
    model,
    key_present: statsList.some((s) => s.key_present),
    attempted,
    failed,
    fail_rate: attempted > 0 ? failed / attempted : 0,
    fallback_triggered: statsList.some((s) => s.fallback_triggered),
  };
}

export async function clusterCategorized(
  input: CategorizedInput,
  threshold: number,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<ClusterOutput> {
  // #1629: cluster TODOS os 4 buckets. Antes só processava 3 e dropava
  // tutorial/video silenciosamente (#1628).
  // #1671: normalizeCategorizedBuckets garante `[]` (sem crash em shape legacy
  // sem os buckets novos) + remapeia pesquisa/noticias→radar, tutorial→use_melhor
  // (legacy categorized.json de resume pré-#1629 não some).
  const buckets = normalizeCategorizedBuckets<Article>(
    input as unknown as Record<string, unknown>,
  );
  const [l, r, u, v] = await Promise.all([
    clusterBucket(buckets.lancamento, threshold, model),
    clusterBucket(buckets.radar, threshold, model),
    clusterBucket(buckets.use_melhor, threshold, model),
    clusterBucket(buckets.video, threshold, model),
  ]);
  return {
    lancamento: l.kept,
    radar: r.kept,
    use_melhor: u.kept,
    video: v.kept,
    clusters: [...l.clusters, ...r.clusters, ...u.clusters, ...v.clusters],
    embedding_health: aggregateEmbeddingStats([l.stats, r.stats, u.stats, v.stats]),
  };
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
      "Uso: topic-cluster.ts --in <categorized.json> [--out <clustered.json>] [--threshold 0.85] [--log-root-dir <path>]",
    );
    process.exit(1);
  }

  // #3311/#3310 padrão: override SÓ pra isolamento de teste — sem a flag,
  // logEvent cai no default process.cwd() (produção roda da raiz do repo).
  const logRootDir = args["log-root-dir"];

  const { model, configError } = resolveEmbeddingModelWithDiagnostics();
  if (configError) {
    logEvent(
      {
        edition: null,
        stage: 1,
        agent: "topic-cluster.ts",
        level: "warn",
        message: `topic-cluster: platform.config.json não lido (${configError}) — caiu no embedding_model default '${DEFAULT_EMBEDDING_MODEL}' sem confirmação editorial.`,
        details: { config_error: configError, model_used: model },
      },
      logRootDir,
    );
  }
  const input = JSON.parse(readFileSync(inPath, "utf8")) as CategorizedInput;
  const result = await clusterCategorized(input, threshold, model);
  if (configError) {
    result.embedding_health = { ...result.embedding_health, config_error: configError };
  }

  // #1671: totalIn dos buckets NORMALIZADOS (não do input cru) — senão um
  // categorized.json legacy sem radar/use_melhor/video crasha aqui (`undefined.length`)
  // DEPOIS do cluster já ter rodado, descartando o resultado sem escrever o output.
  const inBuckets = normalizeCategorizedBuckets<Article>(input as unknown as Record<string, unknown>);
  const totalIn = inBuckets.lancamento.length + inBuckets.radar.length + inBuckets.use_melhor.length + inBuckets.video.length;
  const totalOut = result.lancamento.length + result.radar.length + result.use_melhor.length + result.video.length;
  const method = result.clusters[0]?.similarity_method ?? (hasKey ? "cosine" : "jaccard");
  console.error(
    `topic-cluster: ${totalIn} in → ${totalOut} kept, ${result.clusters.length} cluster(s) com runners-up (threshold=${threshold}, method=${method}, embedding_model=${model})`,
  );

  // #4654: falha silenciosa morre aqui. Sem GEMINI_API_KEY (key_present=false)
  // é o caminho esperado — nunca vira warning loud. Com key presente e
  // falhas > 0, é degradação real (modelo fora do catálogo, quota, rede):
  // sempre visível em stderr + data/run-log.jsonl, `error` se 100% falhou
  // (fallback total, o padrão que causou o bug #4654 em 260806), `warn` se
  // parcial.
  const health = result.embedding_health;
  if (health.key_present && health.failed > 0) {
    const allFailed = health.failed === health.attempted;
    const level = allFailed ? "error" : "warn";
    const message = allFailed
      ? `topic-cluster: 100% dos ${health.attempted} embeddings falharam (model=${health.model}) — fallback Jaccard ativo. Causa não confirmada por esta checagem (drift de catálogo Gemini #4654, quota ou rede indistinguíveis aqui); rode 'npx tsx scripts/validate-gemini-config.ts' ou confira platform.config.json > gemini.embedding_model.`
      : `topic-cluster: ${health.failed}/${health.attempted} embeddings falharam (model=${health.model}) — clustering parcialmente degradado.`;
    console.error(`⚠️ ${message}`);
    logEvent(
      { edition: null, stage: 1, agent: "topic-cluster.ts", level, message, details: health },
      logRootDir,
    );
  }

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote to ${outPath}`);
    // Sidecar de auditoria (#4654): `stage-1-validator.ts` lê este arquivo
    // pra virar um WARN visível no gate humano da Etapa 1 — não depende de
    // `embedding_health` sobreviver a transformações downstream do JSON
    // principal (filter-date-window.ts, dedup-intra-edition.ts, etc).
    const statsPath = resolve(dirname(outPath), "topic-cluster-stats.json");
    writeFileSync(statsPath, JSON.stringify(health, null, 2), "utf8");
    console.error(`Wrote embedding health to ${statsPath}`);
  } else {
    process.stdout.write(json);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
