#!/usr/bin/env npx tsx
/**
 * render-overnight-timeline.ts (#2099)
 *
 * Lê `data/overnight/{AAMMDD}/plan.json` e imprime a tabela "Timeline da noite"
 * em markdown, derivada do campo `timeline` de cada issue.
 *
 * A tabela agrupa por unidade de trabalho (batch ou solo), calcula duração e
 * conta fix-iterations. Degrada graciosamente:
 * - issue sem campo `timeline` → duração "—" (rodada anterior ou interrompida)
 * - `started_at` sem `merged`/`draft`/`pulada` → fim "em andamento"
 *
 * Uso:
 *   npx tsx scripts/render-overnight-timeline.ts \
 *     --plan data/overnight/260611/plan.json
 *
 * Saída: markdown pra stdout.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ─── tipos ──────────────────────────────────────────────────────────────────

export interface IssueTimeline {
  dispatch?: string;        // ISO — subagente lançado
  pr_opened?: string;       // ISO — PR aberto
  fix_iteration_1?: string; // ISO — 1ª tentativa de fix (CI vermelho)
  fix_iteration_2?: string; // ISO — 2ª tentativa de fix (CI vermelho)
  ci_green?: string;        // ISO — CI verde
  merged?: string;          // ISO — PR mergeado
  draft?: string;           // ISO — convertido para draft (CI persistiu vermelho)
  pulada?: string;          // ISO — unidade pulada (bloqueio, sem resposta, etc.)
}

export interface PlanIssue {
  number: number;
  priority: string;
  status: string;
  batch: string | null;
  pr: number | null;
  timeline?: IssueTimeline;
  [key: string]: unknown;
}

export interface Plan {
  started_at?: string;
  issues: PlanIssue[];
  [key: string]: unknown;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Parseia ISO ou retorna null graciosamente. */
