/**
 * check-highlight-themes.ts (#2073)
 *
 * Compara os candidatos a destaque da edição corrente contra os TÍTULOS
 * DE DESTAQUE das últimas ~12 edições em `data/past-editions.md`.
 *
 * Problema reportado (#2073): o dedup URL+Jaccard tem janela curta (3 edições).
 * Uma URL inédita de tema repetido 7 edições atrás passa por todas as guards
 * de dedup, mas o editor reconhece o repeat visualmente. Este script detecta
 * o padrão e emite aviso destacado no gate da Etapa 1 — sem demotion automática.
 *
 * Algoritmo (dois passes):
 *   1. Jaccard de tokens normalizados entre título do candidato e título de
 *      edição passada (threshold >= 0.35 — mais permissivo que o dedup-vs-artigos
 *      de 0.6 porque compara headline-vs-headline, não artigo-vs-artigo).
 *   2. Entity overlap: se candidato e edição passada compartilham ≥1 entidade
 *      nomeada (capitalized token ≥4 chars, exceto stopwords), abaixar threshold
 *      pra 0.25 (mesmo evento com vocabulário divergente).
 *
 * Falso-positivo guard: mesmo com entity overlap, títulos com entidades muito
 * genéricas (empresa + produto novo, ex: "Google lança X" vs "Google demite 100")
 * precisam de tema em comum. Para isso, o threshold nunca cai abaixo de 0.25
 * e o match de entidade exige que a entidade NÃO esteja em ENTITY_STOPWORDS.
 *
 * Uso (via orchestrator — não chamado diretamente):
 *   npx tsx scripts/check-highlight-themes.ts \
 *     --categorized data/editions/260611/_internal/01-categorized.json \
 *     --past-editions data/past-editions.md \
 *     [--window 12] \
 *     [--out-json data/editions/260611/_internal/01-highlight-theme-check.json]
 *
 * Output JSON (stdout quando --out-json não passado):
 *   {
 *     "warnings": [
 *       {
 *         "candidate_rank": 1,
 *         "candidate_title": "Gemma 4 12B: encoder-free multimodal",
 *         "matched_edition": "2026-06-04",
 *         "matched_title": "Gemma 4 12B: multimodal que roda no laptop",
 *         "jaccard": 0.43,
 *         "shared_entities": [],
 *         "effective_threshold": 0.35
 *       }
 *     ],
 *     "checked": 6,
 *     "window": 12
 *   }
 *
 * Exit codes:
 *   0 — sempre (warnings são non-fatal — gate decide)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
  extractNamedEntities,
} from "./dedup.ts";

// ---------------------------------------------------------------------------
// Entity stopwords — entidades tão genéricas que não discriminam tema
// (ex: "Google" sozinho não confirma que o tema é o mesmo — Google lança
// coisas novas todo dia). Compartilhadas com dedup.ts via re-export.
// ---------------------------------------------------------------------------

// Termos genéricos para o check de tema highlights.
// Mais conservador que GENERIC_DEDUP_WORDS — permite detectar produtos
// específicos (Gemma, GPT-4o) mas bloqueia empresas e plataformas genéricas.
const ENTITY_STOPWORDS_HIGHLIGHT = new Set([
  // Empresas grandes (muito frequentes em headlines de IA)
  "google", "microsoft", "apple", "amazon", "meta", "nvidia", "openai",
  "anthropic", "deepmind", "deepseek", "mistral", "cohere",
  // Plataformas e assistentes genéricos
  "gemini", "chatgpt", "claude", "copilot", "grok", "perplexity",
  "codex", "cursor", "alexa", "siri",
  // Palavras de domínio muito comuns
  "modelo", "model", "agent", "agente", "plugin", "api", "sdk",
  // PT-BR muito comuns
  "regulacao", "mercado", "brasil", "lanca", "novo", "nova", "vers",
  // EN muito comuns
  "launch", "new", "update", "next", "first", "best",
]);

// ---------------------------------------------------------------------------
// Past-editions parser (local, leve — não importar dedup inteiro)
// ---------------------------------------------------------------------------

export interface PastEditionEntry {
  date: string;    // YYYY-MM-DD
  title: string;   // título da edição (do header ## YYYY-MM-DD — "...")
}

/**
 * Extrai os títulos de destaque das últimas `window` edições de `past-editions.md`.
 * Cada edição tem 1 título (o headline do destaque principal) no header.
 */
