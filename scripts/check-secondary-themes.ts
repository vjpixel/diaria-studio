/**
 * check-secondary-themes.ts (#2605)
 *
 * Detecta repetição de TEMA de itens SECUNDÁRIOS de edições passadas contra
 * candidatos da edição corrente (destaques + buckets secundários).
 *
 * Problema (#2605): o dedup cross-edição (dedup.ts) só indexa entidades dos
 * DESTAQUES passados (Pass-1d/1e). Itens secundários (radar/lancamento/use_melhor)
 * das edições recentes NÃO entram na base de entidades — logo, cobertura do mesmo
 * tema (ex: "Nubank/contratação") que apareceu como secundário numa edição passada
 * passa pelos guardas existentes sem ser sinalizada.
 *
 * Fix: este script é análogo ao `check-highlight-themes.ts` (#2073) mas opera
 * sobre os TÍTULOS DOS ITENS SECUNDÁRIOS das últimas N edições (extraídos do
 * `_internal/01-approved.json` de cada edição), comparando contra os candidatos
 * da edição corrente. Produz AVISOS (sem DROP automático) para consumo no gate
 * do Stage 1.
 *
 * Algoritmo (dois passes por candidato × item-secundário-passado):
 *   1. Jaccard sobre tokens normalizados (threshold >= 0.40).
 *   2. Company-entity overlap via AI_COMPANIES list + tema compartilhado:
 *      quando empresa em comum, abaixar threshold pra 0.25 (cobre
 *      "Nubank não vai parar de contratar" vs "Nubank prioriza mentalidade
 *      de IA nas contratações").
 *
 * IMPORTANTE: Saída = AVISO apenas. Decisão editorial sobre incluir ou não
 * o candidato pertence ao editor (repetição de tema pode ser legítima).
 *
 * Caso real (#2605):
 *   260626: "Nubank não vai parar de contratar por causa da IA" (URL nova)
 *   260625: "Nubank prioriza mentalidade de IA nas contratações" (secundário)
 *   → mesmo tema "Nubank/contratação", URLs diferentes → dedup não detectou.
 *
 * Uso:
 *   npx tsx scripts/check-secondary-themes.ts \
 *     --categorized data/editions/260626/_internal/01-categorized.json \
 *     --editions-dir data/editions \
 *     [--window 3] \
 *     [--out-json data/editions/260626/_internal/01-secondary-theme-check.json]
 *
 * Output JSON:
 *   {
 *     "warnings": [
 *       {
 *         "candidate_url": "https://...",
 *         "candidate_title": "Nubank não vai parar...",
 *         "candidate_bucket": "radar",
 *         "matched_edition": "260625",
 *         "matched_title": "Nubank prioriza mentalidade...",
 *         "matched_bucket": "radar",
 *         "jaccard": 0.33,
 *         "shared_companies": ["nubank"],
 *         "effective_threshold": 0.25
 *       }
 *     ],
 *     "candidates_checked": 12,
 *     "past_items_checked": 7,
 *     "window": 3
 *   }
 *
 * Exit codes:
 *   0 — sempre (warnings são non-fatal — gate decide)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
} from "./dedup.ts";
import { isValidEditionDir } from "./lib/edition-utils.ts";
// #2834: CategorizedJson reexportado do reader canônico (consumido por
// check-intra-themes.ts via `import { CategorizedJson } from "./check-secondary-themes.ts"`).
import type { CategorizedJson } from "./lib/types/categorized-json.ts";
export type { CategorizedJson };

// ---------------------------------------------------------------------------
// Company entity list — high-signal names for cross-edition theme matching.
// Lowercased, word-boundary matched. Focused on PT-BR tech news universe.
// ---------------------------------------------------------------------------

const TECH_COMPANIES = new Set([
  // Big tech
  "google", "microsoft", "apple", "amazon", "meta", "nvidia", "intel",
  "openai", "anthropic", "deepmind", "deepseek", "mistral", "xai",
  "perplexity", "cohere", "stability", "midjourney", "runway",
  // Brazilian companies (high-frequency in Diar.ia)
  "nubank", "itau", "bradesco", "santander", "ifood", "rappi",
  "mercadolivre", "mercadopago", "magazineluiza", "via", "shopee",
  "totvs", "vtex", "loft", "creditas", "neon", "picpay", "pagseguro",
  "stone", "cielo", "rede", "getnet",
  // Global tech (frequent)
  "tesla", "spacex", "uber", "lyft", "airbnb", "stripe", "coinbase",
  "palantir", "databricks", "snowflake", "salesforce", "oracle",
  "samsung", "sony", "qualcomm", "amd", "arm", "tsmc",
  "spotify", "netflix", "disney", "adobe", "figma", "notion",
  "slack", "zoom", "dropbox", "linkedin", "twitter", "x", "tiktok",
  "bytedance", "baidu", "alibaba", "tencent",
]);

/**
 * Extrai empresas do conjunto TECH_COMPANIES que aparecem no texto.
 * Word-boundary check simples (char anterior/posterior não é letra/número).
 */
