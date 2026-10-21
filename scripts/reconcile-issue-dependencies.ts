#!/usr/bin/env npx tsx
/**
 * scripts/reconcile-issue-dependencies.ts (#7137)
 *
 * Varre issues abertas, lê o marcador `<!-- depends-on: #N -->` de
 * `scripts/lib/issue-depends-on.ts`, consulta o estado REAL de cada
 * dependência via `gh`, e aplica/remove a label `dependencia-aberta`
 * (`DEPENDS_ON_BLOCK_LABEL`, `scripts/lib/issue-exec-track.ts`) de acordo —
 * o auto-desarme mecânico que a #7124 não tinha (ver docstring de
 * `issue-depends-on.ts` pro incidente completo).
 *
 * **DRY-RUN por padrão** — este é caminho de ESCRITA em issue do GitHub
 * (`gh issue edit --add-label/--remove-label`). Sem `--apply`, só imprime o
 * relatório do que SERIA feito. `--apply` executa de verdade.
 *
 * Uso:
 *   npx tsx scripts/reconcile-issue-dependencies.ts              # dry-run, backlog inteiro
 *   npx tsx scripts/reconcile-issue-dependencies.ts --apply       # aplica de verdade
 *   npx tsx scripts/reconcile-issue-dependencies.ts --issue 7124  # só uma issue (qualquer modo)
 *
 * Sempre sai com `exit 0` — ferramenta de reconciliação, não gate. Falha de
 * `gh` numa consulta individual de dependência vira estado `"unknown"` pra
 * aquela dependência (nunca aborta a varredura inteira) — ver
 * `decideDependsOnLabelAction` em `issue-depends-on.ts` pro porquê disso
 * nunca resultar em remoção indevida da label.
 *
 * @see scripts/lib/issue-depends-on.ts (lógica pura)
 * @see scripts/lib/issue-exec-track.ts (DEPENDS_ON_BLOCK_LABEL, BLOCKED_LABELS)
 * @see context/overnight-dispatch-rules.md item 24 (onde o coordenador roda isto)
 */

import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { fetchOpenIssuesForTriage, type TriageIssue } from "./lib/issue-triage-fetch.ts";
import { DEFAULT_ISSUE_REPO, isDefaultIssueRepo } from "./lib/issue-repos.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import type { GhRunFn } from "./lib/wait-until-sync.ts";
import { DEPENDS_ON_BLOCK_LABEL } from "./lib/issue-exec-track.ts";
import {
  parseDependsOn,
  assessDependsOn,
  decideDependsOnLabelAction,
  type DependencyState,
} from "./lib/issue-depends-on.ts";

export interface ReconcileReportRow {
  issue: number;
  dependsOn: number[];
  unresolved: number[];
  indeterminate: number[];
  hasLabel: boolean;
  action: "add" | "remove" | "noop";
}

/** Consulta o `state` de uma issue via `gh issue view N --json state`.
 * Nunca lança — falha de rede/`gh`/parse vira `"unknown"`, nunca `"closed"`
 * nem `"open"` por adivinhação (#7137: nunca tratar indeterminado como
 * fechada). */
