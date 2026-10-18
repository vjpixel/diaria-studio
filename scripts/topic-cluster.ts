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
import { runCli } from "./lib/cli-exit.ts";
import { logEvent } from "./lib/run-log.ts";
import { isOfficialLancamentoUrl } from "./lib/launch-heuristics.ts"; // #8722
import { isPlaceholderHighlightTitle } from "./lib/placeholder-title-guard.ts"; // #10440
import {
  describeEmbeddingError,
  embeddingCauseSentence,
  normalizeEmbeddingErrorMessage,
  type EmbeddingError,
} from "./lib/gemini-embedding-error.ts"; // #10448

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
  /**
   * Embeddings de fato pedidos à API. Desde o #10440 NÃO inclui artigo sem
   * texto informativo (título placeholder + slug curto + summary boilerplate)
   * — esse não é embedado e conta em `skipped_uninformative`. Comparar com o
   * histórico anterior ao #10440: o `attempted` antigo equivale a
   * `attempted + skipped_uninformative`.
   */
  attempted: number;
  /** Falhas entre os `attempted` (nunca conta artigo pulado). */
  failed: number;
  /** `failed / attempted` — base é só o que foi tentado. */
  fail_rate: number;
  fallback_triggered: boolean;
  /**
   * #10440: artigos do lote sem texto informativo — não embedados, ficam solo
   * no cluster. Ausente em stats anteriores ao #10440 (equivale a 0).
   */
  skipped_uninformative?: number;
  /**
   * Mensagem de erro quando `platform.config.json` existe mas não pôde ser
   * lido/parseado (#4654 fix segunda camada — mesma classe de "sinal
   * engolido" que o embedding fail-rate, um passo antes: se o config está
   * corrompido, `model` já é o default, sem confirmação editorial nenhuma).
   * `null`/ausente = config lido normalmente (ou ausente por design).
   */
  config_error?: string | null;
  /**
   * #10448: contagem das falhas por status HTTP (`"402"`, `"404"`, …;
   * `"network"` quando não houve resposta HTTP). Ausente quando `failed=0`
   * ou em stats anteriores ao #10448.
   */
  errors_by_status?: Record<string, number>;
  /**
   * #10448: primeira falha observada (status + mensagem da API, chave
   * removida). É o que o gate do Stage 1 mostra como causa — antes o
   * `embedText` engolia a resposta e o aviso só podia dizer "causa não
   * confirmada".
   */
  first_error?: EmbeddingError | null;
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

export type EmbedResult = { values: number[]; error: null } | { values: null; error: EmbeddingError | null };

/**
 * Fetches a text embedding from the given Gemini embedding model.
 * Returns null when GEMINI_API_KEY is absent or the request fails.
 */
export async function embedText(
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<number[] | null> {
  return (await embedTextDetailed(text, model)).values;
}

/**
 * Igual a `embedText`, mas devolve a causa da falha (#10448): status HTTP +
 * `error.message` da API (chave removida). `error=null` com `values=null` só
 * quando GEMINI_API_KEY está ausente (não houve chamada).
 */
export async function embedTextDetailed(
  text: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<EmbedResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { values: null, error: null };
  let status: number | null = null;
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
    status = res.status;
    const raw = await res.text();
    let data: { embedding?: { values?: number[] }; error?: { message?: string; status?: string } } = {};
    try {
      data = JSON.parse(raw);
    } catch {
      // corpo não-JSON (página de erro de proxy etc.) — cai no erro abaixo com o texto cru
    }
    const values = data.embedding?.values;
    if (res.ok && Array.isArray(values) && values.length > 0) return { values, error: null };
    const apiMessage = data.error?.message
      ? `${data.error.status ? `${data.error.status}: ` : ""}${data.error.message}`
      : raw || `resposta sem embedding (HTTP ${res.status})`;
    return { values: null, error: { status: res.status, message: normalizeEmbeddingErrorMessage(apiMessage, apiKey) } };
  } catch (e) {
    return {
      values: null,
      error: { status, message: normalizeEmbeddingErrorMessage((e as Error)?.message ?? String(e), apiKey) },
    };
  }
}

