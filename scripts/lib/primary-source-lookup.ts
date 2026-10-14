/**
 * Deterministic primary-source lookup for approved secondary articles (#5664).
 *
 * Search is intentionally supplied by the orchestrator/agent: this module does
 * not scrape a search engine. It builds the `site:` query and makes the
 * replace/preserve decision from the cited company domain and returned metadata.
 *
 * Rule: replace only when a result is (1) HTTP(S), (2) on the suggested official
 * domain or a subdomain, and (3) has subject similarity >= 0.60 with the
 * approved article title. Ties are resolved by score descending, then URL
 * ascending. Otherwise preserve the secondary URL and record the attempt.
 */

import { detectDomainMismatchCandidate, hasLaunchVerb } from "./launch-detect.ts";
import { subjectSimilarity } from "./title-similarity.ts";

export interface PrimarySourceArticle {
  url?: string;
  title?: string;
  summary?: string | null;
  /** Existing Stage 1 enrichment, when available. */
  suggested_primary_domain?: string;
  [key: string]: unknown;
}

export interface PrimarySourceCandidate {
  url?: string;
  title?: string;
  accessible?: boolean;
}

export interface PrimarySourceLookup {
  query: string;
  status: "replaced" | "preserved";
  reason: string;
  from?: string;
  to?: string;
  score?: number;
  /**
   * #10137: which signal accepted the winner — `similarity` (title similarity
   * >= 0.60, the original #5664 rule) or `same-story` (the injected
   * `sameStory` matcher, used for short official page titles like
   * "Claude Haiku 5.5 \ Anthropic" that score below 0.60 against a press
   * headline about the same launch).
   */
  match?: "similarity" | "same-story";
}

/**
 * #10137: optional second acceptance signal. Called only for candidates that
 * already passed the official-domain/accessibility filter — it widens "same
 * topic", never the domain rule. The CLI passes
 * `sameStoryByExactProductVersion` (below). #10141: it must NOT be
 * `isIntraEditionDuplicate` — that matcher is tuned for press-vs-press dedup
 * and its `cross_vehicle`/`entity` branches swapped unrelated official pages.
 */
export type SameStoryFn = (article: PrimarySourceArticle, candidate: { url: string; title: string }) => boolean;

/**
 * #10141: versioned product identifiers in a title — a capitalized product
 * word immediately followed by a version ("GPT-5.5", "Claude Haiku 5.5" →
 * `haiku5.5`, "Llama 3.1", "GPT-4o"), normalized to lowercase with the
 * separator removed so "GPT 5.5" and "GPT-5.5" collide. A bare product name
 * ("Claude", "Llama", "Copilot", "GPT") yields nothing, and four-digit years
 * ("Março 2026") are ignored — neither identifies a specific launch.
 *
 * #10145: a model-tier word right after the version is part of the code
 * ("Gemini 2.5 Flash" → `gemini2.5flash`, "Claude 3.5 Haiku" →
 * `claude3.5haiku`, "GPT-4o mini" → `gpt4omini`, "Flash-Lite" chains), so
 * sibling variants of the same version never collide. Codes come out in
 * title order (Set insertion order) — the first one is the candidate subject.
 */
const VARIANT_WORDS = [
  "flash", "lite", "pro", "ultra", "nano", "mini", "haiku", "sonnet", "opus",
  "turbo", "max", "plus", "air", "instant", "thinking", "omni",
  "codex", "image", "coder", "scout", "maverick", "deep", "think", "vision", "audio", "realtime",
];
const VARIANT_AFTER_VERSION = new RegExp(`^[\\s-]+(${VARIANT_WORDS.join("|")})\\b`, "i");
// #10205: qualquer palavra COLADA por hífen à versão ("GPT-5.5-Codex") é sufixo
// de produto — nunca colapsa pro modelo-base.
const HYPHEN_SUFFIX_AFTER_VERSION = /^-([A-Za-z]\w*)\b/;

