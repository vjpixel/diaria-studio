#!/usr/bin/env npx tsx
/**
 * demote-stale-date-highlights.ts (#13341, resíduo da #13313)
 *
 * Stage 1 §1u-quinquies-b — roda sobre `_internal/01-categorized.json` logo
 * depois da penalidade de estudo genérico (§1u-quinquies, #9462) e ANTES da
 * busca de fonte primária (§1u-sexies), do dedup intra-edição e do render do
 * MD (§1v). Para cada destaque do top-3 com `date_unverified: true`, lê o
 * texto da página e procura a data de publicação/atualização DECLARADA
 * ("Update on September 29, 2026", "Atualizado em 29/09/2026"); vale a mais
 * recente (#13364). Se até ela tiver mais de 30 dias, o destaque sai do top-3
 * e o próximo sobe (`scripts/lib/stale-date-demotion.ts`). O item segue no
 * pool; o editor promove de volta no gate 1 se houver fato novo.
 *
 * Texto da página: 1º o corpo que o `verify-accessibility` já gravou em
 * `--bodies-dir` (sem rede); sem ele, um GET pelo `fetchSourceText` (o mesmo
 * fetcher do fact-checker, com guard de host privado e timeout de 20s). Sem
 * custo de API. Sem `--bodies-dir` e com `--no-fetch`, nada é lido e nada muda.
 *
 * Fail-soft: qualquer erro (JSON ilegível, rede) vira warn em
 * `data/run-log.jsonl` e exit 0 com o JSON intocado.
 *
 * Uso:
 *   npx tsx scripts/demote-stale-date-highlights.ts \
 *     --categorized data/editions/2611/261117/_internal/01-categorized.json \
 *     --edition 261117 \
 *     [--bodies-dir .../_internal/_forensic/link-verify-bodies] \
 *     [--out-log .../_internal/01-stale-date-demoted.json] [--no-fetch] [--dry-run]
 *
 * Stdout: JSON `{ examined, resolved, demoted, kept, notes[] }`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { runCli } from "./lib/cli-exit.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import { loadCachedBody } from "./lib/url-body-cache.ts";
import { latestDeclaredSourceDate, STALE_SOURCE_DATE_MAX_DAYS, type SourceDateHit } from "./lib/stale-highlight.ts";
import {
  demoteStaleDateHighlights,
  formatStaleDateKeptNote,
  formatStaleDateNote,
  staleDateCandidates,
  urlOf,
  type StaleDateHighlight,
} from "./lib/stale-date-demotion.ts";
import { fetchSourceText, htmlToText } from "./fetch-source-text.ts";

type Rec = Record<string, unknown>;

/** Texto da página: `null` quando não deu para ler (sem cache e sem fetch, ou fetch falhou). */
export type PageTextLoader = (url: string) => Promise<{ text: string | null; via: "cache" | "fetch" | "none"; error?: string }>;

export function makePageTextLoader(opts: {
  bodiesDir?: string | null;
  fetch?: boolean;
  fetchImpl?: typeof fetch;
}): PageTextLoader {
  return async (url) => {
    const body = loadCachedBody(opts.bodiesDir ?? null, url);
    if (body !== null) return { text: htmlToText(body), via: "cache" };
    if (opts.fetch === false) return { text: null, via: "none" };
    const r = await fetchSourceText(url, opts.fetchImpl);
    return r.ok ? { text: r.text, via: "fetch" } : { text: null, via: "fetch", error: r.message };
  };
}

export interface RunResult {
  examined: number;
  /** Candidatos com alguma data declarada achada na página. */
  resolved: number;
  demoted: number;
  kept: number;
  notes: string[];
  error?: string;
}

/**
 * Núcleo testável: lê o categorized, resolve a data declarada dos candidatos,
 * reordena e grava. Nunca lança: erro vira `{ error }` com o JSON intocado.
 */
