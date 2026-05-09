/**
 * bug-heatmap.ts (#1014)
 *
 * Agrega bugs do GitHub via `gh issue list --label bug --state all` e gera
 * heatmap por stage. Output: markdown com ASCII heatmap + tabela detalhada.
 *
 * Pré-requisito: issues precisam ter labels `stage-{0..5}`, `stage-publish`,
 * `stage-research` aplicadas (manual ou via backfill — editor-side).
 *
 * Uso:
 *   npx tsx scripts/bug-heatmap.ts                    # imprime heatmap em stdout
 *   npx tsx scripts/bug-heatmap.ts --out docs/bug-heatmap.md  # escreve em arquivo
 *
 * Métricas:
 *   - Count: total de bugs por stage (open + closed nos últimos 90 dias)
 *   - MTTR: mean time-to-fix em horas (closedAt - createdAt) — só pra closed
 *   - Recorrência: bugs com label "regression-*" ou cujo título contenha "regression"
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GhIssueLabel {
  name: string;
}

export interface GhIssueRaw {
  number: number;
  title: string;
  // gh CLI retorna state em UPPERCASE ("OPEN" | "CLOSED"). Aceitamos ambos
  // pra robustez (tests passam lowercase, prod passa uppercase).
  state: "OPEN" | "CLOSED" | "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  labels: GhIssueLabel[];
}

/** Normaliza state pra lowercase. gh CLI retorna UPPERCASE; tests usam lowercase. */
function normalizeState(s: string): "open" | "closed" {
  return s.toLowerCase() === "open" ? "open" : "closed";
}

export interface StageStats {
  stage: string;
  total: number;
  open: number;
  closed: number;
  mttr_hours: number | null; // null se 0 closed bugs
  recurrence_count: number;
  example_issues: number[]; // até 5 issue numbers pra inspeção rápida
}

const STAGES = [
  "stage-0",
  "stage-1",
  "stage-2",
  "stage-3",
  "stage-4",
  "stage-5",
  "stage-publish",
  "stage-research",
  "(unlabeled)",
] as const;

// ─── Pure functions (testáveis) ────────────────────────────────────────────

/** Extrai labels de stage de uma issue. Issue pode ter 0+ stages. */
export function extractStageLabels(issue: GhIssueRaw): string[] {
  const stages = issue.labels
    .map((l) => l.name)
    .filter((n) => /^stage-/.test(n));
  return stages.length > 0 ? stages : ["(unlabeled)"];
}

/** Detecta se uma issue é regression (label "regression-*" OU título contém "regression"). */
export function isRegression(issue: GhIssueRaw): boolean {
  const hasLabel = issue.labels.some((l) => /^regression/i.test(l.name));
  const hasTitle = /regression/i.test(issue.title);
  return hasLabel || hasTitle;
}

/** Time-to-fix em horas (createdAt → closedAt). Null se ainda aberto. */
export function timeToFixHours(issue: GhIssueRaw): number | null {
  if (!issue.closedAt) return null;
  const created = new Date(issue.createdAt).getTime();
  const closed = new Date(issue.closedAt).getTime();
  return (closed - created) / (1000 * 60 * 60);
}

/** Agrega stats por stage. */
export function aggregateByStage(issues: GhIssueRaw[]): StageStats[] {
  const buckets = new Map<string, GhIssueRaw[]>();
  for (const issue of issues) {
    for (const stage of extractStageLabels(issue)) {
      if (!buckets.has(stage)) buckets.set(stage, []);
      buckets.get(stage)!.push(issue);
    }
  }

  return STAGES.map((stage) => {
    const bucket = buckets.get(stage) ?? [];
    const closed = bucket.filter((i) => normalizeState(i.state) === "closed");
    const ttfList = closed
      .map(timeToFixHours)
      .filter((t): t is number => t !== null);
    const mttr = ttfList.length > 0
      ? ttfList.reduce((a, b) => a + b, 0) / ttfList.length
      : null;
    const examples = bucket.slice(0, 5).map((i) => i.number);
    return {
      stage,
      total: bucket.length,
      open: bucket.filter((i) => normalizeState(i.state) === "open").length,
      closed: closed.length,
      mttr_hours: mttr,
      recurrence_count: bucket.filter(isRegression).length,
      example_issues: examples,
    };
  });
}

