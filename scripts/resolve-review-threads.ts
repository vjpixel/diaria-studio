#!/usr/bin/env -S npx tsx
/**
 * scripts/resolve-review-threads.ts (#11235)
 *
 * Lista e resolve as review threads de uma PR, e nada além disso. Substitui os
 * blocos `gh api graphql ...` à mão do merge gate do overnight (SKILL.md, Fase 1
 * "Resolução das review threads"; `context/overnight-dispatch-rules.md` item 11).
 *
 * Por que um helper: o overnight agendado roda em `acceptEdits` e só executa o
 * Bash que casa `permissions.allow`. Uma regra `Bash(gh api graphql *)` liberaria
 * qualquer mutation (deleteRef, closePullRequest, updatePullRequest...), e o
 * guard #5716 só barra as de merge. Este script fica coberto pela regra
 * pré-existente `Bash(npx tsx scripts/*.ts *)` e só fala duas operações
 * GraphQL fixas: a query `reviewThreads` e a mutation `resolveReviewThread`.
 *
 * Uso:
 *   npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name] --list
 *   npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name] [--thread ID,ID]
 *
 * Sem `--list`, resolve as não-resolvidas (todas, ou só as de `--thread`), relê
 * as threads numa query FRESCA e imprime um JSON com o resultado.
 *
 * Exit:
 *   0 — `--list` ok, ou nenhuma thread bloqueante (não-resolvida e não-FORBIDDEN) restou
 *   1 — restou thread bloqueante
 *   3 — erro de comando/payload (nunca vira "0 threads")
 *   4 — mais de 100 threads (`hasNextPage`): gate automático desativado (#2222/#2232)
 *   5 — uso inválido
 *
 * FORBIDDEN (#2222): thread de revisor externo que o overnight não pode
 * resolver. Não conta como bloqueante; sai listada em `forbidden` para o
 * coordenador anotar no corpo da PR.
 */
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { DEFAULT_ISSUE_REPO, resolveRepoFlag } from "./lib/issue-repos.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GhRunFn = (args: string[]) => GhSpawnResult;

/** Query das threads: owner/name/pr como variáveis do GraphQL, nunca interpolados. */
export const THREADS_QUERY =
  "query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){ reviewThreads(first:100){ nodes{ id isResolved } pageInfo{ hasNextPage endCursor } } } } }";

/** Única mutation que o script emite. */
export const RESOLVE_MUTATION =
  "mutation($tid: ID!) { resolveReviewThread(input:{threadId:$tid}){ thread{ id isResolved } } }";

export const EXIT_OK = 0;
export const EXIT_BLOCKING = 1;
export const EXIT_ERROR = 3;
export const EXIT_PAGINATION = 4;
export const EXIT_USAGE = 5;

export interface ReviewThread {
  id: string;
  isResolved: boolean;
}

export type ThreadsParse =
  | { ok: true; threads: ReviewThread[]; hasNextPage: boolean }
  | { ok: false; error: string };

export function buildThreadsQueryArgs(repo: string, pr: number): string[] {
  const [owner, name] = repo.split("/");
  return ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `pr=${pr}`, "-f", `query=${THREADS_QUERY}`];
}

export function buildResolveArgs(threadId: string): string[] {
  return ["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `tid=${threadId}`];
}

/**
 * Lê a resposta da query de threads. Qualquer forma inesperada é erro — nunca
 * "0 threads" (o mesmo guard do bloco shell que este script substitui).
 * `hasNextPage` diferente de `false` (inclusive ausente) conta como próxima página.
 */
export function parseThreadsResponse(stdout: string): ThreadsParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "resposta da query de threads não é JSON" };
  }
  const rt = (parsed as { data?: { repository?: { pullRequest?: { reviewThreads?: unknown } } } })?.data?.repository
    ?.pullRequest?.reviewThreads as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } | undefined;
  if (!rt || !Array.isArray(rt.nodes)) return { ok: false, error: "reviewThreads ausente na resposta" };
  const threads: ReviewThread[] = [];
  for (const n of rt.nodes as Array<{ id?: unknown; isResolved?: unknown }>) {
    if (typeof n?.id !== "string" || typeof n?.isResolved !== "boolean") {
      return { ok: false, error: "thread malformada na resposta" };
    }
    threads.push({ id: n.id, isResolved: n.isResolved });
  }
  return { ok: true, threads, hasNextPage: rt.pageInfo?.hasNextPage !== false };
}

