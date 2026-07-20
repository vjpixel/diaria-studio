#!/usr/bin/env npx tsx
/**
 * render-overnight-timeline.ts (#2099, fluxo-neutro #2637)
 *
 * Lê o `plan.json` de uma sessão do coordenador (overnight OU develop) e imprime
 * a tabela de timeline em markdown, derivada do campo `timeline` de cada issue.
 * Serve qualquer plan.json com o schema de issues+timeline — a entrada é o path
 * passado em `--plan`, agnóstica de fluxo.
 *
 * A tabela agrupa por unidade de trabalho (batch ou solo), calcula duração e
 * conta fix-iterations. Degrada graciosamente:
 * - issue sem campo `timeline` → duração "—" (rodada anterior ou interrompida)
 * - `started_at` sem `merged`/`draft`/`pulada` → fim "em andamento"
 *
 * O título da seção e o rótulo do total são parametrizáveis (default = overnight:
 * "Timeline da noite" / "Total da rodada"); `/diaria-develop` passa rótulos de
 * sessão via `--title` / `--total-label`.
 *
 * Uso:
 *   npx tsx scripts/render-overnight-timeline.ts \
 *     --plan data/overnight/260611/plan.json
 *   npx tsx scripts/render-overnight-timeline.ts \
 *     --plan data/develop/260627/plan.json \
 *     --title "Timeline da sessão" --total-label "Total da sessão"
 *
 * Saída: markdown pra stdout.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { fmtTimeBrt } from "./lib/format.ts";
import { EPIC_DEFERRED_STATUS } from "./overnight-statusline.ts"; // #3072 (review do #3071)

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

/** Formata HH:MM em BRT fixo (UTC-3). Não depende do TZ do processo.
 * (#2125) Delega a fmtTimeBrt de scripts/lib/format.ts (helper compartilhado).
 */
function fmtHHMM(d: Date | null): string {
  if (!d) return "—";
  return fmtTimeBrt(d.toISOString());
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

/**
 * Label de fim: "mergeado", "draft", "pulada", "concluída (fora do timeline)"
 * ou "em andamento".
 *
 * `status` (#3072, review do #3071): issues com status `EPIC_DEFERRED_STATUS`
 * ("elegivel_especial" — EPIC deliberadamente deferido até a issue-filha
 * mergear, ver `overnight-statusline.ts`) nunca chegam a ser despachadas
 * (sem `dispatch`, `timeline` tipicamente `{}`) — sem esse check, a row
 * ficava presa em "em andamento" pra sempre, contradizendo a statusLine
 * (que já trata esse status como terminal e mostra "concluída" a 100%)
 * dentro do MESMO relatório da Fase 2.
 *
 * Checagem restrita a ESSE status específico (não ao `isTerminalForBar`
 * genérico, que também casa `mergeada`/`draft-ci-vermelho`/`pulada`): pra
 * QUALQUER outro status terminal, `timeline` vazio indica uma rodada
 * interrompida/legada de verdade (não um EPIC deferido por design) — tratar
 * como "concluída" nesse caso mascararia um dado real de rodada incompleta.
 * `!tl?.dispatch` é defesa extra: se um EPIC deferido chegou a ser
 * despachado por algum motivo, o timeline real tem precedência.
 */
function getEndLabel(tl: IssueTimeline | undefined, status?: string): string {
  if (tl?.merged) return "mergeado";
  if (tl?.draft) return "draft";
  if (tl?.pulada) return "pulada";
  if (!tl?.dispatch && status === EPIC_DEFERRED_STATUS) return "concluída (fora do timeline)";
  if (!tl?.dispatch) return "—";
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
  // ── Passo 1: agrupar issues por batch (manter Set de batches já emitidos) ──
  const batchMap = new Map<string, PlanIssue[]>();

  for (const issue of plan.issues) {
    const batch = issue.batch;
    if (batch && batch !== "null") {
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
    status?: string,
  ): TimelineRow {
    const startStr = getStart(tl);
    const endStr = getEnd(tl);
    const start = parseISO(startStr);
    const end = parseISO(endStr);
    const endLabel = getEndLabel(tl, status);

    const durationMs =
      start && end ? Math.max(0, end.getTime() - start.getTime()) : null;

    return {
      unidade,
      inicio: fmtHHMM(start),
      fim: end ? fmtHHMM(end) : endLabel === "—" ? "—" : endLabel,
      duracao: fmtDuration(start, end),
      durationMs,
      fixIteracoes,
      endLabel,
    };
  }

  // ── Passo 2: percorrer plan.issues em ordem, emitindo cada unidade na
  //    posição da sua PRIMEIRA aparição (lotes: emitir na posição da 1ª issue
  //    do lote, ignorar as demais). Preserva ordem cronológica do plano. ───────
  const emittedBatches = new Set<string>();

  for (const issue of plan.issues) {
    const batch = issue.batch;

    if (!batch || batch === "null") {
      // Solo: emitir imediatamente
      rows.push(makeRow(`#${issue.number}`, issue.timeline, countFixIterations(issue.timeline), issue.status));
    } else if (!emittedBatches.has(batch)) {
      // Primeiro aparecimento do lote: emitir a row do lote aqui
      emittedBatches.add(batch);
      const batchIssues = batchMap.get(batch)!;
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

      rows.push(makeRow(label, representative?.timeline, maxFix, representative?.status));
    }
    // Se batch já foi emitido: ignorar (é uma issue subsequente do mesmo lote)
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


/** Opções de rótulo do renderizador de timeline (fluxo-neutro #2637). */
export interface RenderTimelineOpts {
  /** Título da seção (markdown H2, sem o "## "). Default: "Timeline da noite". */
  title?: string;
  /** Rótulo do total da sessão/rodada. Default: "Total da rodada". */
  totalLabel?: string;
}

/**
 * Renderiza a seção de timeline em markdown, derivada de um plan.json de sessão
 * (overnight ou develop). O título e o rótulo do total são parametrizáveis; os
 * defaults preservam o comportamento overnight byte-a-byte.
 * Exportado para uso em testes.
 */
export function renderTimeline(plan: Plan, opts: RenderTimelineOpts = {}): string {
  const title = opts.title ?? "Timeline da noite";
  const totalLabel = opts.totalLabel ?? "Total da rodada";

  const rows = buildTimelineRows(plan);

  if (rows.length === 0) {
    return `## ${title}\n\n_(nenhuma unidade registrada)_\n`;
  }

  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push("");
  lines.push("| Unidade | Início | Fim | Duração | Fix-iterations |");
  lines.push("|---------|--------|-----|---------|----------------|");

  for (const row of rows) {
    const fix = row.fixIteracoes > 0 ? String(row.fixIteracoes) : "—";
    lines.push(`| ${row.unidade} | ${row.inicio} | ${row.fim} | ${row.duracao} | ${fix} |`);
  }

  lines.push("");

  // Total da sessão/rodada
  const total = buildRodadaTotal(plan);
  lines.push(`**${totalLabel}:** ${total}`);

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

/**
 * @deprecated Alias fluxo-overnight de `renderTimeline` (back-compat, #2637).
 * Mantido para os call-sites do `/diaria-overnight` (Fase 2). Use `renderTimeline`
 * com `opts` para fluxos novos (ex: `/diaria-develop`).
 */
export function renderOvernightTimeline(plan: Plan): string {
  return renderTimeline(plan);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
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
  const title = values["title"];
  const totalLabel = values["total-label"];
  process.stdout.write(
    renderTimeline(plan, {
      ...(title ? { title } : {}),
      ...(totalLabel ? { totalLabel } : {}),
    }),
  );
}
