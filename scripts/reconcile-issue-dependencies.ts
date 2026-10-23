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
 *   npx tsx scripts/reconcile-issue-dependencies.ts --apply --repos all   # #10901: todos de issue_repos
 *   npx tsx scripts/reconcile-issue-dependencies.ts --issue vjpixel/diaria-design#21
 *
 * **Multi-repo (#10901).** Sem `--repos`, só o `vjpixel/diaria-studio` — o
 * comportamento de sempre. `--repos all`/lista reconcilia também as issues
 * dos repos de `platform.config.json → issue_repos`, cada repo à parte: o
 * `depends-on: #N` de uma issue do diaria-design é o #N DO DESIGN (número
 * relativo ao repo da issue, como em todo o GitHub), consultado e rotulado
 * com `-R` daquele repo. Dependência ENTRE repos (`owner/repo#N` no
 * marcador) não é sintaxe aceita pelo marcador — fica fora deste script.
 * Repo extra que falha na listagem fica de fora com aviso; o studio segue.
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
import { DEFAULT_ISSUE_REPO, isDefaultIssueRepo, parseIssueRef } from "./lib/issue-repos.ts";
import { resolveReposCliArg } from "./lib/open-issues-by-repo.ts";
import { labelInRepo } from "./lib/plan-issue-ref.ts";
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
  /** #10901 — repo da issue (e das dependências dela, que são do mesmo repo). */
  repo: string;
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
  repo: string = DEFAULT_ISSUE_REPO,
): ReconcileReportRow[] {
  const rows: ReconcileReportRow[] = [];
  for (const issue of issues) {
    const dependsOn = parseDependsOn(issue.body, issue.number);
    const hasLabel = issue.labels.includes(DEPENDS_ON_BLOCK_LABEL);
    if (dependsOn.length === 0 && !hasLabel) continue; // nada a reportar
    const assessment = assessDependsOn(dependsOn, dependencyStates);
    const action = decideDependsOnLabelAction(assessment, hasLabel);
    rows.push({
      repo,
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
  const lbl = (n: number) => labelInRepo(row.repo, n);
  const dep = row.dependsOn.map(lbl).join(", ");
  const unresolved = row.unresolved.length > 0 ? ` (não-fechadas: ${row.unresolved.map(lbl).join(", ")})` : "";
  const indeterminate = row.indeterminate.length > 0
    ? ` [${row.indeterminate.length} não verificável(is): ${row.indeterminate.map(lbl).join(", ")}]`
    : "";
  return `${lbl(row.issue)}: depends-on [${dep}]${unresolved}${indeterminate} — label ${row.hasLabel ? "presente" : "ausente"} → ${row.action}`;
}

/**
 * #10618 (fatia 2) — escopa toda chamada `gh issue ...` desta reconciliação
 * no repo default com `-R vjpixel/diaria-studio`. Sem isso o `gh` resolveria
 * pelo cwd: rodado de um checkout do diaria-design, leria o estado e aplicaria
 * a label `dependencia-aberta` na issue de MESMO número do repo errado.
 * `depends-on: owner/repo#N` (dependência entre repos) fica fora (#10901).
 */
export function defaultRepoGhRun(base: GhRunFn): GhRunFn {
  return repoGhRun(base, DEFAULT_ISSUE_REPO);
}

/** #10901 — o mesmo escopo `-R`, pra qualquer repo da varredura. */
export function repoGhRun(base: GhRunFn, repo: string): GhRunFn {
  return (args, cwd) => base([...args, "-R", repo], cwd);
}

export interface ReconcileMainDeps {
  /** Injetável pra teste; default `spawnGhSync`. Sempre embrulhado por
   * `repoGhRun` (o `-R` do repo da issue). */
  ghRun?: GhRunFn;
  /** Allowlist de `--repos`/`--issue owner/repo#N` — injetável pra teste;
   * default `platform.config.json → issue_repos`. */
  allowedRepos?: readonly string[];
  /** Injetável pra teste; default `fetchOpenIssuesForTriage`. */
  fetchIssues?: typeof fetchOpenIssuesForTriage;
  cwd?: string;
}

export async function main(argv: string[], deps: ReconcileMainDeps = {}): Promise<void> {
  const args = parseArgs(argv);
  const apply = args.flags.has("apply");
  const cwd = deps.cwd ?? process.cwd();
  const baseGhRun: GhRunFn = deps.ghRun ?? spawnGhSync;
  const fetchIssues = deps.fetchIssues ?? fetchOpenIssuesForTriage;

  // #10901: `--repos` opt-in (sem ele, só o default — comportamento de sempre).
  const resolved = resolveReposCliArg(args.values, args.flags, deps.allowedRepos);
  if ("error" in resolved) {
    console.error(`[reconcile-issue-dependencies] ${resolved.error}`);
    process.exitCode = 2;
    return;
  }
  // `--issue N` é do studio (legado); `--issue owner/repo#N` mira a issue
  // daquele repo, que precisa estar na allowlist e entra na varredura.
  let onlyIssue: { repo: string; number: number } | undefined;
  if (args.values.issue !== undefined) {
    const ref = parseIssueRef(args.values.issue);
    if (!ref) {
      console.error(`[reconcile-issue-dependencies] --issue inválido: "${args.values.issue}" (esperado N ou owner/repo#N)`);
      process.exitCode = 2;
      return;
    }
    onlyIssue = ref;
  }
  let repos: string[] = resolved.repos ?? [DEFAULT_ISSUE_REPO];
  if (onlyIssue && !isDefaultIssueRepo(onlyIssue.repo) && !repos.includes(onlyIssue.repo)) {
    const viaAllowlist = resolveReposCliArg({ repos: onlyIssue.repo }, new Set(), deps.allowedRepos);
    if ("error" in viaAllowlist) {
      console.error(`[reconcile-issue-dependencies] --issue ${args.values.issue}: ${viaAllowlist.error}`);
      process.exitCode = 2;
      return;
    }
    repos = [...repos, onlyIssue.repo];
  }

  // #10618: a lista explícita (só o default sem `--repos`) deixa a restrição
  // à prova de mudança do default do fetch de triagem.
  const fetched = fetchIssues(cwd, { repos });
  if (fetched.error) {
    console.error(`[reconcile-issue-dependencies] busca de issues falhou: ${fetched.error}`);
    console.error("Nenhuma ação tomada — reconciliação requer o backlog completo pra não desarmar por engano.");
    return;
  }
  for (const r of fetched.repoErrors ?? []) {
    console.error(`[reconcile-issue-dependencies] AVISO: ${r.repo} não respondeu — issues desse repo NÃO reconciliadas: ${r.error}`);
  }

  // Defesa em profundidade (#10618): só issues dos repos pedidos entram.
  let issues: TriageIssue[] = fetched.issues.filter((i) => repos.includes(i.repo));
  if (onlyIssue !== undefined) {
    const target = onlyIssue;
    issues = issues.filter((i) => i.repo === target.repo && i.number === target.number);
  }

  // Cada repo à parte (#10901): o `#N` de um marcador é do repo da issue.
  const report: ReconcileReportRow[] = [];
  for (const repo of repos) {
    const repoIssues = issues.filter((i) => i.repo === repo);
    if (repoIssues.length === 0) continue;
    const ghRun = repoGhRun(baseGhRun, repo);
    // Universo de dependências do repo, consultando cada uma no máximo 1 vez.
    const allDeps = new Set<number>();
    for (const issue of repoIssues) {
      for (const n of parseDependsOn(issue.body, issue.number)) allDeps.add(n);
    }
    const states: Record<number, DependencyState> = {};
    for (const n of allDeps) {
      states[n] = fetchDependencyState(n, cwd, ghRun);
    }
    report.push(...buildReconcileReport(repoIssues, states, repo));
  }

  if (report.length === 0) {
    console.log("[reconcile-issue-dependencies] nenhuma issue com marcador depends-on ou label dependencia-aberta.");
    return;
  }

  console.log(`[reconcile-issue-dependencies] ${apply ? "APLICANDO" : "dry-run (use --apply pra gravar)"}`);
  for (const row of report) {
    console.log(fmtRow(row));
    if (apply && row.action !== "noop") {
      const result = applyAction(row, cwd, repoGhRun(baseGhRun, row.repo));
      if (!result.ok) {
        console.error(`  falha ao ${row.action === "add" ? "aplicar" : "remover"} label em ${labelInRepo(row.repo, row.issue)}: ${result.error}`);
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