export function fetchDependencyState(
  issueNumber: number,
  cwd: string,
  ghRun: GhRunFn,
): DependencyState {
  const res = ghRun(["issue", "view", String(issueNumber), "--json", "state"], cwd);
  if (res.status !== 0) return "unknown";
  try {
    const parsed = JSON.parse(res.stdout) as { state?: unknown };
    if (parsed.state === "CLOSED") return "closed";
    if (parsed.state === "OPEN") return "open";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Monta o relatório de reconciliação para um conjunto de issues já
 * buscadas (labels + body) e um mapa de estados de dependência já
 * consultados — pura, sem I/O, pra ser testável sem `gh`. */
export function buildReconcileReport(
  issues: Array<{ number: number; labels: string[]; body: string | null }>,
  dependencyStates: Readonly<Record<number, DependencyState>>,
): ReconcileReportRow[] {
  const rows: ReconcileReportRow[] = [];
  for (const issue of issues) {
    const dependsOn = parseDependsOn(issue.body, issue.number);
    const hasLabel = issue.labels.includes(DEPENDS_ON_BLOCK_LABEL);
    if (dependsOn.length === 0 && !hasLabel) continue; // nada a reportar
    const assessment = assessDependsOn(dependsOn, dependencyStates);
    const action = decideDependsOnLabelAction(assessment, hasLabel);
    rows.push({
      issue: issue.number,
      dependsOn,
      unresolved: assessment.unresolved,
      indeterminate: assessment.indeterminate,
      hasLabel,
      action,
    });
  }
  return rows;
}

function applyAction(
  row: ReconcileReportRow,
  cwd: string,
  ghRun: GhRunFn,
): { ok: boolean; error?: string } {
  if (row.action === "noop") return { ok: true };
  const flag = row.action === "add" ? "--add-label" : "--remove-label";
  const res = ghRun(["issue", "edit", String(row.issue), flag, DEPENDS_ON_BLOCK_LABEL], cwd);
  if (res.status !== 0) {
    return { ok: false, error: res.stderr.trim() || `gh issue edit saiu com status ${res.status ?? "null"}` };
  }
  return { ok: true };
}

function fmtRow(row: ReconcileReportRow): string {
  const dep = row.dependsOn.map((n) => `#${n}`).join(", ");
  const unresolved = row.unresolved.length > 0 ? ` (não-fechadas: ${row.unresolved.map((n) => `#${n}`).join(", ")})` : "";
  const indeterminate = row.indeterminate.length > 0
    ? ` [${row.indeterminate.length} não verificável(is): ${row.indeterminate.map((n) => `#${n}`).join(", ")}]`
    : "";
  return `#${row.issue}: depends-on [${dep}]${unresolved}${indeterminate} — label ${row.hasLabel ? "presente" : "ausente"} → ${row.action}`;
}

/**
 * #10618 (fatia 2) — escopa toda chamada `gh issue ...` desta reconciliação
 * no repo default com `-R vjpixel/diaria-studio`. Sem isso o `gh` resolveria
 * pelo cwd: rodado de um checkout do diaria-design, leria o estado e aplicaria
 * a label `dependencia-aberta` na issue de MESMO número do repo errado.
 * `depends-on: owner/repo#N` (dependência entre repos) fica pra fatia 3.
 */
export function defaultRepoGhRun(base: GhRunFn): GhRunFn {
  return (args, cwd) => base([...args, "-R", DEFAULT_ISSUE_REPO], cwd);
}

export interface ReconcileMainDeps {
  /** Injetável pra teste; default `spawnGhSync`. Sempre embrulhado por
   * `defaultRepoGhRun`. */
  ghRun?: GhRunFn;
  /** Injetável pra teste; default `fetchOpenIssuesForTriage`. */
  fetchIssues?: typeof fetchOpenIssuesForTriage;
  cwd?: string;
}

export async function main(argv: string[], deps: ReconcileMainDeps = {}): Promise<void> {
  const args = parseArgs(argv);
  const apply = args.flags.has("apply");
  const onlyIssue = args.values.issue !== undefined ? Number.parseInt(args.values.issue, 10) : undefined;
  const cwd = deps.cwd ?? process.cwd();
  const ghRun: GhRunFn = defaultRepoGhRun(deps.ghRun ?? spawnGhSync);
  const fetchIssues = deps.fetchIssues ?? fetchOpenIssuesForTriage;

  // #10618: esta reconciliação resolve `depends-on: #N` e aplica label só no
  // repo default. O fetch de triagem já é só do default sem `repos` (opt-in),
  // mas a lista explícita deixa a restrição à prova de mudança de default.
  const fetched = fetchIssues(cwd, { repos: [DEFAULT_ISSUE_REPO] });
  if (fetched.error) {
    console.error(`[reconcile-issue-dependencies] busca de issues falhou: ${fetched.error}`);
    console.error("Nenhuma ação tomada — reconciliação requer o backlog completo pra não desarmar por engano.");
    return;
  }

  // Defesa em profundidade (#10618): só issues do repo default entram.
  let issues: TriageIssue[] = fetched.issues.filter((i) => isDefaultIssueRepo(i.repo));
  if (onlyIssue !== undefined) {
    issues = issues.filter((i) => i.number === onlyIssue);
  }

  // Coleta o universo de números de dependência referenciados por QUALQUER
  // issue da varredura, pra consultar cada um no máximo 1 vez (dedupe).
  const allDeps = new Set<number>();
  for (const issue of issues) {
    for (const n of parseDependsOn(issue.body, issue.number)) allDeps.add(n);
  }

  const states: Record<number, DependencyState> = {};
  for (const n of allDeps) {
    states[n] = fetchDependencyState(n, cwd, ghRun);
  }

  const report = buildReconcileReport(issues, states);

  if (report.length === 0) {
    console.log("[reconcile-issue-dependencies] nenhuma issue com marcador depends-on ou label dependencia-aberta.");
    return;
  }

  console.log(`[reconcile-issue-dependencies] ${apply ? "APLICANDO" : "dry-run (use --apply pra gravar)"}`);
  for (const row of report) {
    console.log(fmtRow(row));
    if (apply && row.action !== "noop") {
      const result = applyAction(row, cwd, ghRun);
      if (!result.ok) {
        console.error(`  falha ao ${row.action === "add" ? "aplicar" : "remover"} label em #${row.issue}: ${result.error}`);
      }
    }
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[reconcile-issue-dependencies] erro inesperado: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
