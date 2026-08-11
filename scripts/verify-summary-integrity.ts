#!/usr/bin/env npx tsx
/**
 * verify-summary-integrity.ts (#4986)
 *
 * Checkpoint de integridade do Stage 1: detecta artigos que tinham `summary`
 * não-vazio no pool bruto (`tmp-articles-raw.json`) e chegaram a um
 * checkpoint downstream (`tmp-categorized.json`, `tmp-finalists.json`, ...)
 * SEM o campo — a mesma classe de regressão do #4955/#4988/#4986 (edição
 * 260811 ao vivo: 9/10 artigos + o próprio D1 perderam `summary` entre a
 * coleta e a seleção de finalistas).
 *
 * A causa raiz original (montagem manual do pool em `tmp-articles-raw.json`)
 * já foi corrigida em `assemble-research-pool.ts` (#4955) — todo passo
 * subsequente (`dedup.ts`, `categorize.ts`, `split-articles-for-scoring.ts`,
 * `merge-scored-chunks.ts`) já preserva campos verbatim via spread. Este
 * script é o BACKSTOP determinístico (mesmo padrão de
 * `no-placeholder-title-highlights`/`url-matches-article-url` em
 * `invariant-checks/stage-1.ts`): se um refactor futuro reintroduzir
 * reconstrução campo-a-campo em qualquer um desses passos, o checkpoint pega
 * a regressão no MESMO stage em que ela acontece, em vez de só no gate
 * `secondary-items-have-summary` do Stage 4 (tarde demais pra diagnosticar
 * qual passo do Stage 1 causou a perda).
 *
 * Aceita 3 shapes pro arquivo `--check` (downstream):
 *   - Array de artigos flat (`Article[]`) — ex: `tmp-kept.json`.
 *   - Bucketed `{ lancamento, radar, use_melhor, video }` — ex:
 *     `tmp-categorized.json`, `tmp-dates-reviewed.json` (`.categorized`).
 *   - `{ finalists: [{ url, article }] }` — `tmp-finalists.json`.
 *
 * Uso:
 *   npx tsx scripts/verify-summary-integrity.ts \
 *     --raw {EDITION_DIR}/_internal/tmp-articles-raw.json \
 *     --check {EDITION_DIR}/_internal/tmp-finalists.json \
 *     --edition {AAMMDD} \
 *     [--label finalists]
 *
 * Exit 0 sem violação. Exit 1 + `logEvent(level: "error")` por violação
 * (padrão do repo — `data/run-log.jsonl`, não um arquivo dedicado) quando
 * algum artigo perdeu `summary` que tinha no pool bruto.
 *
 * Output stdout: JSON `{ raw_count, checked_count, violations_count, violations[] }`.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";

const ROOT = resolve(import.meta.dirname, "..");

const KNOWN_BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

export interface SummaryCheckArticle {
  url?: unknown;
  title?: unknown;
  summary?: unknown;
  [key: string]: unknown;
}

export interface SummaryIntegrityViolation {
  url: string;
  title: string | null;
}

/** `summary` conta como presente só se string não-vazia (trim) — mesma regra do gate Stage 4 `secondary-items-have-summary`. */
export function hasSummary(a: SummaryCheckArticle): boolean {
  return typeof a.summary === "string" && a.summary.trim().length > 0;
}

/**
 * Normaliza qualquer um dos 3 shapes conhecidos de checkpoint do Stage 1 pra
 * uma lista flat de `{ url, title, summary }`. Shape desconhecido → `[]`
 * (tolerante — o caller decide se isso é erro via `checked_count: 0`).
 */
export function extractArticles(data: unknown): SummaryCheckArticle[] {
  if (Array.isArray(data)) return data as SummaryCheckArticle[];
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;

  // Shape `{ finalists: [{ url, article: {...} }] }` — tmp-finalists.json.
  if (Array.isArray(obj.finalists)) {
    return (obj.finalists as Array<{ url?: unknown; article?: SummaryCheckArticle }>).map((f) => ({
      url: f.url ?? f.article?.url,
      title: f.article?.title,
      summary: f.article?.summary,
    }));
  }

  // Shape `{ categorized: { lancamento, radar, use_melhor, video } }` — tmp-dates-reviewed.json.
  const bucketed = (obj.categorized && typeof obj.categorized === "object" ? obj.categorized : obj) as Record<
    string,
    unknown
  >;
  if (KNOWN_BUCKETS.some((b) => Array.isArray(bucketed[b]))) {
    const out: SummaryCheckArticle[] = [];
    for (const b of KNOWN_BUCKETS) {
      for (const a of (bucketed[b] as SummaryCheckArticle[]) ?? []) out.push(a);
    }
    return out;
  }

  return [];
}

