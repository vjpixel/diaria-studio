/**
 * finalize-stage1.ts (#720, #721)
 *
 * Encapsula os passos 1s do orchestrator (join de scores, filtro de score mínimo,
 * bypass de editor_submitted). Extraído do orchestrator para ser testável de forma
 * determinística.
 *
 * Responsabilidades:
 *   1. Join de scores: para cada artigo nos buckets, busca o score em `all_scored`
 *      por URL (igualdade de string). Se não encontrar (#720), tenta recovery por
 *      título normalizado e marca `score_recovered: true`.
 *   2. Filtro de score mínimo (#351): remove artigos com `score < 40` exceto
 *      - `flag === 'editor_submitted'` (inbox bypass)
 *      - artigos já em highlights ou runners_up
 *   3. Bypass editor_submitted endurece (#721): inbox bypass requer título
 *      não-placeholder, comprimento >= 15 e sem padrões de signup/meta.
 *      Falha → inclui o artigo mas marca `editor_submitted_placeholder: true`.
 *
 * Uso (via orchestrator — não chamado diretamente):
 *   import { joinScores, applyScoreFilter } from './finalize-stage1.ts';
 *
 * Ou como CLI (para debug):
 *   npx tsx scripts/finalize-stage1.ts \
 *     --scored data/editions/260506/_internal/tmp-scored.json \
 *     --categorized data/editions/260506/_internal/tmp-categorized.json \
 *     --out data/editions/260506/_internal/tmp-finalized.json \
 *     --edition 260506
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Article {
  url: string;
  title?: string;
  flag?: string;
  score?: number;
  score_recovered?: boolean;
  editor_submitted_placeholder?: boolean;
  [key: string]: unknown;
}

export interface ScoredEntry {
  url: string;
  score: number;
  [key: string]: unknown;
}

export interface ScoredOutput {
  highlights: Array<{ rank: number; score?: number; bucket: string; reason?: string; article?: Article; url?: string; [key: string]: unknown }>;
  runners_up: Array<{ article?: Article; url?: string; score?: number; [key: string]: unknown }>;
  all_scored: ScoredEntry[];
}

export interface CategorizedBuckets {
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
  tutorial?: Article[];
  video?: Article[];
  [key: string]: unknown;
}

export interface JoinResult {
  article: Article;
  url_mismatch: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normaliza título para comparação: lowercase, sem pontuação, sem espaços extras.
 * Usado pelo recovery de URL mismatch (#720).
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Join de score por URL exata. Se não encontrado, tenta recovery via título normalizado.
 *
 * Returns:
 *  - `article` com `score` injetado (e `score_recovered: true` se via title-recovery)
 *  - `url_mismatch: true` se o score veio de recovery (URL diferente)
 *
 * Se ainda assim não encontrar: `score: null`, `url_mismatch: true` — logar warn.
 *
 * @param article  Artigo do pool de categorized
 * @param scoreMap Map<url, ScoredEntry> (igualdade de string — #720: NUNCA normalizar)
 * @param scoredList Lista completa de all_scored (para title recovery)
 */
export function joinScore(
  article: Article,
  scoreMap: Map<string, ScoredEntry>,
  scoredList: ScoredEntry[],
  titleIndex: Map<string, ScoredEntry>,
): JoinResult {
  // Tentativa 1: join por URL string exata (#720: sem canonicalização)
  const byUrl = scoreMap.get(article.url);
  if (byUrl !== undefined) {
    return {
      article: { ...article, score: byUrl.score },
      url_mismatch: false,
    };
  }

  // Tentativa 2: recovery por título normalizado
  const artTitle = article.title ? normalizeTitle(article.title) : "";
  if (artTitle.length > 0) {
    const byTitle = titleIndex.get(artTitle);
    if (byTitle !== undefined) {
      return {
        article: {
          ...article,
          score: byTitle.score,
          score_recovered: true,
        },
        url_mismatch: true,
      };
    }
  }

  // Não encontrado
  return {
    article: { ...article, score: null as unknown as number },
    url_mismatch: true,
  };
}

/**
 * Constrói os índices usados por joinScore a partir de `all_scored`.
 */
export function buildScoreIndexes(allScored: ScoredEntry[]): {
  scoreMap: Map<string, ScoredEntry>;
  titleIndex: Map<string, ScoredEntry>;
} {
  const scoreMap = new Map<string, ScoredEntry>();
  const titleIndex = new Map<string, ScoredEntry>();

  for (const entry of allScored) {
    // URL index: igualdade de string exata — sem canonicalização (#720)
    scoreMap.set(entry.url, entry);
    // Title index: para recovery
    const t = (entry as { title?: string }).title;
    if (t) {
      const nt = normalizeTitle(t);
      if (nt.length > 0 && !titleIndex.has(nt)) {
        titleIndex.set(nt, entry);
      }
    }
  }

  return { scoreMap, titleIndex };
}

