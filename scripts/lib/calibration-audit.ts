/**
 * scripts/lib/calibration-audit.ts (#7982, auditoria contínua da #7972)
 *
 * Miolo PURO (sem I/O, sem git, sem rede) dos relatórios de auditoria da
 * autocalibração:
 *
 *  - `parseGitNumstatLog` + `summarizeAllowlistGrowth`: crescimento cumulativo
 *    das allowlists de domínio/calibração num período (relatório TRIMESTRAL,
 *    apresentado ao editor pra re-ratificação — NUNCA reverte nada).
 *  - `computeTouchByPhase` + `flagStalledPhases`: minutos totais de toque
 *    editorial (edição + sign-off) antes/depois de cada fase; sinaliza a fase
 *    pra revisão/rollback se o total não caiu em N meses (relatório MENSAL).
 *  - `summarizeCalibrationPrLatency`: latência decisão→timestamp e tempo
 *    estimado de revisão dos PRs de calibração registrados em
 *    `data/reports/index.jsonl`.
 *
 * Os wrappers CLI (`scripts/calibration-*-report.ts`) leem disco/git e chamam
 * isto. Somente leitura; a sinalização é INFORMATIVA (o editor decide
 * rollback — nunca automático).
 */

// ─── Crescimento de allowlists ──────────────────────────────────────────────

export interface AllowlistCommit {
  sha: string;
  date: string; // ISO
  subject: string;
  file: string;
  added: number;
  removed: number;
}

/**
 * Parseia a saída de
 * `git log --format=@@%H|%aI|%s --numstat -- <files>`.
 * Linhas `@@sha|iso|subject` abrem um commit; linhas `add<TAB>del<TAB>path`
 * são numstat (binário `-` vira 0).
 */
export function parseGitNumstatLog(text: string): AllowlistCommit[] {
  const out: AllowlistCommit[] = [];
  let cur: { sha: string; date: string; subject: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("@@")) {
      const body = line.slice(2);
      const i1 = body.indexOf("|");
      const i2 = body.indexOf("|", i1 + 1);
      if (i1 < 0 || i2 < 0) {
        cur = null;
        continue;
      }
      cur = { sha: body.slice(0, i1), date: body.slice(i1 + 1, i2), subject: body.slice(i2 + 1) };
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m && cur) {
      out.push({
        ...cur,
        file: m[3],
        added: m[1] === "-" ? 0 : Number(m[1]),
        removed: m[2] === "-" ? 0 : Number(m[2]),
      });
    }
  }
  return out;
}

/** Conta literais de string com forma de hostname/host+path (proxy do tamanho da allowlist). */
export function countDomainLiterals(content: string): number {
  const re = /"[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/[^"\s]*)?"/gi;
  return (content.match(re) ?? []).length;
}

export interface AllowlistFileGrowth {
  file: string;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  /** Tamanho (literais de domínio) no início/fim do período; null se não medido. */
  sizeStart: number | null;
  sizeEnd: number | null;
  subjects: string[];
}

export interface AllowlistGrowthSummary {
  perFile: AllowlistFileGrowth[];
  totalCommits: number;
  netLines: number;
}

export function summarizeAllowlistGrowth(
  commits: readonly AllowlistCommit[],
  files: readonly string[],
  sizes: Readonly<Record<string, { start: number | null; end: number | null }>> = {},
): AllowlistGrowthSummary {
  const perFile: AllowlistFileGrowth[] = files.map((file) => {
    const mine = commits.filter((c) => c.file === file);
    const subjects: string[] = [];
    for (const c of mine) if (!subjects.includes(c.subject)) subjects.push(c.subject);
    return {
      file,
      commits: new Set(mine.map((c) => c.sha)).size,
      linesAdded: mine.reduce((s, c) => s + c.added, 0),
      linesRemoved: mine.reduce((s, c) => s + c.removed, 0),
      sizeStart: sizes[file]?.start ?? null,
      sizeEnd: sizes[file]?.end ?? null,
      subjects,
    };
  });
  return {
    perFile,
    totalCommits: new Set(commits.map((c) => c.sha)).size,
    netLines: perFile.reduce((s, f) => s + f.linesAdded - f.linesRemoved, 0),
  };
}

