#!/usr/bin/env npx tsx
/**
 * source-health-report.ts (#5191)
 *
 * Implementa em código o que `/diaria-source-health` fazia por interpretação
 * de prosa a cada invocação (o LLM lia `data/source-health.json`/
 * `data/sources/*.jsonl`, calculava `success_rate`/`consecutive_failures` e
 * formatava a tabela sozinho, sem teste travando a regra). Mesmo molde do
 * precedente `/diaria-clarice-novos` → `scripts/clarice-novos-run.ts` (#4941):
 * o script vira a fonte de verdade determinística e testada; a skill encolhe
 * pra "invoca isto, com estas flags".
 *
 * Regra crítica preservada (#1576/#1665, delegada a `computeFailureStreak` em
 * `lib/source-runs.ts`, JÁ testada em `test/source-runs.test.ts`): uma entrada
 * `empty` (fetch OK, zero artigos) NÃO conta como falha dura pro streak — só
 * `fail`/`timeout` contam, e `empty` ENCERRA o streak (mesmo comportamento de
 * `ok`). Este script não recalcula essa regra — apenas consome
 * `computeFailureStreak`, que já é o dado que `data/source-health.json`
 * carrega em `recent_outcomes`.
 *
 * Uso:
 *   npx tsx scripts/source-health-report.ts                    # visão geral
 *   npx tsx scripts/source-health-report.ts --json              # visão geral, JSON
 *   npx tsx scripts/source-health-report.ts --source "AI Breakfast"        # auditoria individual
 *   npx tsx scripts/source-health-report.ts --source "AI Breakfast" --json
 *
 * Somente leitura — nunca escreve em `source-health.json` nem nos logs
 * individuais (esses são escritos só por `record-source-run(s).ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  loadHealth,
  computeFailureStreak,
  classifySourceStatus,
  slugify,
  type HealthFile,
  type SourceEntry,
  type SourceStatus,
} from "./lib/source-runs.ts";

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface SourceHealthRow {
  name: string;
  slug: string;
  attempts: number;
  successes: number;
  failures: number;
  timeouts: number;
  success_rate_pct: number;
  consecutive_failures: number;
  status: SourceStatus;
  last_success_iso: string | null;
  last_failure_iso: string | null;
  last_duration_ms: number | null;
}

export interface SourceLogEntry {
  timestamp: string;
  source: string;
  edition: string | null;
  outcome: string;
  duration_ms: number | null;
  reason: string | null;
  query_used: string | null;
  articles_count: number;
  articles: Array<{ title?: string | null; url?: string | null; published_at?: string | null }>;
}

const STATUS_ICON: Record<SourceStatus, string> = {
  verde: "🟢",
  amarelo: "🟡",
  vermelho: "🔴",
};

// Pior primeiro: vermelho > amarelo > verde.
const STATUS_SEVERITY: Record<SourceStatus, number> = {
  vermelho: 0,
  amarelo: 1,
  verde: 2,
};

// ─── Visão geral ────────────────────────────────────────────────────────────

/** Pura: deriva as linhas de status de cada fonte a partir do HealthFile. */
export function buildSourceHealthRows(health: HealthFile): SourceHealthRow[] {
  return Object.entries(health.sources).map(([name, entry]) => {
    const e = entry as SourceEntry;
    const { consecutive_failures } = computeFailureStreak(e);
    const success_rate_pct = e.attempts > 0 ? (e.successes / e.attempts) * 100 : 0;
    return {
      name,
      slug: slugify(name),
      attempts: e.attempts,
      successes: e.successes,
      failures: e.failures,
      timeouts: e.timeouts,
      success_rate_pct,
      consecutive_failures,
      status: classifySourceStatus(success_rate_pct, consecutive_failures),
      last_success_iso: e.last_success_iso,
      last_failure_iso: e.last_failure_iso,
      last_duration_ms: e.last_duration_ms,
    };
  });
}

/** Pior status primeiro; empate por success_rate ascendente, depois nome. */
export function sortRowsBySeverity(rows: SourceHealthRow[]): SourceHealthRow[] {
  return [...rows].sort((a, b) => {
    const bySeverity = STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status];
    if (bySeverity !== 0) return bySeverity;
    const byRate = a.success_rate_pct - b.success_rate_pct;
    if (byRate !== 0) return byRate;
    return a.name.localeCompare(b.name);
  });
}

function formatRatio(successes: number, attempts: number): string {
  return `${successes}/${attempts}`;
}

