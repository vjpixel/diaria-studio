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
 * Modo `--include-test-warnings` (#519): adiciona um 5º coletor de sinais
 * focado em qualquer error/warn no run-log da edição (agrupado por agent +
 * mensagem normalizada). Usado pelo `/diaria-test` para virar regressões
 * em issues automaticamente, sem gate humano.
 *
 * Uso:
 *   npx tsx scripts/collect-edition-signals.ts --edition-dir data/editions/260424/
 *   npx tsx scripts/collect-edition-signals.ts --edition-dir data/editions/260424/ --include-test-warnings
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
import { runMain } from "./lib/exit-handler.ts";

export type Severity = "low" | "medium" | "high";

export interface Signal {
  kind:
    | "source_streak"
    | "unfixed_issue"
    | "chrome_disconnects"
    | "mcp_unavailable"
    | "test_warning";
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
  stage?: number;
  agent?: string;
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
// Signal 5 (opt-in via --include-test-warnings, #519): generic error/warn
// events na edição agrupados por agent + mensagem normalizada.
//
// Usado pelo /diaria-test pra capturar regressões "soltas" — qualquer crash
// de script, falha de validação, warning de drive-sync/link-verifier, etc.
// que não bata os matchers específicos de Signals 1-4 vira aqui um signal
// individual com kind=test_warning.
// ===========================================================================

/** Patterns de mensagem cobertos pelos signals 3 (chrome_disconnects) e 4
 *  (mcp_unavailable). Eventos que batem em qualquer um destes não são
 *  re-emitidos como test_warning para evitar duplicação. */
const TEST_WARNING_SKIP_PATTERNS: RegExp[] = [
  /chrome_disconnected/i,
  /not connected/i,
  /extension disconnected/i,
  /chrome desconectado/i,
  /claude-in-chrome mcp unavailable/i,
  /claude_in_chrome_mcp_unavailable/i,
  // #556, #559 — by-design no /diaria-test: warns que mencionam test_mode
  // não merecem virar issue (são comportamento esperado em modo teste).
  /test_mode/i,
];

// Nota (#565): warns informativos eram detectados via regex `/\(informativo\)/i`
// no message (acoplamento textual frágil). Substituído por flag estruturada
// `details.informational === true`, checada abaixo em signalsFromTestWarnings.
// Callers usam `--informational` em scripts/log-event.ts.

/** Patterns que casam contra `details.reason` do log. Mesmo critério de skip
 *  que TEST_WARNING_SKIP_PATTERNS, mas inspeciona o details em vez do message
 *  — alguns warns têm message neutro e o "by-design" só fica explícito no
 *  details.reason (ex: dedup_freshness_override com reason='test_mode auto-approve'). */
const TEST_WARNING_SKIP_REASON_PATTERNS: RegExp[] = [
  /test_mode/i,
];

/** Normaliza mensagem para chave de dedup (lowercase, primeiros 80 chars
 *  alfanuméricos). Eventos repetidos do mesmo agent+mensagem viram um
 *  único signal com count agregado. */
export function normalizeMessageKey(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

interface TestWarningBucket {
  agent: string;
  level: "error" | "warn";
  message: string;
  count: number;
  first_at?: string;
  last_at?: string;
  sample_details: Record<string, unknown> | null;
  stages: Set<number>;
}

export function signalsFromTestWarnings(
  lines: string[],
  edition: string | null,
): Signal[] {
  const buckets = new Map<string, TestWarningBucket>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: LogEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (edition && parsed.edition && parsed.edition !== edition) continue;
    // Sem edição informada no log: só consideramos se chamador também está
    // sem filtro (edition === null), pra evitar capturar eventos órfãos
    // de outras runs.
    if (edition && !parsed.edition) continue;
    if (parsed.level !== "error" && parsed.level !== "warn") continue;
    const message = parsed.message ?? "";
    if (!message) continue;
    if (TEST_WARNING_SKIP_PATTERNS.some((re) => re.test(message))) continue;
    const detailsObj = parsed.details as Record<string, unknown> | undefined;
    // #565 — flag estruturada substitui regex `/\(informativo\)/i` em message.
    if (detailsObj?.informational === true) continue;
    const reason = detailsObj?.reason;
    if (
      typeof reason === "string" &&
      TEST_WARNING_SKIP_REASON_PATTERNS.some((re) => re.test(reason))
    ) {
      continue;
    }

    const agent = parsed.agent ?? "unknown";
    const key = `${agent}::${parsed.level}::${normalizeMessageKey(message)}`;
    const existing = buckets.get(key);
    const stage =
      typeof (parsed as { stage?: unknown }).stage === "number"
        ? ((parsed as { stage: number }).stage)
        : null;

    if (existing) {
      existing.count++;
      if (parsed.timestamp) existing.last_at = parsed.timestamp;
      if (stage !== null) existing.stages.add(stage);
    } else {
      buckets.set(key, {
        agent,
        level: parsed.level as "error" | "warn",
        message,
        count: 1,
        first_at: parsed.timestamp,
        last_at: parsed.timestamp,
        sample_details: parsed.details ?? null,
        stages: new Set(stage !== null ? [stage] : []),
      });
    }
  }

  const out: Signal[] = [];
  for (const b of buckets.values()) {
    const severity: Severity = b.level === "error" ? "high" : "medium";
    const stagesArr = Array.from(b.stages).sort((a, z) => a - z);
    const shortMsg = b.message.length > 100
      ? b.message.slice(0, 97) + "..."
      : b.message;
    out.push({
      kind: "test_warning",
      severity,
      title: `${b.agent}: ${shortMsg}`,
      details: {
        agent: b.agent,
        level: b.level,
        message: b.message,
        count: b.count,
        first_at: b.first_at ?? null,
        last_at: b.last_at ?? null,
        stages: stagesArr,
        sample_details: b.sample_details,
      },
      suggested_action:
        b.level === "error"
          ? `Investigar falha de ${b.agent} — ${b.count} ocorrência(s) durante edição de teste. Reproduzir manualmente e corrigir o root cause antes da próxima edição real.`
          : `Avaliar warning recorrente de ${b.agent} (${b.count}× na edição de teste) — pode indicar regressão silenciosa.`,
    });
  }
  return out;
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
  /** #519 — quando true, inclui signals genéricos `test_warning` derivados
   *  de qualquer error/warn no run-log da edição que não casa com signals
   *  1-4. Ativado por `--include-test-warnings` no CLI. */
  includeTestWarnings?: boolean;
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
  // Signal 5 (opt-in #519): test_warning genérico
  const runLogPath = resolve(rootDir, "data/run-log.jsonl");
  if (existsSync(runLogPath)) {
    try {
      const lines = readFileSync(runLogPath, "utf8").split("\n");
      signals.push(
        ...signalsFromRunLog(lines, edition, opts.chromeThreshold ?? 3),
      );
      signals.push(...signalsFromMcpUnavailable(lines, edition));
      if (opts.includeTestWarnings) {
        signals.push(...signalsFromTestWarnings(lines, edition));
      }
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

function parseArgs(argv: string[]): {
  flags: Set<string>;
  values: Record<string, string>;
} {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[key] = next;
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { flags, values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error(
      "Uso: collect-edition-signals.ts --edition-dir <path> [--include-test-warnings]",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const includeTestWarnings = flags.has("include-test-warnings");
  const draft = collectSignals({
    rootDir: ROOT,
    editionDir,
    includeTestWarnings,
  });
  const outPath = writeDraft(draft, editionDir);
  console.log(
    JSON.stringify(
      {
        out_path: outPath,
        edition: draft.edition,
        signals_count: draft.signals.length,
        include_test_warnings: includeTestWarnings,
        by_kind: {
          source_streak: draft.signals.filter((s) => s.kind === "source_streak").length,
          unfixed_issue: draft.signals.filter((s) => s.kind === "unfixed_issue").length,
          chrome_disconnects: draft.signals.filter((s) => s.kind === "chrome_disconnects").length,
          mcp_unavailable: draft.signals.filter((s) => s.kind === "mcp_unavailable").length,
          test_warning: draft.signals.filter((s) => s.kind === "test_warning").length,
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
  runMain(async () => main());
}
