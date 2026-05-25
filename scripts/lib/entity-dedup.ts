/**
 * entity-dedup.ts
 *
 * Extract named entities (companies, products, specific numbers) from
 * title + summary. Cross-reference with entities from highlights of
 * recent editions to detect duplicate coverage.
 *
 * Addresses #1492: dedup doesn't detect same theme across different URLs
 * when secondary coverage uses sufficiently different titles (e.g.,
 * Canaltech "IA concorrente do Gemini derruba preco" vs InfoMoney
 * "DeepSeek corta 75% do preco da API").
 *
 * Deterministic (no LLM). Integrated as Pass-2 in dedup.ts (after URL
 * exact match Pass-0/1 and title Jaccard Pass-1c).
 */

// ---------------------------------------------------------------------------
// Known AI companies & products — canonical lowercased forms
// ---------------------------------------------------------------------------

const AI_COMPANIES = new Set([
  "openai", "anthropic", "google", "deepmind", "meta", "microsoft",
  "mistral", "deepseek", "cohere", "apple", "nvidia", "amazon",
  "hugging face", "huggingface", "xai", "stability ai", "stabilityai",
  "perplexity", "inflection", "character ai", "runway", "midjourney",
  "adobe", "salesforce", "baidu", "alibaba", "tencent", "bytedance",
  "samsung", "intel", "amd", "qualcomm", "tsmc", "arm",
  "databricks", "snowflake", "palantir", "scale ai", "scaleai",
  "together ai", "togetherai", "groq", "cerebras", "dell",
  "ibm", "oracle", "tesla", "spacex", "uber", "spotify",
]);

// Model name patterns: GPT-*, Claude-*, Gemini-*, Llama-*, DeepSeek-V*, etc.
const MODEL_PATTERNS = [
  /\bgpt[-\s]?[o]?\d[\w.]*\b/i,
  /\bclaude[-\s]?\d[\w.]*\b/i,
  /\bclaude[-\s]?(opus|sonnet|haiku)[\s\d.]*/i,
  /\bgemini[-\s]?\d[\w.]*\b/i,
  /\bgemini[-\s]?(omni|ultra|pro|nano|flash|spark)\b/i,
  /\bllama[-\s]?\d[\w.]*\b/i,
  /\bdeepseek[-\s]?v?\d[\w.]*\b/i,
  /\bdeepseek[-\s]?(coder|chat|math|r1)\b/i,
  /\bmistral[-\s]?\d[\w.]*\b/i,
  /\bmistral[-\s]?(large|medium|small|nemo|pixtral)\b/i,
  /\bcodex\b/i,
  /\bdall[-\s]?e[-\s]?\d?\b/i,
  /\bsora\b/i,
  /\bmythos\b/i,
  /\bcopilot\b/i,
  /\bgrok[-\s]?\d?\b/i,
  /\bo[1-4][-\s]?(mini|pro|preview)?\b/i,
  /\bphi[-\s]?\d[\w.]*\b/i,
  /\bcommand[-\s]?r[\+]?\b/i,
];

// ---------------------------------------------------------------------------
// Entity extraction functions (deterministic, no LLM)
// ---------------------------------------------------------------------------

/** Extract percentages like "75%", "75 por cento" */
function extractPercentages(text: string): string[] {
  const results: string[] = [];

  // Match digit%
  const pctRe = /(\d+(?:[.,]\d+)?)\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = pctRe.exec(text)) !== null) {
    results.push(`${m[1]}%`);
  }

  // Match "N por cento"
  const porCentoRe = /(\d+(?:[.,]\d+)?)\s*por\s+cento/gi;
  while ((m = porCentoRe.exec(text)) !== null) {
    results.push(`${m[1]}%`);
  }

  return results;
}

/** Extract monetary values like "$10B", "R$2,5 bilhoes", "$300 million" */
function extractMonetaryValues(text: string): string[] {
  const results: string[] = [];

  // USD: $10B, $300M, $2.5K, $10,000
  const usdRe = /\$\s?[\d,.]+\s*[BMKbmk]?\b/g;
  let m: RegExpExecArray | null;
  while ((m = usdRe.exec(text)) !== null) {
    results.push(m[0].replace(/\s/g, "").toLowerCase());
  }

  // BRL: R$2,5 bilhoes
  const brlRe = /R\$\s?[\d,.]+/g;
  while ((m = brlRe.exec(text)) !== null) {
    results.push(m[0].replace(/\s/g, "").toLowerCase());
  }

  // Portuguese large numbers: "2 bilhoes", "500 milhoes"
  const ptNumRe = /(\d+(?:[.,]\d+)?)\s*(bilh|milh|trilh)\S*/gi;
  while ((m = ptNumRe.exec(text)) !== null) {
    const prefix = m[2].toLowerCase().startsWith("bilh")
      ? "B"
      : m[2].toLowerCase().startsWith("milh")
        ? "M"
        : "T";
    results.push(`${m[1]}${prefix}`);
  }

  // English large numbers: "300 million", "2 billion"
  const enNumRe = /(\d+(?:[.,]\d+)?)\s*(billion|million|trillion)/gi;
  while ((m = enNumRe.exec(text)) !== null) {
    const prefix = m[2].toLowerCase().startsWith("bill")
      ? "B"
      : m[2].toLowerCase().startsWith("mill")
        ? "M"
        : "T";
    results.push(`${m[1]}${prefix}`);
  }

  return results;
}

