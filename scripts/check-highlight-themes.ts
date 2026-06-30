/**
 * check-highlight-themes.ts (#2073, #2652)
 *
 * Compara os candidatos a destaque da edição corrente contra os TÍTULOS
 * DE DESTAQUE das últimas ~12 edições em `data/past-editions.md`.
 *
 * Problema reportado (#2073): o dedup URL+Jaccard tem janela curta (3 edições).
 * Uma URL inédita de tema repetido 7 edições atrás passa por todas as guards
 * de dedup, mas o editor reconhece o repeat visualmente. Este script detecta
 * o padrão e emite aviso destacado no gate da Etapa 1 — sem demotion automática.
 *
 * #2652: extensão para itens SECUNDÁRIOS (RADAR/LANÇAMENTOS). Detecta repetição
 * de empresa+sub-tema nos buckets secundários usando janela de 10 edições e
 * comparando contra 01-approved.json das edições anteriores. Caso real:
 * Nubank×contratações em 260626 e 260629 (mesma empresa, mesmo sub-tema).
 *
 * Algoritmo para DESTAQUES (dois passes):
 *   1. Jaccard de tokens normalizados entre título do candidato e título de
 *      edição passada (threshold >= 0.35 — mais permissivo que o dedup-vs-artigos
 *      de 0.6 porque compara headline-vs-headline, não artigo-vs-artigo).
 *   2. Entity overlap: se candidato e edição passada compartilham ≥1 entidade
 *      nomeada (capitalized token ≥4 chars, exceto stopwords), abaixar threshold
 *      pra 0.25 (mesmo evento com vocabulário divergente).
 *
 * Algoritmo para SECUNDÁRIOS (#2652, dois sinais obrigatórios):
 *   1. Entity overlap (incluindo 1ª palavra — empresas costumam estar no início):
 *      ≥1 entidade em comum (stopwords mais permissivos que o check de destaques).
 *   2. Tema em comum: Jaccard ≥ 0.15 OU sobreposição de prefixo ≥6 chars
 *      (pega variantes morfológicas PT-BR: contratar/contratações → "contrat").
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
 *     [--editions-dir data/editions] \
 *     [--secondary-window 10] \
 *     [--current-edition 260611] \
 *     [--out-json data/editions/260611/_internal/01-highlight-theme-check.json]
 *
 * Output JSON (stdout quando --out-json não passado):
 *   {
 *     "warnings": [...],           // destaques candidatos (destaque vs headline histórico)
 *     "secondary_warnings": [...], // RADAR/LANÇAMENTOS (#2652)
 *     "checked": 6,
 *     "secondary_checked": 12,
 *     "window": 12,
 *     "secondary_window": 10
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
  recentEditionDirs,
  deriveCurrentEdition,
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
// Core matching logic (highlights)
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
// Secondary bucket theme check (#2652)
//
// Detecta itens RADAR/LANÇAMENTOS da edição corrente que repetem uma
// combinação empresa+sub-tema de itens dos mesmos buckets nas últimas N edições.
//
// Diferenças do check de destaques:
//   1. Fonte de dados: lê radar/lancamento dos 01-approved.json das edições
//      anteriores (não dos headlines de past-editions.md).
//   2. Extração de entidades: inclui a 1ª palavra (empresas costumam ser
//      sujeito em headlines de RADAR: "Nubank prioriza..."). Stopwords mais
//      permissivos — só filtra termos ultra-genéricos do domínio IA.
//   3. Sobreposição de tema: Jaccard ≥ SECONDARY_JACCARD_THRESHOLD OU
//      sobreposição de prefixo ≥ SECONDARY_PREFIX_MIN_LEN (captura variantes
//      morfológicas PT-BR: contratar/contratações → prefixo "contra").
//   4. Janela: DEFAULT_SECONDARY_WINDOW = 10 (maior que o dedup de 3-4).
//
// WARN-ONLY — nunca bloqueia o gate. (#633 test required)
// ---------------------------------------------------------------------------

/**
 * Stopwords para extração de entidades em itens secundários — intencionalmente
 * permissivos. Mantém nomes de empresas (Google, Nubank, OpenAI) como entidades
 * válidas. Só filtra termos ubíquos do domínio IA que aparecem em quase toda
 * headline de RADAR e não discriminam tema.
 */
const ENTITY_STOPWORDS_SECONDARY = new Set([
  "ia", "ai", "ml", "llm", "gpt",
]);