export function renderAllowlistGrowthMarkdown(
  s: AllowlistGrowthSummary,
  period: { since: string; until: string },
): string {
  const lines = [
    `# Auditoria trimestral — crescimento de allowlists (${period.since} a ${period.until})`,
    "",
    "Somente leitura. Diff agregado do período para **re-ratificação deliberada do editor** — nenhuma reversão é automática (#7982).",
    "",
    `Commits tocando allowlists: **${s.totalCommits}** — linhas líquidas: **${s.netLines >= 0 ? "+" : ""}${s.netLines}**.`,
    "",
    "| Arquivo | Commits | +linhas | -linhas | Literais (início → fim) |",
    "|---|---|---|---|---|",
  ];
  for (const f of s.perFile) {
    const size = f.sizeStart === null || f.sizeEnd === null ? "n/d" : `${f.sizeStart} → ${f.sizeEnd}`;
    lines.push(`| \`${f.file}\` | ${f.commits} | ${f.linesAdded} | ${f.linesRemoved} | ${size} |`);
  }
  lines.push("", "## Mudanças do período (para ratificar)", "");
  let any = false;
  for (const f of s.perFile) {
    for (const subj of f.subjects) {
      any = true;
      lines.push(`- \`${f.file}\`: ${subj}`);
    }
  }
  if (!any) lines.push("- Nenhuma mudança no período.");
  lines.push("");
  return lines.join("\n");
}

// ─── Minutos de toque por fase ──────────────────────────────────────────────

export interface TouchSample {
  /** AAMMDD da edição. */
  edition: string;
  editMinutes: number;
  signoffMinutes: number;
}

export interface CalibrationPhase {
  name: string;
  /** Data de ativação da fase, YYYY-MM-DD. */
  activatedAt: string;
}

export type PhaseVerdict = "reduziu" | "em-observacao" | "sem-dados" | "sinalizada";

export interface PhaseTouchResult {
  phase: string;
  activatedAt: string;
  beforeEditions: number;
  afterEditions: number;
  beforeTotal: number;
  afterTotal: number;
  beforeMeanPerEdition: number | null;
  afterMeanPerEdition: number | null;
  verdict: PhaseVerdict;
}

export const DEFAULT_STALL_MONTHS = 3;
export const MIN_EDITIONS_PER_WINDOW = 3;