export function extractVersionedProductCodes(text: string): Set<string> {
  const codes = new Set<string>();
  const re = /\b([A-Z][A-Za-z]*)[\s-]?(\d+(?:\.\d+)*[a-z]?)(?![\w.]*\d)/g;
  for (const m of text.matchAll(re)) {
    const version = m[2];
    if (/^\d{4}$/.test(version) && Number(version) >= 1900) continue;
    let code = `${m[1].toLowerCase()}${version.toLowerCase()}`;
    let rest = text.slice((m.index ?? 0) + m[0].length);
    for (let v = rest.match(VARIANT_AFTER_VERSION) ?? rest.match(HYPHEN_SUFFIX_AFTER_VERSION); v;
      v = rest.match(VARIANT_AFTER_VERSION) ?? rest.match(HYPHEN_SUFFIX_AFTER_VERSION)) {
      // #10147: "pro" minúsculo é a preposição PT ("para o"), não a variante Pro.
      if (v[1] === "pro" && /^\s+\S/.test(rest.slice(v[0].length))) break;
      code += v[1].toLowerCase();
      rest = rest.slice(v[0].length);
    }
    codes.add(code);
  }
  return codes;
}

/**
 * #10145: where the subject clause of a headline ends — punctuation, a
 * spaced dash, or a preposition/conjunction that opens a secondary phrase
 * ("no Windows 11", "sucessor do GPT-6", "mais barato que o Haiku 4.5",
 * "for Pixel 10"). Whatever versioned code appears only after it is context
 * (platform, predecessor, comparison), never the launched product.
 */
const SUBJECT_CLAUSE_END = new RegExp(
  "[,;:|()\\[\\]\\\\/]|\\s[-–—]\\s|(?:^|\\s)(?:" + [
    "no", "na", "nos", "nas", "em", "para", "pra", "do", "da", "dos", "das", "de",
    "com", "sem", "contra", "que", "como", "ao", "aos", "à", "às", "pelo", "pela",
    "sobre", "após", "até", "por", "mas", "porém", "exige", "exigindo", "but", "while", "requires", "entre", "e", "ou", "sucessor", "substitui",
    "on", "in", "for", "with", "to", "than", "vs\\.?", "versus", "via", "from",
    "of", "by", "at", "after", "over", "against", "and", "or", "replacing",
  ].join("|") + ")(?=\\s|$)",
  "i",
);

/**
 * #10145: the versioned product a headline is ABOUT — the first code in its
 * subject clause (title start up to `SUBJECT_CLAUSE_END`). `undefined` when
 * the subject clause names no versioned product ("Google lança Gemini no
 * Pixel 10" → the only code, `pixel10`, is the platform).
 */
export function subjectVersionedProductCode(title: string): string | undefined {
  // #10147: pontuação (",", ";", ":") antes de qualquer código não encerra o
  // sujeito — "Com preço menor, Anthropic lança Haiku 5.5" abre com adjunto.
  // Preposição/travessão continua encerrando; o resto pós-vírgula ganha um
  // espaço à frente pra "no Pixel 10" parar logo na preposição.
  let rest = title;
  for (;;) {
    const m = SUBJECT_CLAUSE_END.exec(rest);
    const head = m ? rest.slice(0, m.index) : rest;
    const [first] = extractVersionedProductCodes(head);
    if (first) return first;
    if (!m) return undefined;
    if (!/^[,;:]$/.test(m[0])) {
      // #10205: preposição ABRINDO o título ("Após GPT-5.5, OpenAI lança GPT-6")
      // é adjunto até a próxima vírgula; preposição no meio encerra o sujeito.
      if (m.index !== 0 || head !== "") return undefined;
      const comma = /[,;:]/.exec(rest);
      if (!comma) return undefined;
      rest = " " + rest.slice(comma.index + 1);
      continue;
    }
    // #10205: oração com verbo de lançamento já tem sujeito — o que vem depois
    // da pontuação é outra oração, nunca o produto lançado.
    if (hasLaunchVerb(head)) return undefined;
    rest = " " + rest.slice(m.index + m[0].length);
  }
}