/** Comprimento mínimo de entidade para check secundário (vs 4 no check de highlights).
 * 5 chars filtra palavras curtas comuns como "meta" (em PT = meta/objetivo). */
const SECONDARY_ENTITY_MIN_LEN = 5;

/** Janela padrão de edições para check de itens secundários (#2652). */
export const DEFAULT_SECONDARY_WINDOW = 10;

/**
 * Jaccard mínimo para sinalizar repeat de tema em item secundário.
 * Mais baixo que o check de destaques (0.35) porque também exigimos entity match —
 * o requisito duplo (entidade + tema) compensa o threshold mais permissivo.
 */
const SECONDARY_JACCARD_THRESHOLD = 0.15;

/**
 * Comprimento mínimo de prefixo para match morfológico PT-BR.
 * 6 chars captura variantes que compartilham o radical nos 6 primeiros chars:
 *   contratar/contratações → "contra", investir/investimento → "invest".
 * NÃO captura pares cujo radical diverge antes do 6º char (ex: demitir="demiti"
 * vs demissão="demiss") — esses dependem do sinal Jaccard.
 */
const SECONDARY_PREFIX_MIN_LEN = 6;

/**
 * Shape cru (parcial) de um item de bucket em 01-categorized.json / 01-approved.json.
 * Suporta `{ title, url }` direto e o wrapper `{ article: { title, url } }`.
 */
interface RawBucketItem {
  url?: string;
  title?: string;
  article?: { url?: string; title?: string };
}
type RawBuckets = Record<string, RawBucketItem[]>;

export interface SecondaryItem {
  bucket: string;  // "radar" | "lancamento" | "use_melhor"
  title: string;
  url: string;
}

export interface PastSecondaryItem {
  edition: string;  // AAMMDD (ex: "260626")
  title: string;
  bucket: string;
}

export interface SecondaryThemeWarning {
  bucket: string;
  item_url: string;
  item_title: string;
  matched_edition: string;
  matched_title: string;
  matched_bucket: string;
  shared_entities: string[];
  theme_evidence: string;  // "jaccard:0.18" ou "prefix:contra (contratar/contratacoes)"
  jaccard: number;
}

export interface CheckSecondaryThemesResult {
  secondary_warnings: SecondaryThemeWarning[];
  secondary_checked: number;
  secondary_window: number;
}

/**
 * Extrai entidades nomeadas incluindo a 1ª palavra (ao contrário de
 * extractNamedEntities de dedup.ts, que pula i=0). Headlines de RADAR
 * frequentemente começam com o nome da empresa ("Nubank prioriza...").
 *
 * Usa ENTITY_STOPWORDS_SECONDARY (permissivos) e exige ≥ SECONDARY_ENTITY_MIN_LEN.
 */
function extractSecondaryEntities(title: string): Set<string> {
  const entities = new Set<string>();
  const words = title.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^\p{L}\p{N}]/gu, "");
    if (clean.length < SECONDARY_ENTITY_MIN_LEN) continue;
    const firstChar = clean.charAt(0);
    if (firstChar !== firstChar.toUpperCase()) continue;
    if (firstChar === firstChar.toLowerCase()) continue; // não é letra
    const normalized = clean
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, ""); // strip combining diacritics (U+0300–U+036F)
    if (ENTITY_STOPWORDS_SECONDARY.has(normalized)) continue;
    entities.add(normalized);
  }
  return entities;
}

/**
 * Retorna o primeiro par de tokens (a, b) que compartilha um prefixo de ao menos
 * minPrefixLen chars, onde a ≠ b (evita self-match de token idêntico).
 * Captura variantes morfológicas PT-BR: contratar + contratações → prefixo "contra".
 *
 * Returns null quando não há sobreposição.
 */
function findPrefixTokenOverlap(
  tokensA: Set<string>,
  tokensB: Set<string>,
  minPrefixLen: number,
): { tokenA: string; tokenB: string; prefix: string } | null {
  for (const a of tokensA) {
    if (a.length < minPrefixLen) continue;
    const prefA = a.substring(0, minPrefixLen);
    for (const b of tokensB) {
      if (b.length >= minPrefixLen && b.startsWith(prefA) && a !== b) {
        return { tokenA: a, tokenB: b, prefix: prefA };
      }
    }
  }
  return null;
}

/**
 * Extrai itens dos buckets secundários do 01-categorized.json atual.
 * Suporta tanto { title, url } direto quanto { article: { title, url } }.
 *
 * @param categorizedPath  Caminho para _internal/01-categorized.json
 * @param buckets          Buckets a extrair (default: radar + lancamento)
 */
