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
import { pathToFileURL } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

// ─── tipos ──────────────────────────────────────────────────────────────────

export interface IssueTimeline {
  dispatch?: string;        // ISO — subagente lançado
  pr_opened?: string;       // ISO — PR aberto
  /** fix_iteration_N (N ≥ 1) — ISO — N-ésima tentativa de fix (CI vermelho).
   *  Campos nomeados fix_iteration_1, fix_iteration_2, ... são suportados
   *  dinamicamente via index signature — uma 3ª iteração não é mais ignorada. */
  fix_iteration_1?: string;
  fix_iteration_2?: string;
  ci_green?: string;        // ISO — CI verde
  merged?: string;          // ISO — PR mergeado
  draft?: string;           // ISO — convertido para draft (CI persistiu vermelho)
  pulada?: string;          // ISO — unidade pulada (bloqueio, sem resposta, etc.)
  [key: string]: string | undefined; // permite fix_iteration_N dinâmico (N ≥ 3)
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

/** Formata HH:MM em BRT fixo (UTC-3). Não depende do TZ do processo. */
function fmtHHMM(d: Date | null): string {
  if (!d) return "—";
  // BRT = UTC-3 (sem ajuste de horário de verão — Brasil aboliu em 2019)
  const brt = new Date(d.getTime() - 3 * 3_600_000);
  const hh = String(brt.getUTCHours()).padStart(2, "0");
  const mm = String(brt.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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

/** Conta fix-iterations presentes no timeline (suporta N dinâmico ≥ 1). */
function countFixIterations(tl: IssueTimeline | undefined): number {
  if (!tl) return 0;
  let n = 0;
  for (const key of Object.keys(tl)) {
    if (/^fix_iteration_\d+$/.test(key) && tl[key]) n++;
  }
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
  /** Duração em ms — armazenado para evitar re-parse da string formatada.
   *  null quando duração é indefinida (sem timestamp de fim). */
  durationMs: number | null;
  fixIteracoes: number;
  endLabel: string;
}

/**
 * Agrega issues em unidades de trabalho e computa métricas de timeline.
 * Unidades solo: 1 issue com batch == null.
 * Lotes: N issues com mesmo batch != null → usar o timeline da 1ª issue que
 * tiver dispatch (representante do lote).
 *
 * Uma única passagem sobre plan.issues (agrupamento via Map por batch).
 */
export function buildTimelineRows(plan: Plan): TimelineRow[] {
  // ── Passo único: agrupar em solo vs. Map<batch, issues[]> ───────────────────
  const soloIssues: PlanIssue[] = [];
  const batchMap = new Map<string, PlanIssue[]>();

  for (const issue of plan.issues) {
    const batch = issue.batch;
    if (!batch || batch === "null") {
      soloIssues.push(issue);
    } else {
      const list = batchMap.get(batch);
      if (list) {
        list.push(issue);
      } else {
        batchMap.set(batch, [issue]);
      }
    }
  }

  const rows: TimelineRow[] = [];

  // ── Helper local: constrói row com durationMs armazenado ────────────────────
  function makeRow(
    unidade: string,
    tl: IssueTimeline | undefined,
    fixIteracoes: number,
  ): TimelineRow {
    const startStr = getStart(tl);
    const endStr = getEnd(tl);
    const start = parseISO(startStr);
    const end = parseISO(endStr);
    const endLabel = getEndLabel(tl);

    const durationMs =
      start && end ? Math.max(0, end.getTime() - start.getTime()) : null;

    return {
      unidade,
      inicio: fmtHHMM(start),
      fim: end ? fmtHHMM(end) : endLabel === "em andamento" ? "em andamento" : "—",
      duracao: fmtDuration(start, end),
      durationMs,
      fixIteracoes,
      endLabel,
    };
  }

  // ── Issues solo ─────────────────────────────────────────────────────────────
  for (const issue of soloIssues) {
    rows.push(makeRow(`#${issue.number}`, issue.timeline, countFixIterations(issue.timeline)));
  }

  // ── Lotes ───────────────────────────────────────────────────────────────────
  for (const [batch, batchIssues] of batchMap) {
    const numbers = batchIssues.map((i) => `#${i.number}`).join(", ");
    const label = `lote ${batch} (${numbers})`;

    // Representante: 1ª com dispatch, ou a 1ª do lote
    const representative =
      batchIssues.find((i) => i.timeline?.dispatch) ?? batchIssues[0];

    // fix-iterations: máximo entre as issues do lote (por conservadorismo)
    const maxFix = batchIssues.reduce(
      (max, i) => Math.max(max, countFixIterations(i.timeline)),
      0,
    );

    rows.push(makeRow(label, representative?.timeline, maxFix));
  }

  return rows;
}

/** Duração da rodada inteira (started_at → último fim registrado). */
function buildRodadaTotal(plan: Plan): string {
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
  const total = buildRodadaTotal(plan);
  lines.push(`**Total da rodada:** ${total}`);

  // Unidade mais lenta — usa durationMs armazenado na row (evita re-parse por regex
  // e o bug maxMs=-1 onde uma unidade de 0m vencia o sentinela).
  let maisLentaRow: TimelineRow | null = null;
  let maxMs = 0; // guard: só elegível se durationMs > 0
  for (const row of rows) {
    if (row.durationMs === null || row.durationMs <= 0) continue;
    if (row.durationMs > maxMs) {
      maxMs = row.durationMs;
      maisLentaRow = row;
    }
  }
  if (maisLentaRow) {
    lines.push(`**Unidade mais lenta:** ${maisLentaRow.unidade} (${maisLentaRow.duracao})`);
  } else {
    lines.push(`**Unidade mais lenta:** —`);
  }

  lines.push("");
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseCliArgs(process.argv.slice(2));
  const planPath = values["plan"];
  if (!planPath) {
    process.stderr.write("Usage: render-overnight-timeline.ts --plan <path-to-plan.json>\n");
    process.exit(2);
  }
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