/**
 * Compara o pool bruto (raiz da verdade sobre "o summary existia na coleta")
 * contra um checkpoint downstream. Uma URL só vira violação se o RAW tinha
 * `summary` não-vazio E o downstream não tem mais — artigo que NUNCA teve
 * summary (enrich cache-miss, fonte sem descrição) não é regressão deste
 * checkpoint, é um problema diferente (coberto por `secondary-items-have-summary`
 * no Stage 4, que já lida com summary ausente desde a origem).
 */
export function findSummaryLossViolations(
  raw: SummaryCheckArticle[],
  downstream: SummaryCheckArticle[],
): SummaryIntegrityViolation[] {
  const rawHadSummary = new Map<string, boolean>();
  for (const a of raw) {
    if (typeof a.url !== "string") continue;
    rawHadSummary.set(a.url, (rawHadSummary.get(a.url) ?? false) || hasSummary(a));
  }

  const violations: SummaryIntegrityViolation[] = [];
  const seen = new Set<string>();
  for (const a of downstream) {
    if (typeof a.url !== "string") continue;
    if (!rawHadSummary.get(a.url)) continue; // não tinha summary na origem — fora de escopo
    if (hasSummary(a)) continue; // sobreviveu — ok
    if (seen.has(a.url)) continue; // não duplicar violação pra mesma URL
    seen.add(a.url);
    violations.push({
      url: a.url,
      title: typeof a.title === "string" ? a.title : null,
    });
  }
  return violations;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rawPath = args["raw"];
  const checkPath = args["check"];
  const edition = args["edition"] ?? null;
  const label = args["label"] ?? checkPath?.split("/").pop() ?? "check";
  // #3311: override SÓ pra isolamento de teste (mesmo padrão de dedup.ts) —
  // sem isso, testes que spawnam este CLI via subprocess gravariam entries
  // fabricadas direto em data/run-log.jsonl REAL do worktree.
  const logRootDir = args["log-root-dir"];

  if (!rawPath || !checkPath) {
    console.error(
      "Uso: verify-summary-integrity.ts --raw <tmp-articles-raw.json> --check <checkpoint.json> [--edition AAMMDD] [--label nome]",
    );
    process.exit(1);
  }

  const rawAbs = resolve(ROOT, rawPath);
  const checkAbs = resolve(ROOT, checkPath);
  if (!existsSync(rawAbs)) {
    console.error(`Erro: ${rawAbs} não existe.`);
    process.exit(1);
  }
  if (!existsSync(checkAbs)) {
    console.error(`Erro: ${checkAbs} não existe.`);
    process.exit(1);
  }

  const raw = extractArticles(readJson(rawAbs));
  const downstream = extractArticles(readJson(checkAbs));

  const violations = findSummaryLossViolations(raw, downstream);

  for (const v of violations) {
    logEvent(
      {
        edition,
        stage: 1,
        agent: "verify-summary-integrity.ts",
        level: "error",
        message: `summary presente em tmp-articles-raw.json mas ausente em ${label} — ${v.url}`,
        details: { url: v.url, title: v.title, checkpoint: label, checkpoint_file: checkPath },
      },
      logRootDir,
    );
  }

  if (violations.length > 0) {
    process.stderr.write(
      `ERROR [verify-summary-integrity]: ${violations.length} artigo(s) perderam summary entre ` +
        `tmp-articles-raw.json e ${label}: ${violations.map((v) => v.url).join(", ")}\n`,
    );
  }

  console.log(
    JSON.stringify({
      raw_count: raw.length,
      checked_count: downstream.length,
      violations_count: violations.length,
      violations,
    }),
  );

  if (violations.length > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
