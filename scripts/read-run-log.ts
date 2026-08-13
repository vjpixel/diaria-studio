#!/usr/bin/env npx tsx
/**
 * read-run-log.ts (#5191)
 *
 * Implementa em código o que `/diaria-log` fazia por interpretação de prosa
 * a cada invocação (o LLM lia `data/run-log.jsonl` inteiro, filtrava,
 * ordenava e formatava sozinho). Mesmo molde do precedente `/diaria-clarice-novos`
 * → `scripts/clarice-novos-run.ts` (#4941).
 *
 * Uso:
 *   npx tsx scripts/read-run-log.ts                          # últimos 50 eventos, error+warn
 *   npx tsx scripts/read-run-log.ts --level all               # últimos 50, todos os níveis
 *   npx tsx scripts/read-run-log.ts --level error              # só error
 *   npx tsx scripts/read-run-log.ts --edition 260418            # filtra por edição
 *   npx tsx scripts/read-run-log.ts --edition 260418 --level error
 *   npx tsx scripts/read-run-log.ts --json                     # output estruturado
 *
 * Somente leitura — `data/run-log.jsonl` é append-only, escrito só por
 * `scripts/log-event.ts` / `scripts/lib/run-log.ts` (`logEvent`).
 *
 * Path do log resolvido via `resolveRunLogPath` (lib/run-log.ts) — respeita
 * `platform.config.json > logging.path`, mesmo helper usado por `logEvent`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath, type LogLevel } from "./lib/run-log.ts";

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface RunLogEntry {
  timestamp: string;
  edition: string | null;
  stage: number | null;
  agent: string | null;
  level: LogLevel;
  message: string;
  details: unknown;
}

const VALID_LEVELS: readonly LogLevel[] = ["error", "warn", "info"];
const DEFAULT_LEVELS: readonly LogLevel[] = ["error", "warn"];
const MAX_EVENTS = 50;
const MAX_STACK_LINES = 5;
const MAX_STACK_CHARS = 500;

// ─── Parsing puro (testável sem I/O) ───────────────────────────────────────

/** Parseia o conteúdo bruto do JSONL, ignorando linhas em branco/malformadas. */
export function parseRunLog(content: string): RunLogEntry[] {
  const entries: RunLogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // linha corrompida — pula, nunca lança
    }
  }
  return entries;
}

/**
 * Filtra por `edition` (match exato, se dado) e `levels` (conjunto de níveis
 * aceitos). `levels` já resolvido pelo caller (default error+warn, `all` =
 * todos os 3, ou 1 nível explícito).
 */
export function filterRunLog(
  entries: RunLogEntry[],
  opts: { edition?: string; levels: readonly LogLevel[] },
): RunLogEntry[] {
  return entries.filter((e) => {
    if (opts.edition && e.edition !== opts.edition) return false;
    return opts.levels.includes(e.level);
  });
}