export function editionToDate(edition: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(edition);
  if (!m) return null;
  const d = new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

/**
 * Compara, por fase, os N meses ANTES da ativação com os N meses DEPOIS
 * (média por edição, pra não penalizar janela com menos edições). `now`
 * injetável pra teste. Verdicts:
 *  - `em-observacao`: a janela "depois" ainda não completou N meses;
 *  - `sem-dados`: < MIN_EDITIONS_PER_WINDOW edições em algum lado;
 *  - `reduziu`: média depois < média antes;
 *  - `sinalizada`: janela completa, dados suficientes e o total NÃO caiu →
 *    revisar/rollback (decisão do editor).
 */
export function computeTouchByPhase(
  samples: readonly TouchSample[],
  phases: readonly CalibrationPhase[],
  opts: { months?: number; now: Date },
): PhaseTouchResult[] {
  const months = opts.months ?? DEFAULT_STALL_MONTHS;
  const dated = samples
    .map((s) => ({ d: editionToDate(s.edition), total: s.editMinutes + s.signoffMinutes }))
    .filter((s): s is { d: Date; total: number } => s.d !== null);
  return phases.map((p) => {
    const act = new Date(`${p.activatedAt}T00:00:00Z`);
    const beforeStart = addMonths(act, -months);
    const afterEnd = addMonths(act, months);
    const before = dated.filter((s) => s.d >= beforeStart && s.d < act);
    const after = dated.filter((s) => s.d >= act && s.d < afterEnd);
    const sum = (xs: { total: number }[]) => xs.reduce((a, b) => a + b.total, 0);
    const mean = (xs: { total: number }[]) => (xs.length ? sum(xs) / xs.length : null);
    const beforeMean = mean(before);
    const afterMean = mean(after);
    let verdict: PhaseVerdict;
    if (opts.now < afterEnd) verdict = "em-observacao";
    else if (before.length < MIN_EDITIONS_PER_WINDOW || after.length < MIN_EDITIONS_PER_WINDOW) verdict = "sem-dados";
    else verdict = (afterMean as number) < (beforeMean as number) ? "reduziu" : "sinalizada";
    return {
      phase: p.name,
      activatedAt: p.activatedAt,
      beforeEditions: before.length,
      afterEditions: after.length,
      beforeTotal: sum(before),
      afterTotal: sum(after),
      beforeMeanPerEdition: beforeMean,
      afterMeanPerEdition: afterMean,
      verdict,
    };
  });
}

export function flagStalledPhases(results: readonly PhaseTouchResult[]): PhaseTouchResult[] {
  return results.filter((r) => r.verdict === "sinalizada");
}

export function renderTouchMarkdown(
  results: readonly PhaseTouchResult[],
  meta: { months: number; generatedAt: string },
): string {
  const f = (n: number | null) => (n === null ? "n/d" : n.toFixed(1));
  const lines = [
    `# Minutos de toque editorial por fase (${meta.generatedAt.slice(0, 10)})`,
    "",
    `Toque = minutos de edição + sign-off por edição. Janela: ${meta.months} mês(es) antes vs depois da ativação de cada fase. Somente leitura; sinalização é informativa — rollback é decisão do editor (#7982).`,
    "",
    "| Fase | Ativação | Ed. antes/depois | Total antes → depois (min) | Média/ed. antes → depois | Veredito |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.phase} | ${r.activatedAt} | ${r.beforeEditions}/${r.afterEditions} | ${r.beforeTotal} → ${r.afterTotal} | ${f(r.beforeMeanPerEdition)} → ${f(r.afterMeanPerEdition)} | ${r.verdict} |`,
    );
  }
  const stalled = flagStalledPhases(results);
  lines.push("", "## Fases sinalizadas para revisão/rollback", "");
  if (stalled.length === 0) lines.push("- Nenhuma.");
  for (const r of stalled) {
    lines.push(
      `- **${r.phase}**: o toque médio não caiu em ${meta.months} meses (${f(r.beforeMeanPerEdition)} → ${f(r.afterMeanPerEdition)} min/edição).`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ─── Latência de PRs de calibração ──────────────────────────────────────────

export interface CalibrationReportEntry {
  id: string;
  kind: string;
  sessionId: string;
  createdAt: string;
  /** Timestamp da decisão do editor (opcional — gravado por quem registra). */
  decisionAt?: string;
  /** Tempo estimado de revisão, em minutos (opcional). */
  estimatedReviewMinutes?: number;
}

export interface CalibrationLatencyRow {
  pr: string;
  latencyHours: number | null;
  estimatedReviewMinutes: number | null;
}

export function summarizeCalibrationPrLatency(entries: readonly CalibrationReportEntry[]): {
  rows: CalibrationLatencyRow[];
  missingFields: string[];
  medianLatencyHours: number | null;
} {
  const cal = entries.filter((e) => e.kind === "calibration");
  const rows = cal.map((e) => {
    const c = Date.parse(e.createdAt);
    const d = e.decisionAt ? Date.parse(e.decisionAt) : NaN;
    return {
      pr: e.sessionId,
      latencyHours: Number.isFinite(c) && Number.isFinite(d) ? (d - c) / 3_600_000 : null,
      estimatedReviewMinutes: e.estimatedReviewMinutes ?? null,
    };
  });
  const missingFields = rows
    .filter((r) => r.latencyHours === null || r.estimatedReviewMinutes === null)
    .map((r) => r.pr);
  const lat = rows
    .map((r) => r.latencyHours)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const medianLatencyHours = lat.length
    ? lat.length % 2
      ? lat[(lat.length - 1) / 2]
      : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2
    : null;
  return { rows, missingFields, medianLatencyHours };
}

export function renderLatencyMarkdown(s: ReturnType<typeof summarizeCalibrationPrLatency>): string {
  const lines = ["## PRs de calibração — latência e revisão", ""];
  if (s.rows.length === 0) return lines.concat(["- Nenhum PR de calibração registrado.", ""]).join("\n");
  lines.push("| PR | Latência decisão (h) | Revisão estimada (min) |", "|---|---|---|");
  for (const r of s.rows) {
    lines.push(
      `| #${r.pr} | ${r.latencyHours === null ? "n/d" : r.latencyHours.toFixed(1)} | ${r.estimatedReviewMinutes ?? "n/d"} |`,
    );
  }
  lines.push("", `Mediana de latência: ${s.medianLatencyHours === null ? "n/d" : s.medianLatencyHours.toFixed(1) + " h"}.`);
  if (s.missingFields.length) {
    lines.push(`PRs sem \`decisionAt\`/\`estimatedReviewMinutes\` registrados: ${s.missingFields.map((p) => "#" + p).join(", ")}.`);
  }
  lines.push("");
  return lines.join("\n");
}