export function extractSecondaryItems(
  categorizedPath: string,
  buckets: string[] = ["radar", "lancamento"],
): SecondaryItem[] {
  if (!existsSync(categorizedPath)) return [];
  let data: RawBuckets;
  try {
    data = JSON.parse(readFileSync(categorizedPath, "utf8")) as RawBuckets;
  } catch {
    return [];
  }
  const items: SecondaryItem[] = [];
  for (const bucket of buckets) {
    const arr = data[bucket];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const art = item.article ?? {};
      const title = (art.title ?? item.title ?? "").trim();
      const url = (art.url ?? item.url ?? "").trim();
      if (title) items.push({ bucket, title, url });
    }
  }
  return items;
}

/**
 * Lê itens RADAR/LANÇAMENTOS dos 01-approved.json das `window` edições mais
 * recentes em `editionsDir`, excluindo `currentAammdd`.
 *
 * Falha gracioso: arquivo ausente/corrompido → skip silencioso.
 */
export function readPastApprovedSecondary(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
  buckets: string[] = ["radar", "lancamento"],
): PastSecondaryItem[] {
  if (!existsSync(editionsDir)) return [];
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);
  const items: PastSecondaryItem[] = [];

  for (const aammdd of recent) {
    // Tenta _internal/ primeiro (pós-#574), depois root (legado)
    const candidates = [
      resolve(editionsDir, aammdd, "_internal", "01-approved.json"),
      resolve(editionsDir, aammdd, "01-approved.json"),
    ];
    let parsed: RawBuckets | null = null;

    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as RawBuckets;
        break;
      } catch {
        continue;
      }
    }
    if (!parsed) continue;

    for (const bucket of buckets) {
      const arr = parsed[bucket];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const art = item.article ?? {};
        const title = (art.title ?? item.title ?? "").trim();
        if (title) items.push({ edition: aammdd, title, bucket });
      }
    }
  }
  return items;
}

/**
 * Verifica se itens dos buckets secundários (RADAR/LANÇAMENTOS) da edição corrente
 * repetem uma combinação empresa+sub-tema de itens das edições anteriores.
 *
 * Algoritmo (dois sinais obrigatórios):
 *   1. Entity overlap: ≥1 entidade em comum (inclui 1ª palavra, stopwords permissivos).
 *   2. Tema em comum: Jaccard ≥ SECONDARY_JACCARD_THRESHOLD
 *                     OU sobreposição de prefixo ≥ SECONDARY_PREFIX_MIN_LEN.
 *
 * WARN-ONLY — nunca bloqueia o gate. Exit code sempre 0.
 *
 * @param currentItems  Itens da edição corrente (de extractSecondaryItems)
 * @param pastItems     Itens das edições anteriores (de readPastApprovedSecondary)
 */
