#!/usr/bin/env npx tsx
/**
 * dedup-intra-edition.ts (#2367)
 *
 * Dedup INTRA-EDIÇÃO: remove itens de buckets secundários (radar, lancamento,
 * use_melhor, video) que cobrem o mesmo evento que um destaque aprovado.
 *
 * `dedup.ts` detecta duplicatas contra edições PASSADAS. Este script detecta
 * duplicatas DENTRO da mesma edição — caso real 260618: D1 "SpaceX compra o
 * Cursor por US$ 60 bilhões" (braziljournal) + RADAR "SpaceX compra Cursor..."
 * (exame) — mesmo evento, URLs diferentes → passou todas as guards existentes.
 *
 * Algoritmo:
 *   1. Para cada destaque em `highlights[]`, extrair título canônico.
 *   2. Para cada item em radar/lancamento/use_melhor/video:
 *      a. Jaccard similarity sobre tokens normalizados (threshold 0.45 — mais
 *         permissivo que dedup.ts pois é intra-edição onde divergência de
 *         vocabulário entre fontes é maior).
 *      b. Entity overlap: ≥2 entidades nomeadas compartilhadas (empresa +
 *         produto / empresa + número / produto + número).
 *   3. Se match encontrado: remover do bucket secundário (destaque preservado).
 *
 * Uso:
 *   npx tsx scripts/dedup-intra-edition.ts \
 *     --in data/editions/{AAMMDD}/_internal/01-categorized.json \
 *     --out data/editions/{AAMMDD}/_internal/01-categorized.json
 *
 * Input:  JSON com `{ highlights, runners_up?, lancamento, radar, use_melhor, video, ... }`
 *         (output do passo 1u do orchestrator).
 * Output: mesmo JSON com items duplicados removidos dos buckets secundários.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
  extractNamedEntities,
  normalizeTitle,
} from "./dedup.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Article {
  url: string;
  title?: string;
  [key: string]: unknown;
}

interface HighlightEntry {
  url?: string;
  title?: string;
  article?: Article;
  [key: string]: unknown;
}

interface CategorizedWithHighlights {
  highlights?: HighlightEntry[];
  runners_up?: HighlightEntry[];
  lancamento?: Article[];
  radar?: Article[];
  use_melhor?: Article[];
  video?: Article[];
  [key: string]: unknown;
}

export interface IntraEditionDedupResult {
  kept: CategorizedWithHighlights;
  removed: Array<{
    url: string;
    title?: string;
    bucket: string;
    match_type: "jaccard" | "entity";
    matched_highlight: string;
    score: number;
  }>;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Threshold Jaccard para dedup intra-edição. Mais permissivo que cross-edition
 * (0.6) porque fontes diferentes cobrem o mesmo evento com vocabulários
 * divergentes (PT vs EN, título longo vs short).
 */
export const INTRA_JACCARD_THRESHOLD = 0.45;

/**
 * Número mínimo de entidades compartilhadas para considerar entity-match.
 * 2 entidades = 1 empresa/produto + 1 numérico/outro, ou 2 entidades nomeadas.
 * Evita falso-positivo de 1 entidade genérica (ex: só "SpaceX" matcharia
 * qualquer notícia de SpaceX do dia, não só o mesmo evento).
 */
export const INTRA_ENTITY_MIN_SHARED = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extrai título canônico de um HighlightEntry (suporta shapes legados). */
export function highlightTitle(h: HighlightEntry): string | null {
  const t = h.title ?? h.article?.title;
  if (t && typeof t === "string") return t;
  return null;
}

/** Extrai URL de um HighlightEntry. */
export function highlightUrl(h: HighlightEntry): string | null {
  const u = h.url ?? h.article?.url;
  if (u && typeof u === "string") return u;
  return null;
}

/**
 * Checa se um artigo é duplicata intra-edição de qualquer destaque.
 *
 * @returns match info se duplicata, null caso contrário.
 */