// ---------------------------------------------------------------------------
// Bypass checks (#721)
// ---------------------------------------------------------------------------

const PLACEHOLDER_TITLE_RE = /^\((inbox|no title|sem título)\)$/i;
const SIGNUP_META_RE = /buttondown|subscribe|newsletter|sign.?up/i;

/**
 * Checa se o bypass de editor_submitted é válido (#721).
 *
 * Retorna `true` se o bypass deve ser concedido (artigo não tem score mínimo
 * mas tem flag editor_submitted com título válido).
 * Retorna `false` + motivo se o bypass falhou — artigo ainda entra mas com
 * `editor_submitted_placeholder: true`.
 */
export function checkEditorSubmittedBypass(
  article: Article,
): { bypass: true } | { bypass: false; reason: string } {
  const title = (article.title ?? "").trim();

  if (!title || PLACEHOLDER_TITLE_RE.test(title)) {
    return { bypass: false, reason: "title_empty_or_placeholder" };
  }
  if (title.length < 15) {
    return { bypass: false, reason: "title_too_short" };
  }
  if (SIGNUP_META_RE.test(title)) {
    return { bypass: false, reason: "title_matches_signup_meta" };
  }

  return { bypass: true };
}

// ---------------------------------------------------------------------------
// Filtro de score mínimo (#351 + #721)
// ---------------------------------------------------------------------------

/**
 * Aplica o filtro de score mínimo em um bucket de artigos.
 *
 * Artigos removidos:
 *   - score < threshold (default 40) E não são bypass legítimos
 *
 * Bypass legítimo: flag === 'editor_submitted' com título válido (#721).
 * Bypass inválido: inclui o artigo mas marca editor_submitted_placeholder.
 *
 * Artigos em highlightUrls ou runnerUpUrls são preservados sem verificação.
 */
export function applyScoreFilter(
  articles: Article[],
  threshold: number,
  highlightUrls: Set<string>,
  runnerUpUrls: Set<string>,
): {
  kept: Article[];
  removed: Array<{ url: string; title?: string; score: number | null }>;
  bypassed: Article[];
  bypassed_placeholders: Article[];
} {
  const kept: Article[] = [];
  const removed: Array<{ url: string; title?: string; score: number | null }> = [];
  const bypassed: Article[] = [];
  const bypassed_placeholders: Article[] = [];

  for (const article of articles) {
    const score = article.score as number | null | undefined;
    const isInHighlights = highlightUrls.has(article.url);
    const isInRunnerUp = runnerUpUrls.has(article.url);

    // Artigos em highlights/runners_up passam sempre
    if (isInHighlights || isInRunnerUp) {
      kept.push(article);
      continue;
    }

    // Score ok → passa
    if (score !== null && score !== undefined && score >= threshold) {
      kept.push(article);
      continue;
    }

    // Score abaixo do threshold — verificar bypass
    if (article.flag === "editor_submitted") {
      const check = checkEditorSubmittedBypass(article);
      if (check.bypass) {
        bypassed.push(article);
        kept.push(article);
      } else {
        // Bypass falhou: inclui mas marca placeholder (#721)
        const marked: Article = { ...article, editor_submitted_placeholder: true };
        bypassed_placeholders.push(marked);
        kept.push(marked);
      }
      continue;
    }

    // Artigo removido
    removed.push({
      url: article.url,
      title: article.title,
      score: score ?? null,
    });
  }

  return { kept, removed, bypassed, bypassed_placeholders };
}

// ---------------------------------------------------------------------------
// Função principal: join + filtro nos buckets
// ---------------------------------------------------------------------------

/**
 * Aplica join de scores e filtro de score mínimo a todos os buckets.
 * Retorna os buckets enriquecidos e métricas de log.
 */
