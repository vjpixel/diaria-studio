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
    | "test_warning"
    | "runtime_fix";
  severity: Severity;
  title: string;
  details: Record<string, unknown>;
  suggested_action: string;
  related_issue?: string;
}

// ===========================================================================
// Signal 6 (#1210): runtime fixes — correções in-flight do orchestrator
// ===========================================================================

interface RuntimeFixEntry {
  timestamp: string;
  edition: string;
  stage: number;
  fix_type: string;
  component: string;
  description: string;
  severity: "P0" | "P1" | "P2" | "P3";
  context?: Record<string, unknown>;
}

/**
 * Lê `_internal/runtime-fixes.jsonl` (escrito pelo `log-runtime-fix.ts`) e
 * vira sinais pro auto-reporter. Cada fix com severity P0/P1/P2 vira um
 * candidato a issue; P3 fica de fora (cleanup, não vale auto-reportar).
 *
 * Agrupa por `component` pra detectar fixes recorrentes no mesmo agent/script.
 */
export function signalsFromRuntimeFixes(jsonlContent: string): Signal[] {
  if (!jsonlContent.trim()) return [];
  const entries: RuntimeFixEntry[] = [];
  for (const line of jsonlContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  // Filtrar P3 fora
  const significant = entries.filter((e) => e.severity !== "P3");
  if (significant.length === 0) return [];

  // Agrupar por (component, fix_type) pra evitar 1 issue por entrada
  const groups = new Map<string, RuntimeFixEntry[]>();
  for (const e of significant) {
    const key = `${e.component}::${e.fix_type}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  const out: Signal[] = [];
  for (const [key, group] of groups) {
    const [component, fixType] = key.split("::");
    const worstSeverity = group.reduce((acc, e) => {
      const rank = (s: string) => ({ P0: 0, P1: 1, P2: 2, P3: 3 } as Record<string, number>)[s] ?? 9;
      return rank(e.severity) < rank(acc.severity) ? e : acc;
    }, group[0]).severity;
    const sevLabel: Severity = worstSeverity === "P0" || worstSeverity === "P1" ? "high" : "medium";

    out.push({
      kind: "runtime_fix",
      severity: sevLabel,
      title: `${component}: ${group.length}× runtime fix(${fixType})`,
      details: {
        component,
        fix_type: fixType,
        count: group.length,
        severities: group.map((e) => e.severity),
        descriptions: group.map((e) => e.description.slice(0, 200)),
        first_at: group[0].timestamp,
        last_at: group[group.length - 1].timestamp,
      },
      suggested_action: `Investigar ${component} — orchestrator aplicou ${group.length} runtime fix(es) do tipo ${fixType}. Se for recorrente, considerar fix permanente no agent/script.`,
    });
  }
  return out;
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

/**
 * Threshold de severity baseado em max duração de disconnect (#766).
 * - < 60s ou sem max_duration_ms calculado: low (provavelmente flapping aceitável)
 * - 60s ≤ d < 5min: medium
 * - ≥ 5min OU disconnect sem reconnect (still down): high
 */
export function severityFromDuration(
  maxDurationMs: number | null,
  hasUnpaired: boolean,
): Severity {
  if (hasUnpaired) return "high";
  if (maxDurationMs === null) return "low";
  if (maxDurationMs >= 5 * 60 * 1000) return "high";
  if (maxDurationMs >= 60 * 1000) return "medium";
  return "low";
}

/**
 * Pure helper: dado um array de eventos `mcp_disconnect:` / `mcp_reconnect:`
 * em ordem cronológica, pareia disconnects com reconnects subsequentes do
 * mesmo server e retorna durações + flag de unpaired.
 *
 * `events` deve estar em ordem ASC por timestamp (caller responsável).
 */
export function pairDisconnectReconnect(
  events: Array<{ kind: "disconnect" | "reconnect"; server: string; timestamp: string }>,
): { durations: Array<{ server: string; ms: number }>; hasUnpaired: boolean } {
  const opens = new Map<string, string>(); // server → ts of last unmatched disconnect
  const durations: Array<{ server: string; ms: number }> = [];
  for (const ev of events) {
    if (ev.kind === "disconnect") {
      // Se já há um disconnect aberto pra esse server sem reconnect, mantemos o
      // primeiro (subsequente é flap dentro do disconnect inicial).
      if (!opens.has(ev.server)) opens.set(ev.server, ev.timestamp);
    } else {
      const open = opens.get(ev.server);
      if (open) {
        const ms = new Date(ev.timestamp).getTime() - new Date(open).getTime();
        if (Number.isFinite(ms) && ms >= 0) durations.push({ server: ev.server, ms });
        opens.delete(ev.server);
      }
      // reconnect sem disconnect aberto = ignorado (recobertura ambígua, drop)
    }
  }
  return { durations, hasUnpaired: opens.size > 0 };
}

export function signalsFromMcpUnavailable(
  lines: string[],
  edition: string | null,
): Signal[] {
  let count = 0;
  const firstAt: string[] = [];
  const servers = new Set<string>();
  // #766: coletar eventos disconnect+reconnect (ambos níveis) pra pair-and-measure.
  const events: Array<{ kind: "disconnect" | "reconnect"; server: string; timestamp: string }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: LogEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (edition && parsed.edition && parsed.edition !== edition) continue;

    const msg = (parsed.message ?? "").toLowerCase();

    // #766: capturar mcp_reconnect: (info-level) pra pair com disconnect.
    // Reconnects sozinhos não geram signal — só viram pareados.
    if (msg.startsWith("mcp_reconnect:") && typeof parsed.timestamp === "string") {
      const serverName = (parsed.message ?? "").slice("mcp_reconnect:".length).trim();
      if (serverName) {
        events.push({ kind: "reconnect", server: serverName, timestamp: parsed.timestamp });
      }
      continue;
    }

    if (parsed.level !== "error" && parsed.level !== "warn") continue;

    const matched =
      msg.includes("claude-in-chrome mcp unavailable") ||
      msg.includes("claude_in_chrome_mcp_unavailable") ||
      // New structured format from orchestrator (#759): "mcp_disconnect: {server}"
      msg.startsWith("mcp_disconnect:") ||
      // Catch-all genérico, restrito a contexto claude/chrome pra evitar
      // false-positive em outros MCPs (Beehiiv, Clarice, etc) que possam
      // logar a mesma string sem o prefixo específico.
      (msg.includes("mcp unavailable") &&
        (msg.includes("claude") || msg.includes("chrome")));
    if (matched) {
      count++;
      if (
        typeof parsed.timestamp === "string" &&
        firstAt.length < 5
      ) {
        firstAt.push(parsed.timestamp);
      }
      // Extract server name from structured "mcp_disconnect: {server}" format (#759)
      // #766: APENAS o formato estruturado vai pro pareamento. Legacy logs
      // ("claude-in-chrome MCP unavailable" e variantes) caem no fallback de
      // severity=medium pra preservar comportamento prévio.
      if (msg.startsWith("mcp_disconnect:")) {
        const extracted = (parsed.message ?? "").slice("mcp_disconnect:".length).trim();
        if (extracted) {
          servers.add(extracted);
          if (typeof parsed.timestamp === "string") {
            events.push({ kind: "disconnect", server: extracted, timestamp: parsed.timestamp });
          }
        }
      } else if (msg.includes("chrome") || msg.includes("claude-in-chrome")) {
        servers.add("claude-in-chrome");
      }
    }
  }

  if (count === 0) return [];

  // #766: pareia disconnects/reconnects e calcula severity baseada em duração.
  // Ordenar eventos por timestamp ASC (run-log já costuma estar em ordem mas
  // não é garantido — backfill ou re-merge pode bagunçar).
  events.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const { durations, hasUnpaired } = pairDisconnectReconnect(events);
  const durationsMs = durations.map((d) => d.ms);
  const maxDurationMs = durationsMs.length > 0 ? Math.max(...durationsMs) : null;

  // #766: severity calculation. Quando há events tracked, usa novo threshold.
  // Sem events (count > 0 mas timestamps ausentes/legados) preserva
  // comportamento prévio: medium. Garante backwards-compat com logs antigos.
  let severity: Severity;
  if (events.length === 0) {
    severity = "medium";
  } else {
    severity = severityFromDuration(maxDurationMs, hasUnpaired);
    // Flapping (max < 60s e todos pareados) → drop signal.
    if (severity === "low" && !hasUnpaired) return [];
  }

  // Use a generic title when non-Chrome MCPs are involved (#759)
  const hasChromeOnly = servers.size === 0 || (servers.size === 1 && servers.has("claude-in-chrome"));
  const serverList = servers.size > 0 ? Array.from(servers).join(", ") : "claude-in-chrome";
  const title = hasChromeOnly
    ? `Claude in Chrome MCP indisponível na edição (${count} ocorrência${count > 1 ? "s" : ""})`
    : `MCP indisponível na edição: ${serverList} (${count} ocorrência${count > 1 ? "s" : ""})`;

  return [
    {
      kind: "mcp_unavailable",
      severity,
      title,
      details: {
        count,
        servers: Array.from(servers),
        first_occurrences: firstAt,
        // #766: durações entre disconnect e reconnect (ms). Vazio = nenhum par
        // completo. `unpaired_disconnects: true` indica que server ficou down
        // até o fim da edição (sem reconnect logado).
        durations_ms: durationsMs,
        max_duration_ms: maxDurationMs,
        unpaired_disconnects: hasUnpaired,
      },
      suggested_action:
        hasChromeOnly
          ? "Verificar se a extensão Claude in Chrome está instalada, ativa e logada antes da próxima edição. Stage 5 (Beehiiv) e LinkedIn do Stage 6 dependem desse MCP — pré-flight automático sendo discutido em #143."
          : `MCP(s) ${serverList} ficaram offline durante a edição. Verificar conectividade e configuração antes da próxima rodada.`,
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
  // #759 — structured MCP disconnect/reconnect events logged by orchestrators.
  // Already captured by signalsFromMcpUnavailable — skip to avoid duplication.
  /^mcp_disconnect:/i,
  /^mcp_reconnect:/i,
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
  /**
   * #1304 — filtro por timestamp do início da run. Quando setado, descarta
   * entries de `data/run-log.jsonl` cujo `timestamp < since` antes de virar
   * signals. Cobre o caso de edition ID reutilizada (ex: `/diaria-test`
   * re-executado, ou backup/restore) onde signals stale poluem o auto-reporter.
   *
   * Quando não setado, `collectSignals` tenta auto-detectar via
   * `_internal/stage-status.json > run_started_at`. Sem filtro disponível,
   * mantém comportamento histórico (todos os signals com edition match).
   */
  since?: string;
}

/**
 * #1304 — filtra linhas do run-log mantendo só entries com timestamp >= since.
 * Entries malformadas ou sem timestamp passam (conservador: na dúvida, manter).
 */
export function filterLinesSince(lines: string[], since: string | undefined): string[] {
  if (!since) return lines;
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) return lines;
  return lines.filter((line) => {
    if (!line.trim()) return false;
    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      if (typeof parsed.timestamp !== "string") return true;
      const ms = new Date(parsed.timestamp).getTime();
      if (!Number.isFinite(ms)) return true;
      return ms >= sinceMs;
    } catch {
      return false; // malformed line — drop
    }
  });
}

/**
 * #1304 — lê `_internal/stage-status.json` e extrai `run_started_at` se
 * existir. Usado pra auto-detect quando `--since` não é passado explicitamente.
 */
export function readRunStartedAt(editionDir: string): string | undefined {
  const statusPath = resolve(editionDir, "_internal/stage-status.json");
  if (!existsSync(statusPath)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(statusPath, "utf8")) as {
      run_started_at?: string;
    };
    return typeof doc.run_started_at === "string" ? doc.run_started_at : undefined;
  } catch {
    return undefined;
  }
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
      const rawLines = readFileSync(runLogPath, "utf8").split("\n");
      // #1304 — filter por run_started_at: descarta signals stale de runs
      // anteriores quando edition ID é reutilizada.
      const since = opts.since ?? readRunStartedAt(editionDir);
      const lines = filterLinesSince(rawLines, since);
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

  // Signal 6 (#1210): runtime-fixes.jsonl — orchestrator in-flight fixes
  const runtimeFixesPath = resolve(editionDir, "_internal/runtime-fixes.jsonl");
  if (existsSync(runtimeFixesPath)) {
    try {
      const content = readFileSync(runtimeFixesPath, "utf8");
      signals.push(...signalsFromRuntimeFixes(content));
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
  // #1304 — `--since ISO` força filter por timestamp; sem flag, auto-detect
  // via `_internal/stage-status.json > run_started_at`.
  const since = values["since"];
  const draft = collectSignals({
    rootDir: ROOT,
    editionDir,
    includeTestWarnings,
    since,
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
          runtime_fix: draft.signals.filter((s) => s.kind === "runtime_fix").length,
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