/** Ordena por timestamp descendente (mais recente primeiro). */
export function sortByTimestampDesc(entries: RunLogEntry[]): RunLogEntry[] {
  return [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

/**
 * Trunca `details.stack` (se presente e string) pra evitar poluir o output —
 * mantém as primeiras `MAX_STACK_LINES` linhas / `MAX_STACK_CHARS` chars,
 * marca com "... (truncated)" quando corta algo. Pura, não muta o input.
 */
export function truncateDetails(details: unknown): unknown {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return details;
  const d = details as Record<string, unknown>;
  if (typeof d.stack !== "string") return details;

  const lines = d.stack.split("\n");
  const lineTruncated = lines.length > MAX_STACK_LINES;
  let stack = lines.slice(0, MAX_STACK_LINES).join("\n");
  const charTruncated = stack.length > MAX_STACK_CHARS;
  if (charTruncated) stack = stack.slice(0, MAX_STACK_CHARS);

  if (!lineTruncated && !charTruncated) return details;
  return { ...d, stack: `${stack}\n... (truncated)` };
}

/**
 * Pipeline completo e puro: parse → filter → sort desc → top N → truncate
 * stack. Exposto separado de `parseRunLog` pra testes de cada etapa.
 */
export function buildRunLogView(
  content: string,
  opts: { edition?: string; levels: readonly LogLevel[]; limit?: number },
): RunLogEntry[] {
  const parsed = parseRunLog(content);
  const filtered = filterRunLog(parsed, opts);
  const sorted = sortByTimestampDesc(filtered);
  const limited = sorted.slice(0, opts.limit ?? MAX_EVENTS);
  return limited.map((e) => ({ ...e, details: truncateDetails(e.details) }));
}

// ─── Formatação ─────────────────────────────────────────────────────────────

function levelTag(level: LogLevel): string {
  return `[${level.toUpperCase().padEnd(5)}]`;
}

function timeOnly(iso: string): string {
  const idx = iso.indexOf("T");
  if (idx === -1) return iso;
  return iso.slice(idx + 1).replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

export function formatRunLog(entries: RunLogEntry[], opts: { edition?: string }): string {
  const errors = entries.filter((e) => e.level === "error").length;
  const warns = entries.filter((e) => e.level === "warn").length;
  const infos = entries.filter((e) => e.level === "info").length;

  const countsBits = [`${errors} error${errors === 1 ? "" : "s"}`, `${warns} warn${warns === 1 ? "" : "s"}`];
  if (infos > 0) countsBits.push(`${infos} info${infos === 1 ? "" : "s"}`);

  const header = opts.edition
    ? `📋 Log — edição ${opts.edition} (${entries.length} evento${entries.length === 1 ? "" : "s"}, ${countsBits.join(", ")})`
    : `📋 Log — últimos ${entries.length} evento${entries.length === 1 ? "" : "s"} (${countsBits.join(", ")})`;

  if (entries.length === 0) {
    return `${header}\n\nNenhum evento encontrado com esses filtros.`;
  }

  const lines: string[] = [header, ""];
  for (const e of entries) {
    const stageTag = e.stage !== null ? `stage ${e.stage}` : "stage -";
    const agentTag = e.agent ?? "-";
    lines.push(`${levelTag(e.level)} ${timeOnly(e.timestamp)} · ${stageTag} · ${agentTag}`);
    lines.push(`  ${e.message}`);
    if (e.details !== null && e.details !== undefined) {
      lines.push(`  details: ${JSON.stringify(e.details)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function resolveLevels(levelArg: string | undefined): readonly LogLevel[] | null {
  if (levelArg === undefined) return DEFAULT_LEVELS;
  if (levelArg === "all") return VALID_LEVELS;
  if ((VALID_LEVELS as readonly string[]).includes(levelArg)) return [levelArg as LogLevel];
  return null;
}

function main(): number {
  const argv = process.argv.slice(2);
  const { values } = parseCliArgs(argv);
  const json = hasFlag(argv, "json");
  const edition = values["edition"];
  const levels = resolveLevels(values["level"]);

  if (levels === null) {
    process.stderr.write(
      `--level deve ser error|warn|info|all (recebido: "${values["level"]}")\n`,
    );
    return 2;
  }

  const logPath = resolveRunLogPath(resolve(process.cwd()));
  if (!existsSync(logPath)) {
    if (json) {
      process.stdout.write(JSON.stringify({ empty: true, path: logPath, events: [] }, null, 2) + "\n");
    } else {
      process.stdout.write(
        "Log vazio — nada foi registrado ainda. Se a pipeline rodou sem logar, os agentes ainda não estão chamando scripts/log-event.ts naquele ponto.\n",
      );
    }
    return 0;
  }

  const content = readFileSync(logPath, "utf8");
  const view = buildRunLogView(content, { edition, levels, limit: MAX_EVENTS });

  if (json) {
    process.stdout.write(JSON.stringify({ edition: edition ?? null, level: values["level"] ?? "default", events: view }, null, 2) + "\n");
  } else {
    process.stdout.write(formatRunLog(view, { edition }) + "\n");
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
