/**
 * collect-edition-signals.ts
 *
 * Coleta sinais de falha/anomalia durante uma edição e grava em
 * `{edition_dir}/_internal/issues-draft.json`. Usado pelo `auto-reporter`
 * (issue #57) no final do pipeline para propor issues ao editor.
 *
 * Top 4 sinais capturados (ordem de prioridade editorial):
 *   1. Source com streak ≥ 3 falhas consecutivas (da `data/source-health.json`).
 *   2. Unfixed issues no publish-newsletter (do `{edition_dir}/05-published.json`).
 *   3. Chrome disconnections no log da edição (do `data/run-log.jsonl`).
 *   4. Claude in Chrome MCP indisponível desde o início (do `data/run-log.jsonl`).
 *
 * Uso:
 *   npx tsx scripts/collect-edition-signals.ts --edition-dir data/editions/260424/
 *
 * Output: `{edition_dir}/_internal/issues-draft.json` com array `signals[]`.
 * Se nenhum sinal detectado, arquivo é criado com `signals: []` e exit 0.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReadPath } from "./lib/edition-paths.ts";

export type Severity = "low" | "medium" | "high";

export interface Signal {
  kind: "source_streak" | "unfixed_issue" | "chrome_disconnects" | "mcp_unavailable";
  severity: Severity;
  title: string;
  details: Record<string, unknown>;
  suggested_action: string;
  related_issue?: string;
}

export interface IssuesDraft {
  edition: string | null;
  collected_at: string;
  signals: Signal[];
}

// ===========================================================================
// Signal 1: source streak
// ===========================================================================

interface SourceHealthEntry {
  attempts?: number;
  recent_outcomes?: Array<{ outcome: string; timestamp?: string }>;
}

interface SourceHealthFile {
  sources?: Record<string, SourceHealthEntry>;
}

export function signalsFromSourceHealth(
  health: SourceHealthFile,
  minStreak = 3,
): Signal[] {
  const out: Signal[] = [];
  for (const [source, entry] of Object.entries(health.sources ?? {})) {
    const recent = entry.recent_outcomes ?? [];
    if (recent.length === 0) continue;
    // Streak de não-ok do mais recente pra trás.
    const reversed = recent.slice().reverse();
    let streak = 0;
    for (const r of reversed) {
      if (r.outcome === "ok") break;
      streak++;
    }
    if (streak >= minStreak) {
      out.push({
        kind: "source_streak",
        severity: streak >= 5 ? "high" : "medium",
        title: `Source ${source} com ${streak} falhas consecutivas`,
        details: {
          source,
          consecutive_failures: streak,
          last_outcomes: recent.slice(-Math.min(5, recent.length)),
        },
        suggested_action: `Considere desativar ${source} temporariamente em seed/sources.csv até investigar.`,
      });
    }
  }
  return out;
}

// ===========================================================================
// Signal 2: publish-newsletter unfixed_issues
// ===========================================================================

interface PublishedJson {
  draft_url?: string;
  unfixed_issues?: Array<{
    reason?: string;
    section?: string;
    details?: string;
  }>;
}

export function signalsFromPublished(
  published: PublishedJson | null,
): Signal[] {
  if (!published || !published.unfixed_issues || published.unfixed_issues.length === 0) return [];
  const out: Signal[] = [];
  for (const issue of published.unfixed_issues) {
    const reason = issue.reason ?? "unknown";
    const severity: Severity = reason.startsWith("unicode_corruption")
      ? "high"
      : reason.startsWith("template_cleanup")
      ? "high"
      : "medium";
    out.push({
      kind: "unfixed_issue",
      severity,
      title: `publish-newsletter: ${reason}${issue.section ? ` (${issue.section})` : ""}`,
      details: {
        reason,
        section: issue.section ?? null,
        details: issue.details ?? null,
        draft_url: published.draft_url ?? null,
      },
      suggested_action:
        "Editor deve corrigir manualmente no Beehiiv antes de publicar. Reincidência pode justificar migrar para Custom HTML (#74).",
      related_issue: "#39",
    });
  }
  return out;
}

// ===========================================================================
// Signal 3: Chrome disconnections
// ===========================================================================

interface LogEntry {
  timestamp?: string;
  edition?: string | null;
  level?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export function signalsFromRunLog(
  lines: string[],
  edition: string | null,
  threshold = 3,
): Signal[] {
  let count = 0;
  const firstAt: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: LogEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (edition && parsed.edition && parsed.edition !== edition) continue;
    if (parsed.level !== "error" && parsed.level !== "warn") continue;
    const msg = (parsed.message ?? "").toLowerCase();
    if (
      msg.includes("chrome_disconnected") ||
      msg.includes("not connected") ||
      msg.includes("extension disconnected") ||
      msg.includes("chrome desconectado")
    ) {
      count++;
      if (parsed.timestamp && firstAt.length < 5) firstAt.push(parsed.timestamp);
    }
  }

  if (count < threshold) return [];

  return [
    {
      kind: "chrome_disconnects",
      severity: count >= 5 ? "high" : "medium",
      title: `Chrome desconectou ${count}× durante a edição`,
      details: {
        count,
        first_occurrences: firstAt,
      },
      suggested_action:
        count >= 5
          ? "Re-instalar a extensão Claude in Chrome ou considerar fluxo alternativo (puppeteer/API direta)."
          : "Monitorar — se reincidir em próximas edições, abrir issue dedicada.",
    },
  ];
}

// ===========================================================================
// Signal 4: Claude in Chrome MCP unavailable (never connected this session)
// ===========================================================================

export function signalsFromMcpUnavailable(
  lines: string[],
  edition: string | null,
): Signal[] {
  let count = 0;
  const firstAt: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: LogEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (edition && parsed.edition && parsed.edition !== edition) continue;
    if (parsed.level !== "error" && parsed.level !== "warn") continue;
    const msg = (parsed.message ?? "").toLowerCase();
    if (
      msg.includes("claude-in-chrome mcp unavailable") ||
      msg.includes("claude_in_chrome_mcp_unavailable") ||
      // Catch-all genérico, restrito a contexto claude/chrome pra evitar
      // false-positive em outros MCPs (Beehiiv, Clarice, etc) que possam
      // logar a mesma string sem o prefixo específico.
      (msg.includes("mcp unavailable") &&
        (msg.includes("claude") || msg.includes("chrome")))
    ) {
      count++;
      if (
        typeof parsed.timestamp === "string" &&
        firstAt.length < 5
      ) {
        firstAt.push(parsed.timestamp);
      }
    }
  }

  if (count === 0) return [];

  return [
    {
      kind: "mcp_unavailable",
      severity: "medium",
      title: `Claude in Chrome MCP indisponível na edição (${count} ocorrência${count > 1 ? "s" : ""})`,
      details: {
        count,
        first_occurrences: firstAt,
      },
      suggested_action:
        "Verificar se a extensão Claude in Chrome está instalada, ativa e logada antes da próxima edição. Stage 5 (Beehiiv) e LinkedIn do Stage 6 dependem desse MCP — pré-flight automático sendo discutido em #143.",
      related_issue: "#143",
    },
  ];
}

// ===========================================================================
// Main
// ===========================================================================

export interface CollectOptions {
  rootDir: string;
  editionDir: string;
  edition?: string | null;
  now?: Date;
  minStreak?: number;
  chromeThreshold?: number;
}

export function collectSignals(opts: CollectOptions): IssuesDraft {
  const { rootDir, editionDir } = opts;
  const edition = opts.edition ?? inferEdition(editionDir);
  const now = opts.now ?? new Date();

  const signals: Signal[] = [];

  // Signal 1: source-health
  const healthPath = resolve(rootDir, "data/source-health.json");
  if (existsSync(healthPath)) {
    try {
      const health: SourceHealthFile = JSON.parse(
        readFileSync(healthPath, "utf8"),
      );
      signals.push(...signalsFromSourceHealth(health, opts.minStreak ?? 3));
    } catch {
      // ignore malformed health file
    }
  }

  // Signal 2: publish-newsletter unfixed_issues
  // resolveReadPath prefere _internal/ (#158) com fallback pra raiz (compat).
  const publishedPath = resolveReadPath(editionDir, "05-published.json");
  if (existsSync(publishedPath)) {
    try {
      const published: PublishedJson = JSON.parse(
        readFileSync(publishedPath, "utf8"),
      );
      signals.push(...signalsFromPublished(published));
    } catch {
      // ignore malformed published file
    }
  }

  // Signal 3 + 4: run-log chrome_disconnects + mcp_unavailable
  const runLogPath = resolve(rootDir, "data/run-log.jsonl");
  if (existsSync(runLogPath)) {
    try {
      const lines = readFileSync(runLogPath, "utf8").split("\n");
      signals.push(
        ...signalsFromRunLog(lines, edition, opts.chromeThreshold ?? 3),
      );
      signals.push(...signalsFromMcpUnavailable(lines, edition));
    } catch {
      // ignore
    }
  }

  return {
    edition,
    collected_at: now.toISOString(),
    signals,
  };
}

function inferEdition(editionDir: string): string | null {
  const name = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  if (name && /^\d{6}$/.test(name)) return name;
  return null;
}

export function writeDraft(draft: IssuesDraft, editionDir: string): string {
  const outPath = resolve(editionDir, "_internal/issues-draft.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return outPath;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionDirArg = args["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: collect-edition-signals.ts --edition-dir <path>");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const draft = collectSignals({ rootDir: ROOT, editionDir });
  const outPath = writeDraft(draft, editionDir);
  console.log(
    JSON.stringify(
      {
        out_path: outPath,
        edition: draft.edition,
        signals_count: draft.signals.length,
        by_kind: {
          source_streak: draft.signals.filter((s) => s.kind === "source_streak").length,
          unfixed_issue: draft.signals.filter((s) => s.kind === "unfixed_issue").length,
          chrome_disconnects: draft.signals.filter((s) => s.kind === "chrome_disconnects").length,
          mcp_unavailable: draft.signals.filter((s) => s.kind === "mcp_unavailable").length,
        },
      },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