/** `forbidden` vem de `errors[].type == "FORBIDDEN"`, nunca de grep no corpo. */
export function classifyResolveResult(r: GhSpawnResult): "resolved" | "forbidden" | "error" {
  let parsed: { errors?: Array<{ type?: string }>; data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } } };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return "error";
  }
  if ((parsed.errors ?? []).some((e) => e?.type === "FORBIDDEN")) return "forbidden";
  if (r.status === 0 && parsed.data?.resolveReviewThread?.thread?.isResolved === true) return "resolved";
  return "error";
}

export interface ResolveReport {
  exitCode: number;
  resolved: string[];
  forbidden: string[];
  failed: string[];
  /** Não-resolvidas e não-FORBIDDEN na query fresca pós-loop. */
  remainingBlocking: number;
  error?: string;
}

function fetchThreads(repo: string, pr: number, ghRun: GhRunFn): ThreadsParse {
  const r = ghRun(buildThreadsQueryArgs(repo, pr));
  // `gh api graphql` sai 1 quando há `errors` mesmo com JSON no stdout: o parse decide.
  const p = parseThreadsResponse(r.stdout);
  if (!p.ok && r.status !== 0) return { ok: false, error: `${p.error} (gh exit ${r.status}: ${r.stderr.trim()})` };
  return p;
}

export function resolveReviewThreads(
  repo: string,
  pr: number,
  ghRun: GhRunFn,
  only: ReadonlySet<string> | null = null,
): ResolveReport {
  const base = { resolved: [] as string[], forbidden: [] as string[], failed: [] as string[], remainingBlocking: 0 };
  const before = fetchThreads(repo, pr, ghRun);
  if (!before.ok) return { ...base, exitCode: EXIT_ERROR, error: before.error };
  if (before.hasNextPage) return { ...base, exitCode: EXIT_PAGINATION, error: "mais de 100 review threads" };

  for (const t of before.threads) {
    if (t.isResolved || (only && !only.has(t.id))) continue;
    const outcome = classifyResolveResult(ghRun(buildResolveArgs(t.id)));
    if (outcome === "resolved") base.resolved.push(t.id);
    else if (outcome === "forbidden") base.forbidden.push(t.id);
    else base.failed.push(t.id);
  }

  const after = fetchThreads(repo, pr, ghRun);
  if (!after.ok) return { ...base, exitCode: EXIT_ERROR, error: `query pós-loop: ${after.error}` };
  if (after.hasNextPage) return { ...base, exitCode: EXIT_PAGINATION, error: "mais de 100 review threads (pós-loop)" };
  const forbidden = new Set(base.forbidden);
  base.remainingBlocking = after.threads.filter((t) => !t.isResolved && !forbidden.has(t.id)).length;
  return { ...base, exitCode: base.remainingBlocking === 0 ? EXIT_OK : EXIT_BLOCKING };
}

const CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(): string {
  return "uso: npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name] [--list | --thread ID,ID]";
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const pr = Number(values.pr);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(`[resolve-review-threads] --pr é obrigatório (inteiro positivo).\n${usage()}`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const repoFlag = resolveRepoFlag(values, flags, CONFIG_ROOT);
  if ("error" in repoFlag) {
    console.error(`[resolve-review-threads] ${repoFlag.error}\n${usage()}`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  const repo = repoFlag.repo ?? DEFAULT_ISSUE_REPO;
  const ghRun: GhRunFn = (args) => spawnGhSync(args, process.cwd(), 30_000);

  if (flags.has("list")) {
    const p = fetchThreads(repo, pr, ghRun);
    if (!p.ok) {
      console.error(`[resolve-review-threads] ${p.error}`);
      process.exitCode = EXIT_ERROR;
      return;
    }
    const unresolved = p.threads.filter((t) => !t.isResolved).map((t) => t.id);
    console.log(JSON.stringify({ repo, pr, total: p.threads.length, unresolved, hasNextPage: p.hasNextPage }));
    process.exitCode = p.hasNextPage ? EXIT_PAGINATION : EXIT_OK;
    return;
  }

  const only = values.thread ? new Set(values.thread.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const report = resolveReviewThreads(repo, pr, ghRun, only);
  console.log(JSON.stringify({ repo, pr, ...report }));
  if (report.error) console.error(`[resolve-review-threads] ${report.error}`);
  process.exitCode = report.exitCode;
}

if (isMainModule(import.meta.url)) main();