export function extractCompaniesFromText(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const company of TECH_COMPANIES) {
    const idx = lower.indexOf(company);
    if (idx === -1) continue;
    // Word boundary before
    if (idx > 0 && /[\p{L}\p{N}]/u.test(lower[idx - 1])) continue;
    // Word boundary after
    const afterIdx = idx + company.length;
    if (afterIdx < lower.length && /[\p{L}\p{N}]/u.test(lower[afterIdx])) continue;
    found.add(company);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Past secondary items extractor
// ---------------------------------------------------------------------------

export interface PastSecondaryItem {
  edition: string;       // AAMMDD
  bucket: string;        // "radar" | "lancamento" | "use_melhor" | "video"
  title: string;
  url: string;
}

export const SECONDARY_BUCKETS = ["radar", "lancamento", "use_melhor", "video"] as const;

interface ApprovedEntry {
  url?: string;
  title?: string;
  article?: { url?: string; title?: string };
  [key: string]: unknown;
}

interface ApprovedJson {
  highlights?: ApprovedEntry[];
  runners_up?: ApprovedEntry[];
  radar?: ApprovedEntry[];
  lancamento?: ApprovedEntry[];
  use_melhor?: ApprovedEntry[];
  video?: ApprovedEntry[];
  [key: string]: unknown;
}

/**
 * Lê `data/editions/{yymmdd}/_internal/01-approved.json` e extrai títulos
 * dos itens SECUNDÁRIOS (radar/lancamento/use_melhor/video).
 */
function extractSecondaryItemsFromEdition(
  yymmdd: string,
  editionsDir: string,
): PastSecondaryItem[] {
  const approvedPath = resolve(editionsDir, yymmdd, "_internal", "01-approved.json");
  if (!existsSync(approvedPath)) return [];
  let parsed: ApprovedJson;
  try {
    parsed = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  } catch {
    return [];
  }

  const items: PastSecondaryItem[] = [];
  for (const bucket of SECONDARY_BUCKETS) {
    const entries = parsed[bucket];
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const url = e.url ?? e.article?.url ?? "";
      const title = e.title ?? e.article?.title ?? "";
      if (title && url) {
        items.push({ edition: yymmdd, bucket, title: title.trim(), url });
      }
    }
  }
  return items;
}

/**
 * Descobre as últimas `window` edições (por data desc) no editions directory,
 * excluindo a edição corrente.
 */
function findRecentEditions(
  editionsDir: string,
  currentEdition: string,
  window: number,
): string[] {
  if (!existsSync(editionsDir)) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir);
  } catch {
    return [];
  }

  return dirs
    .filter((d) => isValidEditionDir(d) && d !== currentEdition)
    .sort()
    .reverse()
    .slice(0, window);
}

/**
 * Extrai itens secundários das últimas `window` edições.
 */