export function isIntraEditionDuplicate(
  article: Article,
  highlights: HighlightEntry[],
  options: {
    jaccardThreshold?: number;
    entityMinShared?: number;
  } = {},
): {
  match_type: "jaccard" | "entity";
  matched_highlight: string;
  score: number;
} | null {
  const jThreshold = options.jaccardThreshold ?? INTRA_JACCARD_THRESHOLD;
  const entityMin = options.entityMinShared ?? INTRA_ENTITY_MIN_SHARED;

  const artTitle = article.title;
  if (!artTitle) return null;

  const artTokens = tokenizeForJaccard(artTitle);
  const artEntities = extractNamedEntities(artTitle);

  for (const h of highlights) {
    const hTitle = highlightTitle(h);
    if (!hTitle) continue;

    // Skip exact-same URL (destaque pode aparecer no bucket também — não é intra-dup)
    const hUrl = highlightUrl(h);
    if (hUrl && article.url === hUrl) continue;

    // (a) Jaccard sobre tokens normalizados
    const hTokens = tokenizeForJaccard(hTitle);
    const jaccard = jaccardSimilarity(artTokens, hTokens);
    if (jaccard >= jThreshold) {
      return {
        match_type: "jaccard",
        matched_highlight: hTitle,
        score: jaccard,
      };
    }

    // (b) Entity overlap: contar entidades compartilhadas
    const hEntities = extractNamedEntities(hTitle);
    let sharedCount = 0;
    const sharedNames: string[] = [];
    for (const e of artEntities) {
      if (hEntities.has(e)) {
        sharedCount++;
        sharedNames.push(e);
      }
    }
    if (sharedCount >= entityMin) {
      return {
        match_type: "entity",
        matched_highlight: hTitle,
        score: sharedCount / Math.max(artEntities.size, hEntities.size, 1),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main dedup function
// ---------------------------------------------------------------------------

const SECONDARY_BUCKETS = ["radar", "lancamento", "use_melhor", "video"] as const;

/**
 * Aplica dedup intra-edição ao JSON de categorized.
 * Remove dos buckets secundários itens que duplicam um destaque.
 *
 * Pure function — não muta input.
 */
export function dedupIntraEdition(
  input: CategorizedWithHighlights,
  options: {
    jaccardThreshold?: number;
    entityMinShared?: number;
  } = {},
): IntraEditionDedupResult {
  const highlights = input.highlights ?? [];
  const removed: IntraEditionDedupResult["removed"] = [];

  const keptBuckets: Record<string, Article[]> = {};

  for (const bucket of SECONDARY_BUCKETS) {
    const articles = input[bucket] ?? [];
    const bucketKept: Article[] = [];

    for (const article of articles) {
      const match = isIntraEditionDuplicate(article, highlights, options);
      if (match) {
        removed.push({
          url: article.url,
          title: article.title,
          bucket,
          ...match,
        });
      } else {
        bucketKept.push(article);
      }
    }

    keptBuckets[bucket] = bucketKept;
  }

  const kept: CategorizedWithHighlights = {
    ...input,
    ...keptBuckets,
  };

  return { kept, removed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { in: string; out: string } {
  let inPath = "";
  let outPath = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") inPath = argv[++i];
    else if (argv[i] === "--out") outPath = argv[++i];
  }
  if (!inPath || !outPath) {
    throw new Error("Uso: dedup-intra-edition.ts --in <categorized.json> --out <out.json>");
  }
  return { in: inPath, out: outPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const input: CategorizedWithHighlights = JSON.parse(
    readFileSync(resolve(args.in), "utf8"),
  );

  const highlightCount = input.highlights?.length ?? 0;
  const { kept, removed } = dedupIntraEdition(input);

  const totalSecondary = SECONDARY_BUCKETS.reduce(
    (sum, b) => sum + (input[b]?.length ?? 0),
    0,
  );
  const totalKept = SECONDARY_BUCKETS.reduce(
    (sum, b) => sum + (kept[b]?.length ?? 0),
    0,
  );

  process.stderr.write(
    `[dedup-intra-edition] highlights=${highlightCount}, secondary_input=${totalSecondary}, ` +
    `removed=${removed.length}, secondary_output=${totalKept}\n`,
  );

  if (removed.length > 0) {
    process.stderr.write("[dedup-intra-edition] removed:\n");
    for (const r of removed) {
      process.stderr.write(
        `  [${r.bucket}] ${r.title ?? r.url} — ${r.match_type} (${(r.score * 100).toFixed(0)}%) → "${r.matched_highlight}"\n`,
      );
    }
  }

  writeFileSync(resolve(args.out), JSON.stringify(kept, null, 2), "utf8");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