export function finalizeStage1(
  categorized: CategorizedBuckets,
  scoredOutput: ScoredOutput,
  options: { threshold?: number } = {},
): {
  buckets: CategorizedBuckets;
  url_mismatches: Array<{ article_url: string; article_title?: string }>;
  removed_total: number;
  bypass_placeholders: Array<{ url: string; title?: string }>;
} {
  const threshold = options.threshold ?? 40;
  const { scoreMap, titleIndex } = buildScoreIndexes(scoredOutput.all_scored);

  // URLs já em highlights e runners_up (excluídas do filtro de score)
  const highlightUrls = new Set<string>();
  for (const h of scoredOutput.highlights) {
    const url = h.url ?? h.article?.url;
    if (url) highlightUrls.add(url as string);
  }
  const runnerUpUrls = new Set<string>();
  for (const r of scoredOutput.runners_up) {
    const url = (r as { url?: string }).url ?? (r as { article?: { url?: string } }).article?.url;
    if (url) runnerUpUrls.add(url as string);
  }

  const urlMismatches: Array<{ article_url: string; article_title?: string }> = [];
  let removedTotal = 0;
  const bypassPlaceholders: Array<{ url: string; title?: string }> = [];

  const bucketNames = ["lancamento", "pesquisa", "noticias", "tutorial", "video"] as const;
  const enriched: Record<string, Article[]> = {};

  for (const bucket of bucketNames) {
    const articles = (categorized[bucket] as Article[] | undefined) ?? [];

    // Step 1: join scores
    const joined: Article[] = [];
    for (const article of articles) {
      const { article: enrichedArticle, url_mismatch } = joinScore(
        article,
        scoreMap,
        scoredOutput.all_scored,
        titleIndex,
      );
      joined.push(enrichedArticle);
      if (url_mismatch) {
        urlMismatches.push({ article_url: article.url, article_title: article.title });
      }
    }

    // Step 2: sort by score desc (null scores go last)
    joined.sort((a, b) => {
      const sa = (a.score as number | null | undefined) ?? -1;
      const sb = (b.score as number | null | undefined) ?? -1;
      return sb - sa;
    });

    // Step 3: apply score filter
    const { kept, removed, bypassed_placeholders } = applyScoreFilter(
      joined,
      threshold,
      highlightUrls,
      runnerUpUrls,
    );

    enriched[bucket] = kept;
    removedTotal += removed.length;
    for (const bp of bypassed_placeholders) {
      bypassPlaceholders.push({ url: bp.url, title: bp.title });
    }
  }

  return {
    buckets: {
      ...categorized,
      ...enriched,
    },
    url_mismatches: urlMismatches,
    removed_total: removedTotal,
    bypass_placeholders: bypassPlaceholders,
  };
}

// ---------------------------------------------------------------------------
// CLI (debug)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function logWarn(edition: string | null, message: string, details: unknown): void {
  const args = [
    "npx", "tsx", "scripts/log-event.ts",
    "--level", "warn",
    "--agent", "finalize-stage1",
    "--message", message,
    "--details", JSON.stringify(details),
  ];
  if (edition) args.push("--edition", edition, "--stage", "1");
  spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: "inherit" });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scoredPath = args["scored"];
  const categorizedPath = args["categorized"];
  const outPath = args["out"];
  const edition = args["edition"] ?? null;

  if (!scoredPath || !categorizedPath || !outPath) {
    console.error(
      "Uso: finalize-stage1.ts --scored <tmp-scored.json> --categorized <tmp-categorized.json> --out <tmp-finalized.json> [--edition AAMMDD]",
    );
    process.exit(1);
  }

  const scoredOutput: ScoredOutput = JSON.parse(readFileSync(resolve(ROOT, scoredPath), "utf8"));
  const raw = JSON.parse(readFileSync(resolve(ROOT, categorizedPath), "utf8"));
  // categorized pode ser `{ kept: { lancamento, pesquisa, noticias } }` ou flat
  const categorized: CategorizedBuckets = raw.kept ?? raw;

  const { buckets, url_mismatches, removed_total, bypass_placeholders } = finalizeStage1(
    categorized,
    scoredOutput,
  );

  // Log warn por URL mismatches (#720)
  if (url_mismatches.length > 0) {
    console.warn(
      `[finalize-stage1] WARN: ${url_mismatches.length} URL mismatch(es) entre scorer e pool`,
    );
    for (const m of url_mismatches) {
      const truncTitle = m.article_title ? m.article_title.slice(0, 80) : "(sem título)";
      console.warn(`  - ${truncTitle} | url: ${m.article_url}`);
    }
    logWarn(edition, "scorer URL mismatch(es) detectados", {
      count: url_mismatches.length,
      mismatches: url_mismatches.map((m) => ({
        url: m.article_url,
        title: m.article_title?.slice(0, 80),
      })),
    });
  }

  if (removed_total > 0) {
    console.warn(`[finalize-stage1] scorer threshold filter: removidos ${removed_total} artigos com score < 40`);
  }

  // Log bypass placeholders (#721)
  for (const bp of bypass_placeholders) {
    console.warn(
      `[finalize-stage1] inbox bypass strict-mode failed: title too short or placeholder | url: ${bp.url} | title: ${bp.title?.slice(0, 80) ?? ""}`,
    );
  }

  writeFileSync(resolve(ROOT, outPath), JSON.stringify(buckets, null, 2), "utf8");
  process.stdout.write(
    JSON.stringify({
      out: outPath,
      url_mismatches: url_mismatches.length,
      removed_total,
      bypass_placeholders: bypass_placeholders.length,
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
