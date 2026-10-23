/**
 * scripts/lib/open-issues-by-repo.ts (#10901)
 *
 * `gh issue list --state open` em cada repo de uma lista, sempre com
 * `-R owner/name` — o miolo comum das auditorias de backlog que eram
 * só-studio (`check-issue-file-collisions.ts`, `check-dependency-prose-lint.ts`).
 *
 * Mesmo contrato de falha de `fetchOpenIssuesForTriage`
 * (`issue-triage-fetch.ts`): falha do repo default é fatal (`error`, o caller
 * decide o fail-soft dele); falha de repo EXTRA vira `repoErrors` e as issues
 * dele ficam de fora, inteiras — nunca derruba a checagem do studio. Sempre
 * `-R`, inclusive no default: sem ele o `gh` resolveria pelo cwd e, rodado do
 * checkout do diaria-design, rotularia como do studio as issues do outro repo.
 *
 * A lista de repos vem do `--repos` do CLI via `resolveTriageRepos` (`all` ou
 * lista conferida contra `platform.config.json → issue_repos`). Sem
 * `--repos`, só o default — o comportamento de sempre desses scripts.
 */

import { DEFAULT_ISSUE_REPO, isDefaultIssueRepo, normalizeRepoSlug } from "./issue-repos.ts";
import { resolveTriageRepos, triageAllowedRepos } from "./issue-triage-fetch.ts";
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

export interface OpenIssuesByRepoResult<T> {
  /** Cada item carrega `repo` (`owner/name`, minúsculas). */
  issues: Array<T & { repo: string }>;
  /** Falha do repo default — o resto não foi buscado. */
  error?: string;
  /** Falhas de repos extras (os demais seguiram). */
  repoErrors: Array<{ repo: string; error: string }>;
  /** Repos em que o número de itens bateu no `limit` (possível truncamento). */
  truncated: string[];
}

/**
 * `--repos` dos CLIs de auditoria: ausente → `undefined` (só o default, o de
 * sempre); `all` ou lista → `resolveTriageRepos` contra a allowlist. `--repos`
 * sem valor, slug ilegível ou fora da allowlist → `{ error }` (erro de uso,
 * nunca uma varredura menor que a pedida em silêncio).
 */
export function resolveReposCliArg(
  values: Record<string, string | undefined>,
  flags: ReadonlySet<string>,
  allowedRepos: readonly string[] = triageAllowedRepos(),
): { repos: string[] | undefined } | { error: string } {
  if (flags.has("repos") || values.repos === "") return { error: "--repos sem valor (esperado all ou owner/a,owner/b)" };
  if (values.repos === undefined) return { repos: undefined };
  return resolveTriageRepos(values.repos, allowedRepos);
}

/** Ordem de varredura: o default sempre primeiro, sem duplicatas. Slug
 * ilegível → `{ error }` (nunca descartado em silêncio). */
export function orderReposForScan(repos: readonly string[] | undefined): { repos: string[] } | { error: string } {
  const out = [DEFAULT_ISSUE_REPO];
  for (const r of repos ?? []) {
    const slug = normalizeRepoSlug(r);
    if (!slug) return { error: `repo ilegível na lista de varredura: "${r}" (#10901)` };
    if (!out.includes(slug)) out.push(slug);
  }
  return { repos: out };
}

function listOne<T>(repo: string, fields: string, limit: number, cwd: string, ghRun: GhRunFn): { items: T[] } | { error: string } {
  const res = ghRun(["issue", "list", "--state", "open", "--json", fields, "--limit", String(limit), "-R", repo], cwd);
  if (res.status !== 0) {
    const stderr = res.stderr.trim();
    return { error: `gh issue list saiu com status ${res.status ?? "null"}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!res.stdout) return { error: "gh issue list retornou stdout vazio" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return { error: `JSON malformado de gh issue list: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { error: "gh issue list retornou payload que não é um array" };
  return { items: parsed as T[] };
}

/** Lista as issues abertas de cada repo (default primeiro). Nunca lança. */
export function listOpenIssuesByRepo<T>(opts: {
  cwd: string;
  repos?: readonly string[];
  fields: string;
  limit: number;
  ghRun?: GhRunFn;
}): OpenIssuesByRepoResult<T> {
  // 30s, o teto que os dois CLIs já usavam no `spawnSync` deles (listagem
  // com `body` de até 200 issues passa dos 10s default de `spawnGhSync`).
  const ghRun = opts.ghRun ?? ((args: string[], cwd: string) => spawnGhSync(args, cwd, 30_000));
  const ordered = orderReposForScan(opts.repos);
  if ("error" in ordered) return { issues: [], error: ordered.error, repoErrors: [], truncated: [] };
  const issues: Array<T & { repo: string }> = [];
  const repoErrors: Array<{ repo: string; error: string }> = [];
  const truncated: string[] = [];
  for (const repo of ordered.repos) {
    const one = listOne<T>(repo, opts.fields, opts.limit, opts.cwd, ghRun);
    if ("error" in one) {
      if (isDefaultIssueRepo(repo)) return { issues: [], error: one.error, repoErrors: [], truncated: [] };
      repoErrors.push({ repo, error: one.error });
      continue;
    }
    if (one.items.length >= opts.limit) truncated.push(repo);
    for (const item of one.items) issues.push({ ...item, repo });
  }
  return { issues, repoErrors, truncated };
}