/** Gera ASCII heatmap. Bar com largura proporcional ao count máximo. */
export function renderHeatmap(stats: StageStats[]): string {
  const maxTotal = Math.max(...stats.map((s) => s.total), 1);
  const barWidth = 30;
  const lines: string[] = [];
  lines.push("Stage              | Bugs (■ ≈ proporcional ao máximo)");
  lines.push("-".repeat(70));
  for (const s of stats) {
    const filled = Math.round((s.total / maxTotal) * barWidth);
    const bar = "■".repeat(filled) + "·".repeat(barWidth - filled);
    const stageLabel = s.stage.padEnd(18);
    lines.push(`${stageLabel} | ${bar} ${s.total} (open ${s.open})`);
  }
  return lines.join("\n");
}

/**
 * Formata MTTR pra display:
 *   - null  → "—"
 *   - <24h  → "Nh" (uma casa decimal)
 *   - ≥24h  → "Nd" (dias com uma casa decimal)
 *   Bugs antigos têm MTTR em milhares de horas; dias é mais legível.
 */
export function formatMttr(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** Gera tabela markdown detalhada. */
export function renderTable(stats: StageStats[]): string {
  const lines: string[] = [];
  lines.push("| Stage | Total | Open | Closed | MTTR | Regression | Examples |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of stats) {
    const mttr = formatMttr(s.mttr_hours);
    const examples = s.example_issues.map((n) => `#${n}`).join(", ") || "—";
    lines.push(
      `| ${s.stage} | ${s.total} | ${s.open} | ${s.closed} | ${mttr} | ${s.recurrence_count} | ${examples} |`,
    );
  }
  return lines.join("\n");
}

/** Renderiza markdown completo (header + heatmap ASCII + tabela). */
export function renderReport(stats: StageStats[], generatedAt: Date = new Date()): string {
  const totalBugs = stats.reduce((sum, s) => sum + s.total, 0);
  const totalOpen = stats.reduce((sum, s) => sum + s.open, 0);
  const totalRecurrence = stats.reduce((sum, s) => sum + s.recurrence_count, 0);
  const lines: string[] = [];
  lines.push(`# Bug Heatmap — Diar.ia`);
  lines.push("");
  lines.push(`**Gerado em**: ${generatedAt.toISOString()}`);
  lines.push(`**Total de bugs analisados**: ${totalBugs} (${totalOpen} open)`);
  lines.push(`**Regressions detectadas**: ${totalRecurrence}`);
  lines.push("");
  lines.push(`## ASCII Heatmap`);
  lines.push("");
  lines.push("```");
  lines.push(renderHeatmap(stats));
  lines.push("```");
  lines.push("");
  lines.push(`## Tabela detalhada`);
  lines.push("");
  lines.push(renderTable(stats));
  lines.push("");
  lines.push(`## Como interpretar`);
  lines.push("");
  lines.push(`- **Stage com maior count**: priorize Fase 2 (Zod) e pre-flight invariants ali primeiro.`);
  lines.push(`- **MTTR alto**: falta cobertura de teste — bugs demoram a ser detectados.`);
  lines.push(`- **Regressions**: indicam regra de #633 (PR de bugfix exige teste) não está sendo seguida em alguma área.`);
  lines.push(`- **(unlabeled)**: issues sem stage-* — backfill de labels reduz esse bucket.`);
  return lines.join("\n");
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function fetchBugIssues(): GhIssueRaw[] {
  const result = spawnSync(
    "gh",
    [
      "issue", "list",
      "--label", "bug",
      "--state", "all",
      "--limit", "1000",
      "--json", "number,title,state,createdAt,closedAt,labels",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`gh issue list falhou: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as GhIssueRaw[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

  const issues = fetchBugIssues();
  const stats = aggregateByStage(issues);
  const report = renderReport(stats);

  if (outPath) {
    writeFileSync(outPath, report, "utf8");
    process.stderr.write(`Heatmap escrito: ${outPath}\n`);
  } else {
    process.stdout.write(report);
  }
}

const _argv1 = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