export function formatOverviewTable(rows: SourceHealthRow[]): string {
  if (rows.length === 0) {
    return "📊 Source health — nenhuma fonte registrada ainda em data/source-health.json";
  }
  const sorted = sortRowsBySeverity(rows);
  const lines: string[] = [];
  lines.push(`📊 Source health — ${rows.length} fonte${rows.length === 1 ? "" : "s"}`);
  lines.push("");
  for (const r of sorted) {
    const icon = STATUS_ICON[r.status];
    const ratio = formatRatio(r.successes, r.attempts);
    const pct = `${r.success_rate_pct.toFixed(0)}%`;
    const bits: string[] = [pct];
    if (r.consecutive_failures > 0) {
      bits.push(
        `${r.consecutive_failures} falha${r.consecutive_failures === 1 ? "" : "s"} consecutiva${r.consecutive_failures === 1 ? "" : "s"}`,
      );
    }
    if (r.last_failure_iso) bits.push(`última falha: ${r.last_failure_iso}`);
    if (r.last_duration_ms !== null) bits.push(`duração última: ${(r.last_duration_ms / 1000).toFixed(0)}s`);
    lines.push(`${icon} ${r.name.padEnd(30)} ${ratio.padStart(7)}  (${bits.join(", ")})`);
  }
  return lines.join("\n");
}

// ─── Auditoria individual ───────────────────────────────────────────────────

/** Lê `data/sources/{slug}.jsonl` inteiro; ignora linhas malformadas (fail-soft, somente leitura). */
export function readSourceLog(rootDir: string, slug: string): SourceLogEntry[] {
  const logPath = resolve(rootDir, `data/sources/${slug}.jsonl`);
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, "utf8");
  const entries: SourceLogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // linha corrompida — pula, nunca lança (log é append-only, não confiável 100%)
    }
  }
  return entries;
}

/** As últimas `n` entradas do log (mais recentes), em ordem cronológica reversa (mais recente primeiro). */
export function tailSourceLog(entries: SourceLogEntry[], n = 20): SourceLogEntry[] {
  return entries.slice(-n).reverse();
}

export function formatSourceDetail(name: string, tail: SourceLogEntry[]): string {
  if (tail.length === 0) {
    return `🔍 ${name} — nenhuma execução registrada em data/sources/${slugify(name)}.jsonl`;
  }
  const lines: string[] = [];
  lines.push(`🔍 ${name} — últimas ${tail.length} ${tail.length === 1 ? "execução" : "execuções"}`);
  lines.push("");
  for (const e of tail) {
    const editionTag = e.edition ? ` · edição ${e.edition}` : "";
    const durTag = e.duration_ms !== null ? ` em ${(e.duration_ms / 1000).toFixed(0)}s` : "";
    const reasonTag = e.reason ? `  (reason: ${e.reason})` : "";
    lines.push(`[${e.timestamp}${editionTag}] ${e.outcome}${durTag}${reasonTag}`);
    if (e.query_used) lines.push(`  query: ${e.query_used}`);
    lines.push(`  ${e.articles_count} artigo${e.articles_count === 1 ? "" : "s"} retornado${e.articles_count === 1 ? "" : "s"}`);
    for (const a of e.articles) {
      if (a.title) lines.push(`    - "${a.title}"${a.published_at ? ` (${a.published_at})` : ""}`);
      if (a.url) lines.push(`      ${a.url}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): number {
  const argv = process.argv.slice(2);
  const { values } = parseCliArgs(argv);
  const json = hasFlag(argv, "json");
  const source = values["source"];
  const rootDir = resolve(process.cwd());

  if (source) {
    const slug = slugify(source);
    const entries = readSourceLog(rootDir, slug);
    if (entries.length === 0 && !existsSync(resolve(rootDir, `data/sources/${slug}.jsonl`))) {
      if (json) {
        process.stdout.write(JSON.stringify({ source, slug, error: "log_not_found" }, null, 2) + "\n");
      } else {
        process.stderr.write(`Log individual não encontrado: data/sources/${slug}.jsonl\n`);
      }
      return 1;
    }
    const tail = tailSourceLog(entries, 20);
    if (json) {
      process.stdout.write(JSON.stringify({ source, slug, entries: tail }, null, 2) + "\n");
    } else {
      process.stdout.write(formatSourceDetail(source, tail) + "\n");
    }
    return 0;
  }

  const healthPath = resolve(rootDir, "data/source-health.json");
  const health = loadHealth(healthPath);
  const rows = sortRowsBySeverity(buildSourceHealthRows(health));

  if (json) {
    const verde = rows.filter((r) => r.status === "verde").length;
    const amarelo = rows.filter((r) => r.status === "amarelo").length;
    const vermelho = rows.filter((r) => r.status === "vermelho").length;
    process.stdout.write(
      JSON.stringify({ total: rows.length, verde, amarelo, vermelho, sources: rows }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(formatOverviewTable(rows) + "\n");
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