export function extractPastEditionTitles(
  md: string,
  window: number,
): PastEditionEntry[] {
  const entries: PastEditionEntry[] = [];
  if (!md.trim()) return entries;

  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  // Captura até a ÚLTIMA aspas da linha para suportar títulos com aspas internas
  // Ex: ## 2026-06-10 — "O modelo "melhor" do mercado" → captura 'O modelo "melhor" do mercado'
  // \r? antes do $ para tolerância CRLF (hardening de portabilidade Windows).
  const sectionRe = /^## (\d{4}-\d{2}-\d{2})[^"]*"(.+)"\r?$/m;

  for (const part of parts) {
    if (entries.length >= window) break;
    const m = part.match(sectionRe);
    if (!m) continue;
    entries.push({ date: m[1], title: m[2] });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Candidate highlight extractor
// ---------------------------------------------------------------------------

interface HighlightCandidate {
  rank: number;
  title: string;
  url: string;
}

interface CategorizedHighlight {
  rank?: number;
  score?: number;
  article?: { title?: string; url?: string };
  url?: string;
  title?: string;
  [key: string]: unknown;
}

interface CategorizedJson {
  highlights?: CategorizedHighlight[];
  [key: string]: unknown;
}

export function extractHighlightCandidates(
  categorizedPath: string,
): HighlightCandidate[] {
  if (!existsSync(categorizedPath)) return [];
  let data: CategorizedJson;
  try {
    data = JSON.parse(readFileSync(categorizedPath, "utf8")) as CategorizedJson;
  } catch {
    return [];
  }
  const highlights = data.highlights ?? [];
  return highlights
    .map((h, idx) => {
      const art = h.article ?? {};
      const title = art.title ?? h.title ?? "";
      const url = art.url ?? h.url ?? "";
      const rank = h.rank ?? idx + 1;
      return { rank, title: title.trim(), url: url.trim() };
    })
    .filter((h) => h.title.length > 0);
}

// ---------------------------------------------------------------------------
// Core matching logic
// ---------------------------------------------------------------------------

export const DEFAULT_HIGHLIGHT_WINDOW = 12;
const JACCARD_THRESHOLD = 0.35;
const JACCARD_THRESHOLD_WITH_ENTITY = 0.25;

export interface HighlightThemeWarning {
  candidate_rank: number;
  candidate_title: string;
  candidate_url: string;
  matched_edition: string;
  matched_title: string;
  jaccard: number;
  shared_entities: string[];
  effective_threshold: number;
}

export interface CheckHighlightThemesResult {
  warnings: HighlightThemeWarning[];
  checked: number;
  window: number;
}

/**
 * Extrai entidades nomeadas discriminantes de um título.
 * Usa extractNamedEntities de dedup.ts + filtra pelo stopwords específico
 * de highlights (mais conservador que o dedup geral).
 */
function extractHighlightEntities(title: string): Set<string> {
  // Start from dedup.ts named entities (non-sentence-start capitalized words ≥4 chars)
  const raw = extractNamedEntities(title);
  // Filter using the conservative highlight stopwords
  const result = new Set<string>();
  for (const e of raw) {
    if (!ENTITY_STOPWORDS_HIGHLIGHT.has(e)) result.add(e);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pre-computed index for past editions (tokens + entities computed once)
// ---------------------------------------------------------------------------

interface PastEditionIndex {
  entry: PastEditionEntry;
  tokens: Set<string>;
  entities: Set<string>;
}

/**
 * Pré-computa tokens e entidades de cada edição passada UMA vez.
 * Evita recomputar janela × candidatos (padrão de dedup.ts ~900).
 */
function buildPastIndex(pastEditions: PastEditionEntry[]): PastEditionIndex[] {
  return pastEditions
    .map((entry) => ({
      entry,
      tokens: tokenizeForJaccard(entry.title),
      entities: extractHighlightEntities(entry.title),
    }))
    .filter((idx) => idx.tokens.size > 0);
}

/**
 * Compara um candidato a destaque contra o índice pré-computado de edições passadas.
 * Retorna o melhor match (se acima do threshold) ou null.
 */
function findThemeMatch(
  candidate: HighlightCandidate,
  pastIndex: PastEditionIndex[],
): HighlightThemeWarning | null {
  const candidateTokens = tokenizeForJaccard(candidate.title);
  if (candidateTokens.size === 0) return null;

  const candidateEntities = extractHighlightEntities(candidate.title);

  let bestMatch: HighlightThemeWarning | null = null;

  for (const { entry: past, tokens: pastTokens, entities: pastEntities } of pastIndex) {
    // Compute shared entities
    const sharedEntities: string[] = [];
    for (const e of candidateEntities) {
      if (pastEntities.has(e)) sharedEntities.push(e);
    }

    // Determine effective threshold
    const effectiveThreshold = sharedEntities.length > 0
      ? JACCARD_THRESHOLD_WITH_ENTITY
      : JACCARD_THRESHOLD;

    const jaccard = jaccardSimilarity(candidateTokens, pastTokens);

    if (jaccard >= effectiveThreshold) {
      if (bestMatch === null || jaccard > bestMatch.jaccard) {
        bestMatch = {
          candidate_rank: candidate.rank,
          candidate_title: candidate.title,
          candidate_url: candidate.url,
          matched_edition: past.date,
          matched_title: past.title,
          jaccard: Math.round(jaccard * 100) / 100,
          shared_entities: sharedEntities,
          effective_threshold: effectiveThreshold,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Checks all highlight candidates for theme repeats against past editions.
 * Main exported function — also used directly by tests.
 */
export function checkHighlightThemes(
  candidates: HighlightCandidate[],
  pastEditions: PastEditionEntry[],
): CheckHighlightThemesResult {
  const warnings: HighlightThemeWarning[] = [];

  // Pré-computar tokens/entidades das edições passadas uma única vez
  const pastIndex = buildPastIndex(pastEditions);

  for (const candidate of candidates) {
    const match = findThemeMatch(candidate, pastIndex);
    if (match) warnings.push(match);
  }

  return {
    warnings,
    checked: candidates.length,
    window: pastEditions.length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)).values;

  const categorizedPath = args["categorized"];
  const pastEditionsPath = args["past-editions"] ?? "data/past-editions.md";
  const window = parseInt(args["window"] ?? String(DEFAULT_HIGHLIGHT_WINDOW), 10);
  const outJson = args["out-json"];

  if (!categorizedPath) {
    console.error(
      "Uso: check-highlight-themes.ts --categorized <path> [--past-editions <path>] [--window 12] [--out-json <path>]",
    );
    process.exit(1);
  }

  // Read past editions (graceful if missing — bootstrap / CI)
  let pastMd = "";
  if (existsSync(pastEditionsPath)) {
    pastMd = readFileSync(pastEditionsPath, "utf8");
  } else {
    console.error(
      `[check-highlight-themes] WARN: ${pastEditionsPath} não encontrado — sem histórico, nenhum warn de tema emitido.`,
    );
  }

  const pastEditions = extractPastEditionTitles(pastMd, window);
  const candidates = extractHighlightCandidates(categorizedPath);
  const result = checkHighlightThemes(candidates, pastEditions);

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.error(
        `[check-highlight-themes] ⚠️  Candidato #${w.candidate_rank} "${w.candidate_title}" repete tema de ${w.matched_edition} "${w.matched_title}" (Jaccard=${w.jaccard}, entities=[${w.shared_entities.join(",")}])`,
      );
    }
  } else {
    console.error(
      `[check-highlight-themes] ✓ ${result.checked} candidato(s) verificado(s) contra ${result.window} edição(ões) — nenhum repeat de tema detectado.`,
    );
  }

  const json = JSON.stringify(result, null, 2);
  if (outJson) {
    writeFileSync(resolve(outJson), json, "utf8");
    console.error(`[check-highlight-themes] Wrote ${outJson}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  runMain(main);
}
