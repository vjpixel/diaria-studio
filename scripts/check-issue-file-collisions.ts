#!/usr/bin/env npx tsx
/**
 * scripts/check-issue-file-collisions.ts (#7137, item 3)
 *
 * "Versão de tempo-de-plano" de `session-registry.ts conflicts --paths`
 * (que responde "quem mais está mexendo nisto AGORA" pra sessões em voo):
 * este script varre as issues ABERTAS do backlog, extrai os paths de
 * arquivo que cada uma já lista no corpo (convenção do #7112 — issues-
 * filhas listam caminhos concretos na seção "Escopo"), e reporta pares que
 * colidiriam se ambas fossem implementadas em paralelo. Lógica pura em
 * `scripts/lib/issue-file-collisions.ts`.
 *
 * **DERIVA, não DECLARA** (item 3 da #7137) — ninguém precisa marcar
 * manualmente "issue A colide com issue B"; a colisão sai do texto que a
 * issue já tem. Declaração apodrece (#7137 mediu isso 2x só nesta issue:
 * "10 entradas DECLARADA, NÃO ARMADA" viraram prosa vencida, e a própria
 * #7137 original errou 2 afirmações por falta de acesso ao servidor);
 * derivação, não.
 *
 * É RELATÓRIO — nunca bloqueia (`exit 0` sempre, mesmo com colisões
 * encontradas ou `gh` indisponível). **Fail-soft por desenho, não o #738**:
 * o #738 é sobre halt-banner + parada explícita quando um MCP cai no MEIO de
 * um stage do pipeline (o oposto de silencioso); aqui o `gh` indisponível é
 * um sinal fraco de auditoria opcional, então o comportamento correto é o
 * inverso — logar e seguir sem alarme, mesmo padrão de
 * `check-dependency-prose-lint.ts` (#7137 item 4). A decisão de serializar
 * ou fundir 2 issues em 1 PR (mesma família do `#4319` no `/diaria-develop`)
 * é de quem despacha o trabalho, não deste script.
 *
 * Uso:
 *   npx tsx scripts/check-issue-file-collisions.ts
 *   npx tsx scripts/check-issue-file-collisions.ts --json
 *   npx tsx scripts/check-issue-file-collisions.ts --limit 300
 *   npx tsx scripts/check-issue-file-collisions.ts --repos all   # #10901: todos de issue_repos
 *
 * **Multi-repo (#10901).** Sem `--repos`, só o `vjpixel/diaria-studio` (o de
 * sempre, agora com `-R` explícito — rodado do checkout do diaria-design, o
 * `gh` sem `-R` listava as issues do outro repo como se fossem do studio).
 * `--repos all`/lista varre também os repos de `platform.config.json →
 * issue_repos`. Colisão só é computada DENTRO de um mesmo repo: o mesmo path
 * em dois repos é outro arquivo. Repo extra que falha fica de fora com aviso.
 *
 * @see scripts/lib/issue-file-collisions.ts (lógica pura + racional completo)
 * @see scripts/lib/session-registry.ts (`findSessionConflicts` — irmão em tempo-de-execução)
 */

import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  extractFilePathsFromIssueBody,
  computeIssueFileCollisions,
  type IssueFileCollision,
  type IssueWithPaths,
} from "./lib/issue-file-collisions.ts";
import { listOpenIssuesByRepo, resolveReposCliArg, type GhRunFn } from "./lib/open-issues-by-repo.ts";
import { labelInRepo } from "./lib/plan-issue-ref.ts";

interface GhIssueListItem {
  number: number;
  title?: string;
  body?: string;
}

const DEFAULT_ISSUE_LIMIT = 200;
const LOG_PREFIX = "[check-issue-file-collisions]";

/** Colisão + repo (#10901). Os dois lados são sempre do MESMO repo. */
export interface RepoIssueFileCollision extends IssueFileCollision {
  repo: string;
}

/** Colisões por repo — nunca cruza repos (mesmo path, outro arquivo). Pura. */
export function computeCollisionsByRepo(
  issues: ReadonlyArray<{ repo: string; number: number; title?: string; body?: string | null }>,
): { issuesChecked: number; collisions: RepoIssueFileCollision[] } {
  const byRepo = new Map<string, IssueWithPaths[]>();
  for (const i of issues) {
    const list = byRepo.get(i.repo) ?? [];
    list.push({ number: i.number, title: i.title, paths: extractFilePathsFromIssueBody(i.body) });
    byRepo.set(i.repo, list);
  }
  const collisions: RepoIssueFileCollision[] = [];
  for (const [repo, list] of byRepo) {
    for (const c of computeIssueFileCollisions(list)) collisions.push({ repo, ...c });
  }
  return { issuesChecked: issues.length, collisions };
}

export interface CollisionsMainDeps {
  ghRun?: GhRunFn;
  cwd?: string;
  /** Allowlist de `--repos` — injetável pra teste; default `issue_repos`. */
  allowedRepos?: readonly string[];
  log?: (line: string) => void;
  err?: (line: string) => void;
}

/** Devolve o exit code: 0 sempre (relatório), 2 só em uso inválido de `--repos`. */
export function main(argv: string[], deps: CollisionsMainDeps = {}): number {
  const log = deps.log ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const { values, flags } = parseArgs(argv);
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_ISSUE_LIMIT;
  const asJson = flags.has("json");
  const resolved = resolveReposCliArg(values, flags, deps.allowedRepos);
  if ("error" in resolved) {
    err(`${LOG_PREFIX} ${resolved.error}`);
    return 2;
  }

  const fetched = listOpenIssuesByRepo<GhIssueListItem>({
    cwd: deps.cwd ?? process.cwd(),
    repos: resolved.repos,
    fields: "number,title,body",
    limit,
    ghRun: deps.ghRun,
  });
  if (fetched.error) {
    err(`${LOG_PREFIX} gh indisponível — pulando checagem (fail-soft por desenho, não #738): ${fetched.error}`);
    return 0;
  }
  for (const r of fetched.repoErrors) {
    err(`${LOG_PREFIX} AVISO: ${r.repo} não respondeu — issues desse repo FORA desta checagem: ${r.error}`);
  }
  for (const repo of fetched.truncated) {
    err(
      `${LOG_PREFIX} AVISO: ${repo}: issue(s) retornada(s) == --limit (${limit}) — ` +
        `possível truncamento silencioso do backlog real. Rode com --limit maior pra confirmar cobertura total.`,
    );
  }

  const { issuesChecked, collisions } = computeCollisionsByRepo(fetched.issues);

  if (asJson) {
    log(JSON.stringify({ issues_checked: issuesChecked, collisions }, null, 2));
    return 0;
  }
  log(`${LOG_PREFIX} ${issuesChecked} issue(s) aberta(s) verificada(s), ${collisions.length} colisão(ões) de arquivo encontrada(s).`);
  for (const c of collisions) {
    log(
      `${LOG_PREFIX} ${labelInRepo(c.repo, c.a.number)} × ${labelInRepo(c.repo, c.b.number)} — ` +
        `${c.paths.length} path(s) em comum: ${c.paths.join(", ")}`,
    );
  }
  if (collisions.length > 0) {
    log(
      `${LOG_PREFIX} decisão de serializar/fundir é de quem despacha (ex: worktrees concorrentes de ` +
        `/diaria-develop, #4319) — este script só reporta, nunca bloqueia.`,
    );
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