/** Agrega as falhas de um lote em `errors_by_status` + `first_error` (#10448). */
export function summarizeEmbeddingErrors(
  errors: Array<EmbeddingError | null>,
): { errors_by_status: Record<string, number>; first_error: EmbeddingError | null } {
  const errors_by_status: Record<string, number> = {};
  let first_error: EmbeddingError | null = null;
  for (const err of errors) {
    if (!err) continue;
    const k = err.status === null ? "network" : String(err.status);
    errors_by_status[k] = (errors_by_status[k] ?? 0) + 1;
    if (!first_error) first_error = err;
  }
  return { errors_by_status, first_error };
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

// #10440: título sintético dos links extraídos de newsletter capturada
// (`(newsletter:{remetente})`, ver capture-newsletter-urls.ts). Não descreve o
// artigo — só o REMETENTE. Usado como texto de cluster, fazia todos os links
// da mesma newsletter (e, por encadeamento via "newsletter"/"ai", de outras)
// virarem "mesmo evento" (edição 261019: 30+ links, inclusive o DeepSeek V4.1
// Flash, descartados como duplicata de um roundup AWS de setembro).
//
// Reusa `isPlaceholderHighlightTitle` (lib, #4102) — `(newsletter:.*)`
// guloso, então remetente com parênteses no nome (`(newsletter:Foo (Bar))`)
// também casa. Somam-se os prefixos `[INBOX]`/`(inbox` que
// enrich-inbox-articles.ts trata como placeholder (título de submissão do
// inbox que o enrichment não conseguiu substituir).
function isPlaceholderTitle(title: string): boolean {
  const t = title.trim();
  return isPlaceholderHighlightTitle(t) || /^\[inbox\]/i.test(t) || /^\(inbox/i.test(t);
}

// #10440: segmentos de SEÇÃO do caminho (`/blogs/machine-learning/…`,
// `/news/…`, `/pt-br/…`) não falam do assunto do artigo — dois links do
// mesmo host compartilhariam esses tokens só por morarem na mesma seção.
// Ficam de fora do slug usado como texto de cluster. O último segmento é
// sempre mantido; segmentos anteriores que não são seção genérica também
// (ex.: o org do model card do HF, `deepseek-ai/DeepSeek-V4.1-Flash-1017`).
const GENERIC_PATH_SEGMENTS = new Set([
  "blog", "blogs", "news", "noticias", "notícias", "post", "posts", "p",
  "article", "articles", "artigo", "artigos", "story", "stories", "stories-and-news",
  "press", "press-release", "press-releases", "newsroom", "updates", "update",
  "research", "insights", "category", "categories", "tag", "tags", "topics", "topic",
  "machine-learning", "artificial-intelligence", "ai", "ia", "tech", "technology",
  "en", "en-us", "en-gb", "pt", "pt-br", "es", "amp", "index", "index.html",
]);

/** Slug do path sem seções genéricas e sem tokens puramente numéricos (data). */
export function topicSlugText(url: string): string {
  let segments: string[];
  try {
    segments = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
  } catch {
    return "";
  }
  const kept = segments.filter(
    (seg, i) => i === segments.length - 1 || !GENERIC_PATH_SEGMENTS.has(seg.toLowerCase()),
  );
  return kept
    .join(" ")
    .split(/[-_\s]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .join(" ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normSummary(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Texto usado pra comparar artigos no cluster (#10440). Diferente do texto
 * cru título+summary em dois pontos:
 *
 * 1. Título placeholder (`(newsletter:X)`, `(inbox)`, vazio) é descartado e
 *    substituído pelo slug da URL (`topicSlugText`: sem seções genéricas do
 *    caminho nem tokens puramente numéricos de data) —
 *    o slug costuma carregar o assunto (`deepseek-just-released-v4-1-flash`).
 * 2. Summary BOILERPLATE do site — o mesmo texto, idêntico, em ≥2 artigos do
 *    mesmo host no lote (ex.: meta description do Hugging Face "We're on a
 *    journey to advance and democratize artificial intelligence…" em todo
 *    model card/post) — é descartado. Sem isso, DeepSeek V4.1 Flash, Ling 3.1,
 *    FLUX.3 e o Beam da Reflection viravam "mesmo evento" só pelo summary.
 *
 * Artigo sem nenhum texto informativo resulta em string vazia — e
 * `clusterArticles`/`clusterArticlesWithEmbeddings` nunca o juntam a nada.
 */
export function clusterTexts(articles: Article[]): string[] {
  const summaryCount = new Map<string, number>();
  const keyOf = (a: Article): string | null => {
    const s = normSummary(a.summary ?? "");
    return s ? `${hostOf(a.url)}\u0000${s}` : null;
  };
  for (const a of articles) {
    const k = keyOf(a);
    if (k) summaryCount.set(k, (summaryCount.get(k) ?? 0) + 1);
  }
  return articles.map((a) => {
    const title = a.title ?? "";
    const parts: string[] = [];
    if (isPlaceholderTitle(title)) {
      const slug = topicSlugText(a.url);
      // Slug de 1 token só (`/tools`, encurtador `/90-wk2n`) não identifica
      // assunto — igualdade dele não prova "mesmo evento".
      if (tokenize(slug).size >= 2) parts.push(slug);
    } else {
      parts.push(title.trim());
    }
    const k = keyOf(a);
    if (k && (summaryCount.get(k) ?? 0) < 2) parts.push((a.summary ?? "").trim());
    return parts.join("\n");
  });
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
  const tokensByArt = clusterTexts(articles).map((t) => tokenize(t));
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
    // #10440: sem texto informativo não há como afirmar "mesmo evento" — o
    // artigo fica solo (jaccard(∅, ∅) = 1 juntaria todos os vazios).
    for (const c of toks.size === 0 ? [] : clusters) {
      for (let j = 0; j < c.members.length; j++) {
        if (c.memberTokens[j].size === 0) continue;
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
  const texts = clusterTexts(articles);
  const tokensByArt = texts.map((t) => tokenize(t));
  // #10440: artigo sem texto informativo não é embedado — fica solo, como no
  // caminho Jaccard. Não conta em attempted/failed (não houve chamada que
  // pudesse falhar); vai pra `skipped_uninformative`, de modo que
  // attempted + skipped_uninformative = tamanho do lote (o `attempted` de
  // antes do #10440).
  const informative = tokensByArt.map((t) => t.size > 0);
  const detailed = await Promise.all(
    texts.map((t, i) =>
      informative[i] ? embedTextDetailed(t, model) : Promise.resolve<EmbedResult>({ values: null, error: null }),
    ),
  );
  const embeddingResults = detailed.map((d) => d.values);

  const attempted = informative.filter(Boolean).length;
  const failed = embeddingResults.filter((e, i) => informative[i] && e === null).length;
  const allNull = attempted > 0 && failed === attempted;
  const stats: EmbeddingStats = {
    model,
    key_present: true,
    attempted,
    failed,
    fail_rate: attempted > 0 ? failed / attempted : 0,
    fallback_triggered: allNull,
    skipped_uninformative: articles.length - attempted,
  };
  if (failed > 0) {
    // #10448: a causa real (status HTTP + mensagem da API) vai pro sidecar —
    // sem isso o gate só podia dizer "drift, quota ou rede indistinguíveis".
    const summary = summarizeEmbeddingErrors(detailed.filter((_, i) => informative[i]).map((d) => d.error));
    stats.errors_by_status = summary.errors_by_status;
    stats.first_error = summary.first_error;
  }
  const causeSuffix = stats.first_error ? ` — causa: ${describeEmbeddingError(stats.first_error)}` : "";

  if (allNull) {
    // Fallback total para Jaccard.
    // Usa threshold Jaccard padrão (0.5) em vez do threshold cosine passado (0.85):
    // threshold=0.85 para Jaccard é extremamente alto e produziria quase zero clusters.
    const jaccardThreshold = Math.min(threshold, 0.5);
    console.warn(
      `topic-cluster: todos os ${attempted} embeddings falharam (model=${model}, GEMINI_API_KEY presente) — usando Jaccard com threshold=${jaccardThreshold}${causeSuffix}`,
    );
    return { clusters: clusterArticles(articles, jaccardThreshold), stats };
  }
  if (failed > 0) {
    console.warn(
      `topic-cluster: ${failed}/${attempted} embeddings falharam (model=${model}) — degradação parcial, fallback por-par pra Jaccard onde faltou${causeSuffix}`,
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
    const toks = tokensByArt[i];
    let assigned = false;

    for (const c of informative[i] ? clusters : []) {
      for (let j = 0; j < c.members.length; j++) {
        if (c.memberTokens[j].size === 0) continue;
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
 * Dentro de cada cluster, rankeia por: submissão do editor > domínio oficial
 * (#8722) > fonte cadastrada > discovered, score maior > menor, ordem
 * original como desempate.
 *
 * #8722: o `top_url` é o único membro que segue pro scoring. Sem os dois
 * primeiros critérios, o link oficial (`anthropic.com/...`, inclusive
 * submetido pelo editor) perdia pra cobertura de imprensa do mesmo cluster —
 * e a regra "LANÇAMENTOS só com link oficial" nem tinha candidato oficial
 * pra aplicar. A submissão do editor vem antes do oficial porque é escolha
 * explícita dele.
 */
export function rankWithinCluster(members: Article[]): Article[] {
  const tier = (a: Article): number => {
    if (a.flag === "editor_submitted") return 0;
    if (isOfficialLancamentoUrl(a.url)) return 1;
    return 2;
  };
  return [...members]
    .map((a, originalIndex) => ({ a, originalIndex, t: tier(a) }))
    .sort((x, y) => {
      if (x.t !== y.t) return x.t - y.t;
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
  const skipped = statsList.reduce((sum, s) => sum + (s.skipped_uninformative ?? 0), 0);
  const out: EmbeddingStats = {
    model,
    key_present: statsList.some((s) => s.key_present),
    attempted,
    failed,
    fail_rate: attempted > 0 ? failed / attempted : 0,
    fallback_triggered: statsList.some((s) => s.fallback_triggered),
    skipped_uninformative: skipped,
  };
  // #10448: soma as contagens por status e mantém a 1ª falha de qualquer bucket.
  if (failed > 0) {
    const byStatus: Record<string, number> = {};
    for (const s of statsList) {
      for (const [k, n] of Object.entries(s.errors_by_status ?? {})) byStatus[k] = (byStatus[k] ?? 0) + n;
    }
    out.errors_by_status = byStatus;
    out.first_error = statsList.find((s) => s.first_error)?.first_error ?? null;
  }
  return out;
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

async function main(): Promise<number | void> {
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
    return 1;
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
      ? `topic-cluster: 100% dos ${health.attempted} embeddings falharam (model=${health.model}) — fallback Jaccard ativo. ${embeddingCauseSentence(health)}`
      : `topic-cluster: ${health.failed}/${health.attempted} embeddings falharam (model=${health.model}) — clustering parcialmente degradado. ${embeddingCauseSentence(health)}`;
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
  // #9911: grava process.exitCode em vez de process.exit — no Windows (Node 24) o exit logo após um fetch sai 127.
  runCli(main);
}
