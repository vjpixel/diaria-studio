#!/usr/bin/env npx tsx
/**
 * dedup-evergreen-buckets.ts (#2548 — Furo 1)
 *
 * Dedup PÓS-CATEGORIZAÇÃO para buckets evergreen (use_melhor / video).
 *
 * Motivação: `dedup.ts` (passo 1l) roda ANTES de `categorize.ts` e usa uma
 * janela de 4 edições — adequada para notícias efêmeras (radar/lancamento),
 * mas curta demais para conteúdo evergreen (tutoriais, cookbooks, guias,
 * vídeos) que é re-descoberto semanas ou meses depois.
 *
 * Caso real (260625): `eugeneyan.com/writing/working-with-ai/` entrou no
 * USE MELHOR mesmo tendo sido publicado em 3 edições anteriores além da
 * janela de 4 — passou por dedup.ts sem ser pego.
 *
 * Algoritmo:
 *   1. Ler `past-editions.md` e extrair URLs de TODAS as edições passadas
 *      (sem limitar por janela — `extractPastUrlsUnbounded`).
 *   2. Para cada artigo em `use_melhor[]` e `video[]` do JSON de entrada:
 *      se a URL canônica estiver na lista de past URLs, remover.
 *   3. Buckets `radar` e `lancamento` NÃO são tocados — janela de 4 do
 *      dedup.ts já é o comportamento correto para notícias efêmeras.
 *
 * Uso:
 *   npx tsx scripts/dedup-evergreen-buckets.ts \
 *     --in data/editions/{AAMMDD}/_internal/01-categorized.json \
 *     --out data/editions/{AAMMDD}/_internal/01-categorized.json \
 *     [--past-editions data/past-editions.md]
 *
 * Input:  JSON com shape { lancamento, radar, use_melhor, video, highlights?, ... }
 *         (output de dedup-intra-edition.ts / categorize.ts, pós-scorer).
 * Output: mesmo JSON com itens duplicados removidos de use_melhor e video.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple } from "./lib/cli-args.ts";
import { canonicalize, readPastEditionsMd, extractPastUrlsUnbounded } from "./dedup.ts";
// #2834: CategorizedJson/Article locais consolidados no reader canônico
// (ver comentário em lib/types/categorized-json.ts sobre por que não é o
// schema Zod estrito de lib/schemas/edition-state.ts).
import type { Article } from "./lib/types/article.ts";
import type { CategorizedJson } from "./lib/types/categorized-json.ts";

export interface EvergreenDedupResult {
  kept: CategorizedJson;
  removed: Array<{
    url: string;
    title?: string;
    bucket: "use_melhor" | "video";
    dedup_note: string;
  }>;
}

// ---------------------------------------------------------------------------
// Evergreen dedup function (pure, testável)
// ---------------------------------------------------------------------------

/**
 * Remove de `use_melhor[]` e `video[]` qualquer artigo cuja URL canônica já
 * apareceu em qualquer edição passada (sem janela de tempo).
 *
 * Buckets `radar` e `lancamento` não são tocados — o dedup de URL com janela
 * curta (dedup.ts passo 1l) já é o comportamento correto para notícias.
 *
 * @param input     JSON categorizado (lido de 01-categorized.json ou similar).
 * @param pastUrls  Set de URLs canônicas de TODAS as edições passadas
 *                  (gerado por `extractPastUrlsUnbounded`).
 */
export function dedupEvergreenBuckets(
  input: CategorizedJson,
  pastUrls: Set<string>,
): EvergreenDedupResult {
  const EVERGREEN_BUCKETS: Array<"use_melhor" | "video"> = ["use_melhor", "video"];
  const removed: EvergreenDedupResult["removed"] = [];
  const keptBuckets: Partial<CategorizedJson> = {};

  for (const bucket of EVERGREEN_BUCKETS) {
    const articles = input[bucket] ?? [];
    const bucketKept: Article[] = [];

    for (const article of articles) {
      const canon = canonicalize(article.url);
      if (pastUrls.has(canon)) {
        removed.push({
          url: article.url,
          title: article.title,
          bucket,
          dedup_note: `url-match em edição passada (dedup evergreen sem janela, #2548)`,
        });
      } else {
        bucketKept.push(article);
      }
    }

    keptBuckets[bucket] = bucketKept;
  }

  const kept: CategorizedJson = {
    ...input,
    ...keptBuckets,
  };

  return { kept, removed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { in: string; out: string; pastEditions: string } {
  const values = parseArgsSimple(argv);
  const inPath = values["in"] ?? "";
  const outPath = values["out"] ?? "";
  const pastEditions = values["past-editions"] ?? "data/past-editions.md";

  if (!inPath || !outPath) {
    throw new Error(
      "Uso: dedup-evergreen-buckets.ts --in <categorized.json> --out <out.json> [--past-editions data/past-editions.md]",
    );
  }

  return { in: inPath, out: outPath, pastEditions };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const input: CategorizedJson = JSON.parse(
    readFileSync(resolve(args.in), "utf8"),
  );

  // Ler past-editions.md — tolerante a ausência (bootstrap sem histórico)
  const pastMd = readPastEditionsMd(args.pastEditions);
  const pastUrls = extractPastUrlsUnbounded(pastMd);

  if (pastUrls.size === 0) {
    process.stderr.write(
      `[dedup-evergreen-buckets] WARN: past-editions.md vazio ou ausente — sem dedup evergreen\n`,
    );
  } else {
    process.stderr.write(
      `[dedup-evergreen-buckets] ${pastUrls.size} URL(s) históricas carregadas de ${args.pastEditions}\n`,
    );
  }

  const useMelhorBefore = input.use_melhor?.length ?? 0;
  const videoBefore = input.video?.length ?? 0;

  const { kept, removed } = dedupEvergreenBuckets(input, pastUrls);

  const useMelhorAfter = kept.use_melhor?.length ?? 0;
  const videoAfter = kept.video?.length ?? 0;

  process.stderr.write(
    `[dedup-evergreen-buckets] use_melhor: ${useMelhorBefore} → ${useMelhorAfter} (-${useMelhorBefore - useMelhorAfter}), ` +
    `video: ${videoBefore} → ${videoAfter} (-${videoBefore - videoAfter}), ` +
    `total removed=${removed.length} (#2548)\n`,
  );

  if (removed.length > 0) {
    process.stderr.write("[dedup-evergreen-buckets] removed:\n");
    for (const r of removed) {
      process.stderr.write(`  [${r.bucket}] ${r.title ?? r.url}\n`);
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
