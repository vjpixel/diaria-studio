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

import { detectDomainMismatchCandidate } from "./launch-detect.ts";
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
    .map((candidate) => ({ ...candidate, score: subjectSimilarity(article.title ?? "", candidate.title) }))
    .filter((candidate) => candidate.score >= 0.6)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

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