/**
 * #10141: the ONLY "same story" signal the active lookup accepts below the
 * 0.60 similarity bar — both titles cite the IDENTICAL versioned product
 * ("Haiku 5.5" ↔ "Haiku 5.5"). Replaces the #10137 wiring to
 * `isIntraEditionDuplicate`, whose `cross_vehicle`/`entity` branches accept
 * "same company + one shared word": every `site:{official domain}` result
 * already carries the company name, so sharing a bare product name ("Claude",
 * "Llama", "Copilot") was enough to swap a lawsuit/fine/layoff headline for an
 * unrelated product page. "GPT-5.5" vs "GPT-5" is a different version and
 * never matches.
 *
 * #10145: only the headline's SUBJECT code counts (`subjectVersionedProductCode`)
 * — sharing the predecessor ("mais barato que o Haiku 4.5") or the platform
 * ("no Windows 11") used to swap D1 for the old model's / platform's page.
 * The candidate must lead with that same code and cite none of the article's
 * other codes; anything ambiguous preserves the secondary URL.
 */
export const sameStoryByExactProductVersion: SameStoryFn = (article, candidate) => {
  const title = article.title ?? "";
  const subject = subjectVersionedProductCode(title);
  if (!subject) return false;
  const [candidateFirst, ...candidateRest] = extractVersionedProductCodes(candidate.title);
  if (candidateFirst !== subject) return false;
  const others = extractVersionedProductCodes(title);
  others.delete(subject);
  return !candidateRest.some((code) => others.has(code));
};

export interface ChoosePrimarySourceOptions {
  sameStory?: SameStoryFn;
}

export interface PrimarySourceLookupInput {
  highlights?: Array<{ article?: PrimarySourceArticle; [key: string]: unknown }>;
  lancamento?: PrimarySourceArticle[];
  radar?: PrimarySourceArticle[];
  use_melhor?: PrimarySourceArticle[];
  video?: PrimarySourceArticle[];
  [key: string]: unknown;
}

function suggestedDomain(article: PrimarySourceArticle): string | undefined {
  const existing = article.suggested_primary_domain?.trim().toLowerCase();
  if (existing) return existing;
  return detectDomainMismatchCandidate(article).suggested_domain;
}

export function buildPrimarySourceQuery(article: PrimarySourceArticle): string | undefined {
  const domain = suggestedDomain(article);
  const title = (article.title ?? "").trim();
  if (!domain || !title) return undefined;
  return `site:${domain} ${title}`;
}

function isOfficialUrl(raw: string, domain: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function choosePrimarySource(
  article: PrimarySourceArticle,
  candidates: readonly PrimarySourceCandidate[],
  options: ChoosePrimarySourceOptions = {},
): { lookup: PrimarySourceLookup; url?: string } {
  const domain = suggestedDomain(article);
  const query = buildPrimarySourceQuery(article) ?? "";
  const original = article.url ?? "";
  if (!domain || !query || !original) {
    return { lookup: { query, status: "preserved", reason: "insufficient-company-or-title-data" } };
  }

  const eligible = candidates
    .filter((candidate): candidate is Required<Pick<PrimarySourceCandidate, "url" | "title">> & PrimarySourceCandidate =>
      typeof candidate.url === "string" && typeof candidate.title === "string" &&
      candidate.accessible !== false && candidate.url !== original &&
      isOfficialUrl(candidate.url, domain),
    )
    .map((candidate) => {
      const score = subjectSimilarity(article.title ?? "", candidate.title);
      const match: PrimarySourceLookup["match"] | undefined = score >= 0.6
        ? "similarity"
        : options.sameStory?.(article, { url: candidate.url, title: candidate.title })
          ? "same-story"
          : undefined;
      return { ...candidate, score, match };
    })
    .filter((candidate) => candidate.match !== undefined)
    // Similarity matches first (the stricter #5664 rule), then score, then URL.
    .sort((a, b) =>
      Number(b.match === "similarity") - Number(a.match === "similarity") ||
      b.score - a.score ||
      a.url.localeCompare(b.url),
    );

  const winner = eligible[0];
  if (!winner) {
    return { lookup: { query, status: "preserved", reason: "no-official-same-topic-result" } };
  }
  return {
    url: winner.url,
    lookup: {
      query,
      status: "replaced",
      reason: "official-same-topic-result",
      from: original,
      to: winner.url,
      score: winner.score,
      match: winner.match,
    },
  };
}

export function applyPrimarySourceLookup(
  input: PrimarySourceLookupInput,
  searchResultsByUrl: Record<string, PrimarySourceCandidate[]>,
): { output: PrimarySourceLookupInput; replaced: number; preserved: number } {
  const decisions = new Map<string, ReturnType<typeof choosePrimarySource>>();
  const collect = (article: PrimarySourceArticle | undefined) => {
    if (!article?.url || decisions.has(article.url)) return;
    const decision = choosePrimarySource(article, searchResultsByUrl[article.url] ?? []);
    if (decision.lookup.query) decisions.set(article.url, decision);
  };
  for (const highlight of input.highlights ?? []) collect(highlight.article);
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const article of input[bucket] ?? []) collect(article);
  }

  const update = (article: PrimarySourceArticle): PrimarySourceArticle => {
    const decision = article.url ? decisions.get(article.url) : undefined;
    if (!decision) return article;
    return {
      ...article,
      ...(decision.url ? { url: decision.url } : {}),
      primary_source_lookup: decision.lookup,
    };
  };
  const highlights = (input.highlights ?? []).map((highlight) =>
    highlight.article ? { ...highlight, article: update(highlight.article) } : highlight,
  );
  const output: PrimarySourceLookupInput = { ...input, highlights };
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    if (input[bucket]) output[bucket] = input[bucket]!.map(update);
  }
  let replaced = 0;
  let preserved = 0;
  for (const decision of decisions.values()) {
    if (decision.lookup.status === "replaced") replaced++;
    else preserved++;
  }
  return { output, replaced, preserved };
}