export async function runStaleDateDemotion(opts: {
  categorizedPath: string;
  edition: string;
  loadText: PageTextLoader;
  outLog?: string;
  dryRun?: boolean;
  rootDir?: string;
}): Promise<RunResult> {
  try {
    const categorized = JSON.parse(readFileSync(opts.categorizedPath, "utf8")) as Rec;
    const highlights = (Array.isArray(categorized.highlights) ? categorized.highlights : []) as StaleDateHighlight[];
    const candidates = staleDateCandidates(highlights);
    const stale = new Map<string, SourceDateHit>();
    const declared = new Map<string, SourceDateHit>();
    const notes: string[] = [];
    const lookups: Array<{ url: string; via: string; declared_iso?: string; days?: number; error?: string }> = [];
    for (const h of candidates) {
      const url = urlOf(h);
      const { text, via, error } = await opts.loadText(url);
      const latest = text ? latestDeclaredSourceDate(text, opts.edition) : undefined;
      lookups.push({ url, via, ...(latest ? { declared_iso: latest.iso, days: latest.days } : {}), ...(error ? { error } : {}) });
      if (!latest) continue;
      declared.set(url, latest);
      if (latest.days > STALE_SOURCE_DATE_MAX_DAYS) stale.set(url, latest);
    }

    const result = demoteStaleDateHighlights(highlights, stale);
    notes.push(...result.demoted.map(formatStaleDateNote), ...result.kept.map(formatStaleDateKeptNote));

    // A data declarada fica registrada no artigo, para o gate e o writer verem
    // de onde veio (o flag `date_unverified` continua: a data estruturada
    // segue ausente).
    const annotated = result.highlights.map((h) => {
      const hit = declared.get(urlOf(h));
      if (!hit || !h.article) return h;
      return { ...h, article: { ...h.article, declared_source_date: { iso: hit.iso, text: hit.text, days: hit.days } } };
    });

    if (!opts.dryRun) {
      if (declared.size > 0) {
        writeFileSync(opts.categorizedPath, JSON.stringify({ ...categorized, highlights: annotated }, null, 2) + "\n", "utf8");
      }
      if (opts.outLog) {
        writeFileSync(
          opts.outLog,
          JSON.stringify({ edition: opts.edition, lookups, demoted: result.demoted, kept: result.kept }, null, 2) + "\n",
          "utf8",
        );
      }
    }
    return {
      examined: candidates.length,
      resolved: declared.size,
      demoted: result.demoted.length,
      kept: result.kept.length,
      notes,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(
      {
        edition: opts.edition,
        stage: 1,
        agent: "demote-stale-date-highlights",
        level: "warn",
        message: `rebaixamento por data velha na fonte (#13341) falhou — seleção segue sem ele: ${msg}`,
      },
      opts.rootDir,
    );
    return { examined: 0, resolved: 0, demoted: 0, kept: 0, notes: [], error: msg };
  }
}

async function main(): Promise<number | void> {
  const rawArgv = process.argv.slice(2);
  const dryRun = rawArgv.includes("--dry-run");
  const noFetch = rawArgv.includes("--no-fetch");
  const args = parseCliArgs(rawArgv.filter((a) => a !== "--dry-run" && a !== "--no-fetch")).values;
  const categorizedPath = args["categorized"];
  const edition = args["edition"];
  if (!categorizedPath || !edition || !/^\d{6}$/.test(edition)) {
    console.error(
      "Uso: demote-stale-date-highlights.ts --categorized <01-categorized.json> --edition AAMMDD " +
        "[--bodies-dir <dir>] [--out-log <path>] [--no-fetch] [--dry-run]",
    );
    return 1;
  }
  const res = await runStaleDateDemotion({
    categorizedPath,
    edition,
    loadText: makePageTextLoader({ bodiesDir: args["bodies-dir"] ?? null, fetch: !noFetch }),
    outLog: args["out-log"],
    dryRun,
  });
  for (const n of res.notes) console.error(`[demote-stale-date] ${n}`);
  if (res.error) console.error(`[demote-stale-date] ⚠️ fail-soft: ${res.error}`);
  else if (res.notes.length === 0) console.error(`[demote-stale-date] ✓ ${res.examined} destaque(s) sem data verificada examinado(s); nenhum com data velha.`);
  process.stdout.write(JSON.stringify(res) + "\n");
}

if (isMainModule(import.meta.url)) {
  // #9911: grava exitCode (o script faz fetch).
  runCli(main);
}