function parseISO(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Formata HH:MM (hora local). */
function fmtHHMM(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Duração legível: "1h23m" ou "45m" ou "—". */
function fmtDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return "—";
  const diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) return "—";
  const totalMin = Math.round(diffMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/** Conta fix-iterations presentes no timeline. */
function countFixIterations(tl: IssueTimeline | undefined): number {
  if (!tl) return 0;
  let n = 0;
  if (tl.fix_iteration_1) n++;
  if (tl.fix_iteration_2) n++;
  return n;
}

/** Retorna o timestamp de início da unidade (dispatch ou started_at fallback). */
function getStart(tl: IssueTimeline | undefined): string | undefined {
  return tl?.dispatch;
}

/** Retorna o timestamp de fim da unidade (merged | draft | pulada). */
function getEnd(tl: IssueTimeline | undefined): string | undefined {
  return tl?.merged ?? tl?.draft ?? tl?.pulada;
}

/** Label de fim: "mergeado", "draft", "pulada" ou "em andamento". */
function getEndLabel(tl: IssueTimeline | undefined): string {
  if (!tl) return "—";
  if (tl.merged) return "mergeado";
  if (tl.draft) return "draft";
  if (tl.pulada) return "pulada";
  return "em andamento";
}

// ─── core ────────────────────────────────────────────────────────────────────

export interface TimelineRow {
  /** Label da unidade — "#NNNN" (solo) ou "lote batch-slug (#A,#B,...)" */
  unidade: string;
  inicio: string;           // HH:MM ou "—"
  fim: string;              // HH:MM ou "em andamento"
  duracao: string;          // "1h23m" ou "—"
  fixIteracoes: number;
  endLabel: string;
}

/**
 * Agrega issues em unidades de trabalho e computa métricas de timeline.
 * Unidades solo: 1 issue com batch == null.
 * Lotes: N issues com mesmo batch != null → usar o timeline da 1ª issue que
 * tiver dispatch (representante do lote).
 */
export function buildTimelineRows(plan: Plan): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const seenBatches = new Map<string, true>();

  for (const issue of plan.issues) {
    const batch = issue.batch;

    if (!batch || batch === "null") {
      // Unidade solo
      const tl = issue.timeline;
      const startStr = getStart(tl);
      const endStr = getEnd(tl);
      const start = parseISO(startStr);
      const end = parseISO(endStr);
      rows.push({
        unidade: `#${issue.number}`,
        inicio: fmtHHMM(start),
        fim: end ? fmtHHMM(end) : getEndLabel(tl) === "em andamento" ? "em andamento" : "—",
        duracao: fmtDuration(start, end),
        fixIteracoes: countFixIterations(tl),
        endLabel: getEndLabel(tl),
      });
    } else {
      // Lote — emitir apenas 1 linha por batch
      if (seenBatches.has(batch)) continue;
      seenBatches.set(batch, true);

      const batchIssues = plan.issues.filter(
        (i) => i.batch === batch,
      );
      const numbers = batchIssues.map((i) => `#${i.number}`).join(", ");
      const label = `lote ${batch} (${numbers})`;

      // Usar o timeline da issue representante (a que tiver dispatch, ou a primeira)
      const representative =
        batchIssues.find((i) => i.timeline?.dispatch) ?? batchIssues[0];
      const tl = representative?.timeline;
      const startStr = getStart(tl);
      const endStr = getEnd(tl);
      const start = parseISO(startStr);
      const end = parseISO(endStr);

      // fix-iterations: máximo entre as issues do lote (por conservadorismo)
      const maxFix = batchIssues.reduce(
        (max, i) => Math.max(max, countFixIterations(i.timeline)),
        0,
      );

      rows.push({
        unidade: label,
        inicio: fmtHHMM(start),
        fim: end ? fmtHHMM(end) : getEndLabel(tl) === "em andamento" ? "em andamento" : "—",
        duracao: fmtDuration(start, end),
        fixIteracoes: maxFix,
        endLabel: getEndLabel(tl),
      });
    }
  }

  return rows;
}

/** Duração da rodada inteira (started_at → último fim registrado). */
function buildRodadaTotal(plan: Plan, rows: TimelineRow[]): string {
  const rodadaStart = parseISO(plan.started_at);
  if (!rodadaStart) return "—";

  // Último timestamp de fim entre todas as issues
  let latestEnd: Date | null = null;
  for (const issue of plan.issues) {
    const endStr = getEnd(issue.timeline);
    const d = parseISO(endStr);
    if (d && (!latestEnd || d > latestEnd)) latestEnd = d;
  }
  return fmtDuration(rodadaStart, latestEnd);
}


/**
 * Renderiza a seção "Timeline da noite" em markdown.
 * Exportado para uso em testes.
 */
export function renderOvernightTimeline(plan: Plan): string {
  const rows = buildTimelineRows(plan);

  if (rows.length === 0) {
    return "## Timeline da noite\n\n_(nenhuma unidade registrada)_\n";
  }

  const lines: string[] = [];
  lines.push("## Timeline da noite");
  lines.push("");
  lines.push("| Unidade | Início | Fim | Duração | Fix-iterations |");
  lines.push("|---------|--------|-----|---------|----------------|");

  for (const row of rows) {
    const fix = row.fixIteracoes > 0 ? String(row.fixIteracoes) : "—";
    lines.push(`| ${row.unidade} | ${row.inicio} | ${row.fim} | ${row.duracao} | ${fix} |`);
  }

  lines.push("");

  // Rodada total
  const total = buildRodadaTotal(plan, rows);
  lines.push(`**Total da rodada:** ${total}`);

  // Unidade mais lenta — recalcular de forma simples
  let maxMs = -1;
  let maisLentaLabel = "—";
  for (const issue of plan.issues) {
    const start = parseISO(getStart(issue.timeline));
    const end = parseISO(getEnd(issue.timeline));
    if (!start || !end) continue;
    const ms = end.getTime() - start.getTime();
    if (ms > maxMs) {
      maxMs = ms;
      const batch = issue.batch && issue.batch !== "null" ? issue.batch : null;
      maisLentaLabel = batch ? `lote ${batch}` : `#${issue.number}`;
    }
  }
  if (maxMs >= 0) {
    const totalMin = Math.round(maxMs / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const dur = h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
    lines.push(`**Unidade mais lenta:** ${maisLentaLabel} (${dur})`);
  } else {
    lines.push(`**Unidade mais lenta:** —`);
  }

  lines.push("");
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { plan: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!flags.plan) {
    process.stderr.write("Usage: render-overnight-timeline.ts --plan <path-to-plan.json>\n");
    process.exit(2);
  }
  return { plan: flags.plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { plan: planPath } = parseArgs(process.argv.slice(2));
  const absPath = resolve(process.cwd(), planPath);
  if (!existsSync(absPath)) {
    process.stderr.write(`Arquivo não encontrado: ${absPath}\n`);
    process.exit(1);
  }
  let plan: Plan;
  try {
    plan = JSON.parse(readFileSync(absPath, "utf8")) as Plan;
  } catch (e) {
    process.stderr.write(`Erro ao parsear plan.json: ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(renderOvernightTimeline(plan));
}