export function extractPastSecondaryItems(
  editionsDir: string,
  currentEdition: string,
  window: number,
): PastSecondaryItem[] {
  const recentEditions = findRecentEditions(editionsDir, currentEdition, window);
  const items: PastSecondaryItem[] = [];
  for (const yymmdd of recentEditions) {
    items.push(...extractSecondaryItemsFromEdition(yymmdd, editionsDir));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Candidate extractor from current edition
// ---------------------------------------------------------------------------

export interface CurrentCandidate {
  url: string;
  title: string;
  bucket: string; // "highlight" | "radar" | "lancamento" | "use_melhor" | "video"
}

/**
 * Extrai candidatos da edição corrente: destaques + itens secundários.
 */
export function extractCurrentCandidates(categorizedPath: string): CurrentCandidate[] {
  if (!existsSync(categorizedPath)) return [];
  let data: CategorizedJson;
  try {
    data = JSON.parse(readFileSync(categorizedPath, "utf8")) as CategorizedJson;
  } catch {
    return [];
  }

  const candidates: CurrentCandidate[] = [];

  // Highlights
  for (const h of data.highlights ?? []) {
    const title = h.article?.title ?? h.title ?? "";
    const url = h.article?.url ?? h.url ?? "";
    if (title && url) candidates.push({ url, title: title.trim(), bucket: "highlight" });
  }

  // Secondary buckets
  for (const bucket of SECONDARY_BUCKETS) {
    const entries = data[bucket] as ApprovedEntry[] | undefined;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const title = e.title ?? e.article?.title ?? "";
      const url = e.url ?? e.article?.url ?? "";
      if (title && url) candidates.push({ url, title: title.trim(), bucket });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Warning types
// ---------------------------------------------------------------------------

export interface SecondaryThemeWarning {
  candidate_url: string;
  candidate_title: string;
  candidate_bucket: string;
  matched_edition: string;
  matched_title: string;
  matched_bucket: string;
  matched_url: string;
  jaccard: number;
  shared_companies: string[];
  effective_threshold: number;
  /** Razão real do match:
   *  - 'jaccard': Jaccard >= threshold base (sem redução por empresa/stem)
   *  - 'company': threshold reduzido por empresa compartilhada (jaccard < threshold base)
   *  - 'stem':    prefixo de stem compartilhado com empresa (jaccard < effectiveThreshold)
   */
  match_reason: "jaccard" | "stem" | "company";
}

export interface CheckSecondaryThemesResult {
  warnings: SecondaryThemeWarning[];
  candidates_checked: number;
  past_items_checked: number;
  window: number;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Threshold Jaccard base para comparação com secundários passados.
 * Mais permissivo que cross-article (0.6) pois comparamos título vs título
 * curtos com vocabulário divergente. Mais restritivo que highlight (0.35)
 * pois itens secundários têm menos contexto. */
const SECONDARY_JACCARD_THRESHOLD = 0.40;

/** Threshold reduzido quando há empresa compartilhada.
 * "Nubank não vai parar de contratar" vs "Nubank prioriza mentalidade..."
 * → Jaccard ~0.10 (só "nubank" em comum), então threshold deve ser bem baixo. */
const SECONDARY_JACCARD_WITH_COMPANY = 0.08;

/** Comprimento mínimo de prefixo compartilhado para "stem match".
 * Ex: "contratacoes" e "contratar" compartilham "contrata" (8 chars) → mesmo tema.
 * 7 chars cobre a maioria das raízes PT-BR sem falsos positivos (evita "contra" etc.). */
const STEM_MATCH_MIN_LEN = 7;

// ---------------------------------------------------------------------------
// Core check function
// ---------------------------------------------------------------------------

interface PastItemIndex {
  item: PastSecondaryItem;
  tokens: Set<string>;
  companies: Set<string>;
}

/**
 * Verifica um candidato contra o índice de itens secundários passados.
 * Retorna o melhor match encontrado (maior Jaccard acima do threshold).
 */
function findSecondaryMatch(
  candidate: CurrentCandidate,
  pastIndex: PastItemIndex[],
): SecondaryThemeWarning | null {
  const candTokens = tokenizeForJaccard(candidate.title);
  if (candTokens.size === 0) return null;

  const candCompanies = extractCompaniesFromText(candidate.title);

  let bestMatch: SecondaryThemeWarning | null = null;

  for (const { item, tokens: pastTokens, companies: pastCompanies } of pastIndex) {
    // Compute shared companies
    const sharedCompanies: string[] = [];
    for (const c of candCompanies) {
      if (pastCompanies.has(c)) sharedCompanies.push(c);
    }

    const effectiveThreshold = sharedCompanies.length > 0
      ? SECONDARY_JACCARD_WITH_COMPANY
      : SECONDARY_JACCARD_THRESHOLD;

    const jaccard = jaccardSimilarity(candTokens, pastTokens);

    // Stem match: quando empresa compartilhada, verificar se algum par de tokens
    // (candidato × passado) compartilha prefixo de ≥STEM_MATCH_MIN_LEN chars.
    // Cobre inflexões PT-BR: "contratações" vs "contratar" → "contrata" (8 chars).
    // Só usado quando company está presente (sinal adicional — não match autônomo).
    let hasStemMatch = false;
    if (sharedCompanies.length > 0) {
      outer: for (const tokA of candTokens) {
        if (tokA.length < STEM_MATCH_MIN_LEN) continue;
        for (const tokB of pastTokens) {
          if (tokB.length < STEM_MATCH_MIN_LEN) continue;
          // Compute shared prefix length
          let prefLen = 0;
          const maxLen = Math.min(tokA.length, tokB.length);
          while (prefLen < maxLen && tokA[prefLen] === tokB[prefLen]) prefLen++;
          if (prefLen >= STEM_MATCH_MIN_LEN) {
            hasStemMatch = true;
            break outer;
          }
        }
      }
    }

    if (jaccard >= effectiveThreshold || hasStemMatch) {
      if (bestMatch === null || jaccard > bestMatch.jaccard) {
        // Determine the real reason for the match:
        // - 'stem': stem prefix matched with company present, but jaccard < effectiveThreshold
        // - 'company': company-lowered threshold triggered (jaccard < base threshold but >= company threshold)
        // - 'jaccard': base threshold reached (regardless of company presence)
        const match_reason: "jaccard" | "stem" | "company" =
          hasStemMatch && jaccard < effectiveThreshold
            ? "stem"
            : jaccard >= SECONDARY_JACCARD_THRESHOLD
              ? "jaccard"
              : "company";

        bestMatch = {
          candidate_url: candidate.url,
          candidate_title: candidate.title,
          candidate_bucket: candidate.bucket,
          matched_edition: item.edition,
          matched_title: item.title,
          matched_bucket: item.bucket,
          matched_url: item.url,
          jaccard: Math.round(jaccard * 100) / 100,
          shared_companies: sharedCompanies,
          effective_threshold: effectiveThreshold,
          match_reason,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Verifica todos os candidatos da edição corrente contra itens secundários passados.
 * Não modifica nenhum dado — só produz avisos.
 */
export function checkSecondaryThemes(
  candidates: CurrentCandidate[],
  pastItems: PastSecondaryItem[],
  window: number,
): CheckSecondaryThemesResult {
  if (pastItems.length === 0 || candidates.length === 0) {
    return {
      warnings: [],
      candidates_checked: candidates.length,
      past_items_checked: pastItems.length,
      window,
    };
  }

  // Pré-computar tokens/companies dos itens passados uma única vez
  const pastIndex: PastItemIndex[] = pastItems
    .map((item) => ({
      item,
      tokens: tokenizeForJaccard(item.title),
      companies: extractCompaniesFromText(item.title),
    }))
    .filter((idx) => idx.tokens.size > 0);

  const warnings: SecondaryThemeWarning[] = [];
  const seenCandidates = new Set<string>(); // evitar duplicar mesma URL

  for (const candidate of candidates) {
    if (seenCandidates.has(candidate.url)) continue;
    seenCandidates.add(candidate.url);

    const match = findSecondaryMatch(candidate, pastIndex);
    if (match) warnings.push(match);
  }

  return {
    warnings,
    candidates_checked: candidates.length,
    past_items_checked: pastItems.length,
    window,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)).values;

  const categorizedPath = args["categorized"];
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const window = parseInt(args["window"] ?? "3", 10);
  const outJson = args["out-json"];

  if (!categorizedPath) {
    console.error(
      "Uso: check-secondary-themes.ts --categorized <path> [--editions-dir data/editions] [--window 3] [--out-json <path>]",
    );
    process.exit(1);
  }

  // Derivar edição corrente do path do categorized (ex: .../260626/_internal/...)
  const currentEdition = (() => {
    const parts = categorizedPath.replace(/\\/g, "/").split("/");
    const internalIdx = parts.indexOf("_internal");
    if (internalIdx > 0) return parts[internalIdx - 1];
    // Fallback: tentar nome da pasta de edição no path
    return "";
  })();

  const candidates = extractCurrentCandidates(categorizedPath);
  const pastItems = extractPastSecondaryItems(
    resolve(editionsDir),
    currentEdition,
    window,
  );

  const result = checkSecondaryThemes(candidates, pastItems, window);

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.error(
        `[check-secondary-themes] ⚠️  "${w.candidate_title}" (${w.candidate_bucket}) repete tema de ${w.matched_edition} secundário "${w.matched_title}" (Jaccard=${w.jaccard}, threshold=${w.effective_threshold}, match_reason=${w.match_reason}, empresas=[${w.shared_companies.join(",")}])`,
      );
    }
  } else {
    console.error(
      `[check-secondary-themes] ✓ ${result.candidates_checked} candidato(s) vs ${result.past_items_checked} item(ns) passado(s) — nenhum repeat de tema detectado.`,
    );
  }

  const json = JSON.stringify(result, null, 2);
  if (outJson) {
    writeFileSync(resolve(outJson), json, "utf8");
    console.error(`[check-secondary-themes] Wrote ${outJson}`);
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