// ---------------------------------------------------------------------------
// #10137 — active lookup for the edition's top highlights (§1u-sexies)
// ---------------------------------------------------------------------------
//
// §1m-ter (#1699) and §1y (#5664) both depended on the orchestrator
// dispatching `discovery-searcher`; after the Stage 1 runner (#5415) they were
// listed as delegated and nothing ran them — zero `primary_source_substituted`
// from 260819 on. This runs the search deterministically, only for the top-N
// highlights (D1-D3 by `rank`, ~3 queries/edition), before the gate MD is
// rendered, so the gate and the writer already see the official URL.
//
// Conservative by design: any failure preserves the secondary URL; an official
// URL that repeats a past edition or is already in this edition is never used.

export interface ActiveLookupHighlight {
  article?: PrimarySourceArticle;
  rank?: number;
  [key: string]: unknown;
}

/** Shape of `_internal/01-categorized.json` at §1u (highlights + runners_up + buckets). */
export interface ActiveLookupInput extends PrimarySourceLookupInput {
  highlights?: ActiveLookupHighlight[];
  runners_up?: Array<{ article?: PrimarySourceArticle; [key: string]: unknown }>;
}

/** Returns candidates, or `null` when the search itself failed (network, quota, HTTP error). */
export type PrimarySourceSearchFn = (query: string) => Promise<PrimarySourceCandidate[] | null>;

export interface ActiveLookupDeps {
  search: PrimarySourceSearchFn;
  /** Canonicalized URLs already published inside the dedup window. */
  pastUrls: ReadonlySet<string>;
  canonicalize: (url: string) => string;
  sameStory?: SameStoryFn;
  /** How many highlights (by rank) to try. Default 3 (D1-D3). */
  destaqueCount?: number;
  /** Pause between searches (Brave: 1 query/second). Default 1100ms. */
  rateLimitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ActiveLookupAttempt extends PrimarySourceLookup {
  rank?: number;
  title?: string;
}

export interface ActiveLookupResult {
  output: ActiveLookupInput;
  attempts: ActiveLookupAttempt[];
  replaced: number;
}

const BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

function rankedTopHighlights(highlights: ActiveLookupHighlight[], count: number): ActiveLookupHighlight[] {
  return highlights
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => typeof h.article?.url === "string" && h.article.url !== "")
    .sort((a, b) => (a.h.rank ?? a.i + 1) - (b.h.rank ?? b.i + 1) || a.i - b.i)
    .slice(0, count)
    .map(({ h }) => h);
}