/** Extract company names from known list */
function extractCompanies(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const company of AI_COMPANIES) {
    // Word boundary check: company name must be standalone
    // Use indexOf + boundary checks for multi-word names
    const idx = lower.indexOf(company);
    if (idx === -1) continue;

    // Check word boundary before
    if (idx > 0) {
      const before = lower[idx - 1];
      if (/[\p{L}\p{N}]/u.test(before)) continue;
    }
    // Check word boundary after
    const afterIdx = idx + company.length;
    if (afterIdx < lower.length) {
      const after = lower[afterIdx];
      if (/[\p{L}\p{N}]/u.test(after)) continue;
    }

    found.push(company);
  }
  return found;
}

/** Extract AI model names using regex patterns */
function extractModelNames(text: string): string[] {
  const found: string[] = [];
  for (const pattern of MODEL_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      found.push(m[0].toLowerCase().replace(/\s+/g, "-"));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EntitySet {
  companies: string[];
  models: string[];
  percentages: string[];
  monetaryValues: string[];
}

/**
 * Extract all entities from a combined title + summary string.
 * Returns structured entity sets for each category.
 */
export function extractEntities(text: string): EntitySet {
  return {
    companies: extractCompanies(text),
    models: extractModelNames(text),
    percentages: extractPercentages(text),
    monetaryValues: extractMonetaryValues(text),
  };
}

/** Flatten entity set into a single array of lowercase strings for comparison */
function flattenEntities(es: EntitySet): string[] {
  return [
    ...es.companies,
    ...es.models,
    ...es.percentages,
    ...es.monetaryValues,
  ];
}

/** Check if two entity sets share at least one named entity (company or model) */
function hasNamedEntityOverlap(a: EntitySet, b: EntitySet): boolean {
  const aNames = new Set([...a.companies, ...a.models]);
  for (const name of [...b.companies, ...b.models]) {
    if (aNames.has(name)) return true;
  }
  return false;
}

/** Check if two entity sets share at least one numeric entity (percentage or monetary) */
function hasNumericOverlap(a: EntitySet, b: EntitySet): boolean {
  const aNums = new Set([...a.percentages, ...a.monetaryValues]);
  for (const num of [...b.percentages, ...b.monetaryValues]) {
    if (aNums.has(num)) return true;
  }
  return false;
}

/** Compute shared entities between two sets */
function computeSharedEntities(a: EntitySet, b: EntitySet): string[] {
  const shared: string[] = [];
  const aAll = new Set(flattenEntities(a));
  for (const entity of flattenEntities(b)) {
    if (aAll.has(entity)) {
      shared.push(entity);
    }
  }
  // Deduplicate
  return [...new Set(shared)];
}

export interface EntityDuplicateMatch {
  url: string;
  matchedHighlight: string;
  sharedEntities: string[];
}

interface ArticleLike {
  url: string;
  title?: string;
  summary?: string;
  [key: string]: unknown;
}

interface PastHighlight {
  title: string;
  url: string;
  themes?: string[];
}

/**
 * Detect entity-based duplicates between candidate articles and past
 * edition highlights.
 *
 * An article is flagged as duplicate when it shares:
 *   - At least 1 named entity (company OR model name)
 *   AND
 *   - At least 1 numeric entity (percentage OR monetary value)
 * with a past highlight.
 *
 * This threshold (2+ entities with at least one named + one numeric)
 * ensures we only flag when there's strong evidence of the same event
 * being covered, not just the same company in a different context.
 */
export function detectEntityDuplicates(
  articles: ArticleLike[],
  pastHighlights: PastHighlight[],
): EntityDuplicateMatch[] {
  if (pastHighlights.length === 0) return [];

  // Pre-compute entities for past highlights
  const pastEntities = pastHighlights.map((h) => ({
    highlight: h,
    entities: extractEntities(
      `${h.title} ${(h.themes ?? []).join(" ")}`,
    ),
  }));

  const matches: EntityDuplicateMatch[] = [];

  for (const article of articles) {
    const articleText = `${article.title ?? ""} ${article.summary ?? ""}`;
    const articleEntities = extractEntities(articleText);

    // Skip articles with no extractable entities
    if (flattenEntities(articleEntities).length === 0) continue;

    for (const { highlight, entities: highlightEntities } of pastEntities) {
      // Threshold: named entity (company/model) AND numeric (pct/money)
      if (
        hasNamedEntityOverlap(articleEntities, highlightEntities) &&
        hasNumericOverlap(articleEntities, highlightEntities)
      ) {
        const shared = computeSharedEntities(articleEntities, highlightEntities);
        if (shared.length >= 2) {
          matches.push({
            url: article.url,
            matchedHighlight: highlight.title,
            sharedEntities: shared,
          });
          break; // One match per article is enough
        }
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Helpers for extracting past highlights from past-editions.md
// ---------------------------------------------------------------------------

/**
 * Extract highlight info (title + URL) from past-editions.md.
 * Each edition section has a headline like:
 *   ## 2026-05-22 -- "SoberanIA: IA publica nacional"
 * and a list of URLs.
 *
 * We treat the edition headline as the "highlight title" since that's
 * the most prominent theme of the edition and what we want to dedup
 * against. For a richer signal, we also include each URL's domain as
 * a loose entity.
 */
export function extractPastHighlights(
  md: string,
  window: number,
): PastHighlight[] {
  const highlights: PastHighlight[] = [];

  const sectionRe = /^## \d{4}-\d{2}-\d{2}/m;
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => sectionRe.test(s)).slice(0, window);

  for (const section of editionSections) {
    // Extract edition title
    const titleMatch = section.match(/^## \d{4}-\d{2}-\d{2}[^"]*"([^"]+)"/m);
    if (!titleMatch) continue;

    const title = titleMatch[1];

    // Extract edition URL
    const urlMatch = section.match(/^URL:\s+(https?:\/\/\S+)/m);
    const url = urlMatch ? urlMatch[1] : "";

    highlights.push({ title, url });
  }

  return highlights;
}
