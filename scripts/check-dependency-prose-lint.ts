#!/usr/bin/env npx tsx
/**
 * check-dependency-prose-lint.ts (#7137 item 4)
 *
 * CLI de AUDITORIA (nunca gate — ver docstring de
 * `scripts/lib/dependency-prose-lint.ts` pro porquê) sobre o backlog
 * aberto: reporta issues que citam prosa de dependência ("pré-requisito",
 * "depende do #N", "depois que #N", "só depois") sem carregar o marcador
 * `<!-- depends-on: #N -->` (`scripts/lib/issue-depends-on.ts`).
 *
 * Sempre sai com `exit 0` — nunca bloqueia a rodada (a correção de um
 * achado exige julgamento humano sobre qual issue é a dependência real, ou
 * se é falso positivo; ver a lib pro racional completo). `gh` indisponível
 * → fail-soft (#738): warning em stderr, `exit 0`.
 *
 * Uso:
 *   npx tsx scripts/check-dependency-prose-lint.ts
 *   npx tsx scripts/check-dependency-prose-lint.ts --limit 100
 *   npx tsx scripts/check-dependency-prose-lint.ts --repos all   # #10901: todos de issue_repos
 *
 * **Multi-repo (#10901).** Sem `--repos`, só o `vjpixel/diaria-studio` (com
 * `-R` explícito). `--repos all`/lista varre também os repos de
 * `platform.config.json → issue_repos`; o achado de outro repo sai como
 * `owner/repo#N`. Repo extra que falha fica de fora com aviso no stderr.
 *
 * @see scripts/lib/dependency-prose-lint.ts (lógica pura + racional completo)
 * @see scripts/lib/issue-depends-on.ts (marcador que este lint cobra a ausência de)
 * @see context/overnight-dispatch-rules.md item 26 (onde o coordenador roda isto)
 */

import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { detectDependencyProseWithoutMarker, type DependencyProseFinding } from "./lib/dependency-prose-lint.ts";
import { listOpenIssuesByRepo, resolveReposCliArg, type GhRunFn } from "./lib/open-issues-by-repo.ts";
import { labelInRepo } from "./lib/plan-issue-ref.ts";

interface GhIssueListItem {
  number: number;
  body?: string;
}

const DEFAULT_ISSUE_LIMIT = 200;

/** Achado + repo (#10901). */
export interface RepoDependencyProseFinding extends DependencyProseFinding {
  repo: string;
}

/** Roda o lint repo a repo (o número só identifica a issue dentro do repo). Pura. */
export function detectByRepo(
  issues: ReadonlyArray<{ repo: string; number: number; body?: string | null }>,
): RepoDependencyProseFinding[] {
  const repos = [...new Set(issues.map((i) => i.repo))];
  const out: RepoDependencyProseFinding[] = [];
  for (const repo of repos) {
    const mine = issues.filter((i) => i.repo === repo).map((i) => ({ number: i.number, body: i.body ?? null }));
    for (const f of detectDependencyProseWithoutMarker(mine)) out.push({ repo, ...f });
  }
  return out;
}

function fmtFinding(f: RepoDependencyProseFinding): string {
  return `${labelInRepo(f.repo, f.issueNumber)}\t${f.patternId}\t${f.description}\t${f.excerpt}`;
}

export interface ProseLintMainDeps {
  ghRun?: GhRunFn;
  cwd?: string;
  /** Allowlist de `--repos` — injetável pra teste; default `issue_repos`. */
  allowedRepos?: readonly string[];
  log?: (line: string) => void;
  err?: (line: string) => void;
}

/** Devolve o exit code: 0 sempre (auditoria), 2 só em uso inválido de `--repos`. */
export function main(argv: string[], deps: ProseLintMainDeps = {}): number {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const { values, flags } = parseArgs(argv);
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_ISSUE_LIMIT;
  const resolved = resolveReposCliArg(values, flags, deps.allowedRepos);
  if ("error" in resolved) {
    err(`[check-dependency-prose-lint] ${resolved.error}`);
    return 2;
  }

  const fetched = listOpenIssuesByRepo<GhIssueListItem>({
    cwd: deps.cwd ?? process.cwd(),
    repos: resolved.repos,
    fields: "number,body",
    limit,
    ghRun: deps.ghRun,
  });
  if (fetched.error) {
    err(`[check-dependency-prose-lint] gh indisponível — pulando checagem (fail-soft, #738): ${fetched.error}`);
    return 0;
  }
  for (const r of fetched.repoErrors) {
    err(`[check-dependency-prose-lint] AVISO: ${r.repo} não respondeu — issues desse repo FORA desta checagem: ${r.error}`);
  }

  const findings = detectByRepo(fetched.issues);

  if (findings.length === 0) {
    log("ok — nenhuma issue aberta cita prosa de dependência sem marcador depends-on:");
    return 0;
  }

  log(
    `check-dependency-prose-lint: ${findings.length} issue(s) citam prosa de dependência sem marcador depends-on: (auditoria, não bloqueia).`,
  );
  log("");
  log("issue\tpadrão\tdescrição\ttrecho");
  for (const f of findings) log(fmtFinding(f));
  log("");
  log(
    "Se for dependência genuína, adicionar `<!-- depends-on: #N -->` no corpo (scripts/reconcile-issue-dependencies.ts assume dali em diante). Se for falso positivo, ignorar.",
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