function collectEditionUrls(input: ActiveLookupInput, canonicalize: (u: string) => string): Set<string> {
  const urls = new Set<string>();
  const add = (a: PrimarySourceArticle | undefined) => {
    if (typeof a?.url === "string" && a.url) urls.add(canonicalize(a.url));
  };
  for (const h of input.highlights ?? []) add(h.article);
  for (const r of input.runners_up ?? []) add(r.article);
  for (const b of BUCKETS) for (const a of input[b] ?? []) add(a);
  return urls;
}

export async function runActivePrimarySourceLookup(
  input: ActiveLookupInput,
  deps: ActiveLookupDeps,
): Promise<ActiveLookupResult> {
  const destaqueCount = deps.destaqueCount ?? 3;
  const rateLimitMs = deps.rateLimitMs ?? 1100;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const editionUrls = collectEditionUrls(input, deps.canonicalize);

  // original URL → annotation (+ new URL when replaced)
  const decisions = new Map<string, { lookup: PrimarySourceLookup; url?: string }>();
  const attempts: ActiveLookupAttempt[] = [];
  let searched = 0;

  for (const highlight of rankedTopHighlights(input.highlights ?? [], destaqueCount)) {
    const article = highlight.article as PrimarySourceArticle;
    const original = article.url as string;
    // #10141: only look up launches. Without an explicit Stage 1
    // `suggested_primary_domain` (set by enrich-primary-source only for
    // launch verb + known company) or without a launch verb in the title, the
    // story is not about an official release (lawsuit, fine, layoffs…) and
    // any official page is at best tangential — keep the secondary URL.
    if (!article.suggested_primary_domain?.trim() || !hasLaunchVerb(article.title ?? "")) continue;
    const query = buildPrimarySourceQuery(article);
    if (!query || decisions.has(original)) continue; // no known company → nothing to look up

    if (searched > 0 && rateLimitMs > 0) await sleep(rateLimitMs);
    searched++;

    let candidates: PrimarySourceCandidate[] | null;
    try {
      candidates = await deps.search(query);
    } catch {
      candidates = null;
    }

    let decision: { lookup: PrimarySourceLookup; url?: string };
    if (candidates === null) {
      decision = { lookup: { query, status: "preserved", reason: "search-failed" } };
    } else {
      const isFresh = (c: PrimarySourceCandidate) => {
        if (typeof c.url !== "string") return false;
        const canon = deps.canonicalize(c.url);
        return !deps.pastUrls.has(canon) && !editionUrls.has(canon);
      };
      decision = choosePrimarySource(article, candidates.filter(isFresh), { sameStory: deps.sameStory });
      if (decision.lookup.status === "preserved") {
        // Explain WHY when the only matching official result was a dedup hit.
        const blocked = choosePrimarySource(article, candidates, { sameStory: deps.sameStory });
        if (blocked.url) {
          const canon = deps.canonicalize(blocked.url);
          decision = {
            lookup: {
              query,
              status: "preserved",
              reason: deps.pastUrls.has(canon) ? "official-result-repeats-past-edition" : "official-result-already-in-edition",
              to: blocked.url,
            },
          };
        }
      }
    }

    decisions.set(original, decision);
    if (decision.url) editionUrls.add(deps.canonicalize(decision.url));
    attempts.push({ ...decision.lookup, rank: highlight.rank, title: article.title });
  }

  const update = (article: PrimarySourceArticle | undefined): PrimarySourceArticle | undefined => {
    const decision = article?.url ? decisions.get(article.url) : undefined;
    if (!article || !decision) return article;
    return {
      ...article,
      ...(decision.url
        ? { url: decision.url, primary_source_substituted: { from: article.url, to: decision.url } }
        : {}),
      primary_source_lookup: decision.lookup,
    };
  };

  const output: ActiveLookupInput = {
    ...input,
    highlights: (input.highlights ?? []).map((h) => (h.article ? { ...h, article: update(h.article) } : h)),
  };
  if (input.runners_up) output.runners_up = input.runners_up.map((r) => (r.article ? { ...r, article: update(r.article) } : r));
  for (const b of BUCKETS) {
    if (input[b]) output[b] = input[b]!.map((a) => update(a) as PrimarySourceArticle);
  }

  return { output, attempts, replaced: attempts.filter((a) => a.status === "replaced").length };
}