export function checkSecondaryThemes(
  currentItems: SecondaryItem[],
  pastItems: PastSecondaryItem[],
): CheckSecondaryThemesResult {
  const secondary_warnings: SecondaryThemeWarning[] = [];

  // Pré-computar tokens + entidades das edições passadas uma única vez
  interface PastSecondaryIndex {
    item: PastSecondaryItem;
    tokens: Set<string>;
    entities: Set<string>;
  }
  const pastIndex: PastSecondaryIndex[] = pastItems
    .map((item) => ({
      item,
      tokens: tokenizeForJaccard(item.title),
      entities: extractSecondaryEntities(item.title),
    }))
    .filter((idx) => idx.tokens.size > 0);

  for (const current of currentItems) {
    const currentTokens = tokenizeForJaccard(current.title);
    if (currentTokens.size === 0) continue;
    const currentEntities = extractSecondaryEntities(current.title);

    let bestWarning: SecondaryThemeWarning | null = null;
    let bestJaccardRaw = -1; // raw (não-arredondado) p/ comparar best-match sem viés de rounding

    for (const { item: past, tokens: pastTokens, entities: pastEntities } of pastIndex) {
      // Sinal 1: entity overlap obrigatório
      const sharedEntities: string[] = [];
      for (const e of currentEntities) {
        if (pastEntities.has(e)) sharedEntities.push(e);
      }
      if (sharedEntities.length === 0) continue;

      // Sinal 2: tema em comum via Jaccard OU prefix match
      const jaccard = jaccardSimilarity(currentTokens, pastTokens);
      const prefixOverlap = jaccard < SECONDARY_JACCARD_THRESHOLD
        ? findPrefixTokenOverlap(currentTokens, pastTokens, SECONDARY_PREFIX_MIN_LEN)
        : null;

      if (jaccard < SECONDARY_JACCARD_THRESHOLD && prefixOverlap === null) continue;

      const themeEvidence = jaccard >= SECONDARY_JACCARD_THRESHOLD
        ? `jaccard:${Math.round(jaccard * 100) / 100}`
        : `prefix:${prefixOverlap!.prefix} (${prefixOverlap!.tokenA}/${prefixOverlap!.tokenB})`;

      // Manter o melhor match (maior Jaccard) por item corrente. Compara o jaccard
      // RAW (não o campo arredondado) p/ não descartar match marginalmente melhor
      // quando o anterior arredondou pra cima (ex: 0.177 vs stored 0.18).
      if (bestWarning === null || jaccard > bestJaccardRaw) {
        bestJaccardRaw = jaccard;
        bestWarning = {
          bucket: current.bucket,
          item_url: current.url,
          item_title: current.title,
          matched_edition: past.edition,
          matched_title: past.title,
          matched_bucket: past.bucket,
          shared_entities: sharedEntities,
          theme_evidence: themeEvidence,
          jaccard: Math.round(jaccard * 100) / 100,
        };
      }
    }

    if (bestWarning) secondary_warnings.push(bestWarning);
  }

  const distinctEditions = new Set(pastItems.map((p) => p.edition));
  return {
    secondary_warnings,
    secondary_checked: currentItems.length,
    secondary_window: distinctEditions.size,
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
  // #2652: secondary check flags
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const secondaryWindow = parseInt(args["secondary-window"] ?? String(DEFAULT_SECONDARY_WINDOW), 10);
  // #2652: fallback p/ deriveCurrentEdition (espelha dedup.ts CLI #1856) — sem isso,
  // re-run/resume onde o 01-approved.json da edição atual já existe inclui a própria
  // edição na janela e gera self-match (Jaccard ~1.0) em todo item secundário.
  const currentEdition = args["current-edition"] ?? deriveCurrentEdition(args["categorized"]);

  if (!categorizedPath) {
    console.error(
      "Uso: check-highlight-themes.ts --categorized <path> [--past-editions <path>] [--window 12] " +
      "[--editions-dir data/editions] [--secondary-window 10] [--current-edition AAMMDD] [--out-json <path>]",
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
  const highlightResult = checkHighlightThemes(candidates, pastEditions);

  if (highlightResult.warnings.length > 0) {
    for (const w of highlightResult.warnings) {
      console.error(
        `[check-highlight-themes] ⚠️  Candidato #${w.candidate_rank} "${w.candidate_title}" repete tema de ${w.matched_edition} "${w.matched_title}" (Jaccard=${w.jaccard}, entities=[${w.shared_entities.join(",")}])`,
      );
    }
  } else {
    console.error(
      `[check-highlight-themes] ✓ ${highlightResult.checked} candidato(s) verificado(s) contra ${highlightResult.window} edição(ões) — nenhum repeat de tema detectado.`,
    );
  }

  // #2652: secondary check
  const secondaryItems = extractSecondaryItems(categorizedPath);
  const pastSecondary = readPastApprovedSecondary(editionsDir, secondaryWindow, currentEdition);
  const secondaryResult = checkSecondaryThemes(secondaryItems, pastSecondary);

  if (secondaryResult.secondary_warnings.length > 0) {
    for (const w of secondaryResult.secondary_warnings) {
      console.error(
        `[check-highlight-themes] ⚠️  SECUNDÁRIO [${w.bucket}] "${w.item_title}" repete tema de ${w.matched_edition} "${w.matched_title}" (${w.theme_evidence}, entities=[${w.shared_entities.join(",")}])`,
      );
    }
  } else {
    console.error(
      `[check-highlight-themes] ✓ ${secondaryResult.secondary_checked} item(ns) secundário(s) verificado(s) contra ${secondaryResult.secondary_window} edição(ões) — nenhum repeat de tema detectado.`,
    );
  }

  // Combina os dois resultados num único JSON (backward-compatible: novos campos adicionados)
  const combined = {
    warnings: highlightResult.warnings,
    secondary_warnings: secondaryResult.secondary_warnings,
    checked: highlightResult.checked,
    secondary_checked: secondaryResult.secondary_checked,
    window: highlightResult.window,
    secondary_window: secondaryResult.secondary_window,
  };

  const json = JSON.stringify(combined, null, 2);
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
