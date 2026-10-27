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
 * as threads numa query FRESCA e decide por ela (não pelo retorno da mutation).
 *
 * Exit:
 *   0 — `--list` ok, ou nenhuma thread bloqueante restou na query fresca
 *   1 — restou thread bloqueante sem falha de infra (ex.: fora de `--thread`)
 *   3 — erro de query/payload, ou alguma resolução falhou (rede, 5xx, timeout,
 *       FORBIDDEN inesperado) e a thread seguiu aberta: é infra, retentar
 *   4 — mais de 100 threads (`hasNextPage: true`): gate automático desativado (#2222/#2232)
 *   5 — uso inválido (flag desconhecida, `--thread` sem valor, `--list` com valor)
 *
 * FORBIDDEN (#2222): só conta como "revisor externo" (não bloqueia, sai em
 * `forbidden` pro coordenador anotar no corpo da PR) quando a própria thread diz
 * `viewerCanResolve: false`. FORBIDDEN com `viewerCanResolve` true ou ausente é
 * falta de permissão do token, não revisor externo: vai pra `failed` (exit 3).
 */
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { DEFAULT_ISSUE_REPO, resolveRepoFlag } from "./lib/issue-repos.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GhRunFn = (args: string[]) => GhSpawnResult;

/** Query das threads: owner/name/pr como variáveis do GraphQL, nunca interpolados. */
export const THREADS_QUERY =
  "query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){ reviewThreads(first:100){ nodes{ id isResolved viewerCanResolve } pageInfo{ hasNextPage endCursor } } } } }";

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
  /** `undefined` quando a resposta não trouxe o campo. */
  viewerCanResolve?: boolean;
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
 * Lê a resposta da query de threads. Qualquer forma inesperada é erro, nunca
 * "0 threads": JSON inválido, `errors[]` não vazio (mesmo com `data`), thread
 * malformada, `hasNextPage` que não seja booleano.
 */
export function parseThreadsResponse(stdout: string): ThreadsParse {
  let parsed: { errors?: unknown; data?: { repository?: { pullRequest?: { reviewThreads?: unknown } } } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "resposta da query de threads não é JSON" };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    return { ok: false, error: `query de threads voltou com errors[]: ${JSON.stringify(parsed.errors).slice(0, 300)}` };
  }
  const rt = parsed?.data?.repository?.pullRequest?.reviewThreads as
    | { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } }
    | undefined;
  if (!rt || !Array.isArray(rt.nodes)) return { ok: false, error: "reviewThreads ausente na resposta" };
  const hasNextPage = rt.pageInfo?.hasNextPage;
  if (typeof hasNextPage !== "boolean") return { ok: false, error: "pageInfo.hasNextPage ausente ou não booleano" };
  const threads: ReviewThread[] = [];
  for (const n of rt.nodes as Array<{ id?: unknown; isResolved?: unknown; viewerCanResolve?: unknown }>) {
    if (typeof n?.id !== "string" || typeof n?.isResolved !== "boolean") {
      return { ok: false, error: "thread malformada na resposta" };
    }
    threads.push({
      id: n.id,
      isResolved: n.isResolved,
      viewerCanResolve: typeof n.viewerCanResolve === "boolean" ? n.viewerCanResolve : undefined,
    });
  }
  return { ok: true, threads, hasNextPage };
}

/**
 * Resultado de uma mutation. `forbidden` vem de `errors[].type == "FORBIDDEN"`,
 * nunca de grep no corpo; qualquer outro `errors[]` não vazio é erro, mesmo com
 * `data` presente.
 */
export function classifyResolveResult(r: GhSpawnResult): { outcome: "resolved" | "forbidden" | "error"; reason: string } {
  let parsed: { errors?: Array<{ type?: string; message?: string }>; data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } } };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { outcome: "error", reason: `gh exit ${r.status}: ${r.stderr.trim() || "resposta não é JSON"}` };
  }
  const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
  if (errors.some((e) => e?.type === "FORBIDDEN")) return { outcome: "forbidden", reason: "FORBIDDEN" };
  if (errors.length > 0) return { outcome: "error", reason: `errors[]: ${errors.map((e) => e?.message ?? e?.type).join("; ")}` };
  if (r.status === 0 && parsed?.data?.resolveReviewThread?.thread?.isResolved === true) return { outcome: "resolved", reason: "" };
  return { outcome: "error", reason: `gh exit ${r.status}: resposta sem thread resolvida` };
}

export interface FailedResolve {
  id: string;
  status: number | null;
  reason: string;
}

export interface ResolveReport {
  exitCode: number;
  resolved: string[];
  /** FORBIDDEN de revisor externo (`viewerCanResolve: false`): não bloqueia. */
  forbidden: string[];
  failed: FailedResolve[];
  /** Não-resolvidas e não-FORBIDDEN-externas na query fresca pós-loop. */
  remainingBlocking: number;
  error?: string;
}

function fetchThreads(repo: string, pr: number, ghRun: GhRunFn): ThreadsParse {
  const r = ghRun(buildThreadsQueryArgs(repo, pr));
  // `gh api graphql` sai 1 quando há `errors` mesmo com JSON no stdout: o parse decide.
  const p = parseThreadsResponse(r.stdout);
  if (!p.ok && r.status !== 0) return { ok: false, error: `${p.error} (gh exit ${r.status}: ${r.stderr.trim()})` };
  if (p.ok && r.status !== 0) return { ok: false, error: `gh exit ${r.status}: ${r.stderr.trim()}` };
  return p;
}

export function resolveReviewThreads(
  repo: string,
  pr: number,
  ghRun: GhRunFn,
  only: ReadonlySet<string> | null = null,
): ResolveReport {
  const report: ResolveReport = { exitCode: EXIT_OK, resolved: [], forbidden: [], failed: [], remainingBlocking: 0 };
  const before = fetchThreads(repo, pr, ghRun);
  if (!before.ok) return { ...report, exitCode: EXIT_ERROR, error: before.error };
  if (before.hasNextPage) return { ...report, exitCode: EXIT_PAGINATION, error: "mais de 100 review threads" };

  for (const t of before.threads) {
    if (t.isResolved || (only && !only.has(t.id))) continue;
    const r = ghRun(buildResolveArgs(t.id));
    const { outcome, reason } = classifyResolveResult(r);
    if (outcome === "resolved") report.resolved.push(t.id);
    else if (outcome === "forbidden" && t.viewerCanResolve === false) report.forbidden.push(t.id);
    else {
      const why = outcome === "forbidden" ? `FORBIDDEN com viewerCanResolve=${t.viewerCanResolve} (permissão do token, não revisor externo)` : reason;
      report.failed.push({ id: t.id, status: r.status, reason: why });
    }
  }

  const after = fetchThreads(repo, pr, ghRun);
  if (!after.ok) return { ...report, exitCode: EXIT_ERROR, error: `query pós-loop: ${after.error}` };
  if (after.hasNextPage) return { ...report, exitCode: EXIT_PAGINATION, error: "mais de 100 review threads (pós-loop)" };
  const externalForbidden = new Set(report.forbidden);
  const open = after.threads.filter((t) => !t.isResolved && !externalForbidden.has(t.id));
  report.remainingBlocking = open.length;
  if (open.length === 0) return { ...report, exitCode: EXIT_OK };
  const failedIds = new Set(report.failed.map((f) => f.id));
  if (open.some((t) => failedIds.has(t.id))) {
    return { ...report, exitCode: EXIT_ERROR, error: "resolução falhou e a thread segue aberta (infra: retentar)" };
  }
  return { ...report, exitCode: EXIT_BLOCKING };
}

const CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_KEYS = new Set(["pr", "repo", "list", "thread"]);

export function usage(): string {
  return "uso: npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name] [--list | --thread ID,ID]";
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * CLI testável. Validação local de flags (o `parseArgs` compartilhado aceita
 * qualquer chave e trata `--x` sem valor como flag): flag desconhecida,
 * `--thread` sem valor/vazio e `--list` com valor são erro de uso, para nunca
 * mudar de modo em silêncio.
 */
export function runCli(argv: string[], ghRun: GhRunFn, configRoot: string = CONFIG_ROOT): CliResult {
  const usageErr = (msg: string): CliResult => ({ exitCode: EXIT_USAGE, stdout: "", stderr: `[resolve-review-threads] ${msg}\n${usage()}` });
  const { values, flags, positional } = parseArgs(argv);
  if (positional.length > 0) return usageErr(`argumento solto: ${positional.join(" ")}`);
  for (const k of [...Object.keys(values), ...flags]) if (!KNOWN_KEYS.has(k)) return usageErr(`flag desconhecida: --${k}`);
  if ("list" in values) return usageErr("--list não leva valor");
  if (flags.has("thread")) return usageErr("--thread sem valor");
  if (flags.has("pr")) return usageErr("--pr sem valor");
  const pr = Number(values.pr);
  if (!/^\d+$/.test(values.pr ?? "") || pr <= 0) return usageErr("--pr é obrigatório (inteiro positivo)");
  const repoFlag = resolveRepoFlag(values, flags, configRoot);
  if ("error" in repoFlag) return usageErr(repoFlag.error);
  const repo = repoFlag.repo ?? DEFAULT_ISSUE_REPO;

  let only: Set<string> | null = null;
  if ("thread" in values) {
    const ids = (values.thread ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return usageErr("--thread vazio");
    only = new Set(ids);
  }
  if (flags.has("list") && only) return usageErr("--list e --thread são exclusivos");

  if (flags.has("list")) {
    const p = fetchThreads(repo, pr, ghRun);
    if (!p.ok) return { exitCode: EXIT_ERROR, stdout: "", stderr: `[resolve-review-threads] ${p.error}` };
    const unresolved = p.threads.filter((t) => !t.isResolved).map((t) => t.id);
    return {
      exitCode: p.hasNextPage ? EXIT_PAGINATION : EXIT_OK,
      stdout: JSON.stringify({ repo, pr, total: p.threads.length, unresolved, hasNextPage: p.hasNextPage }),
      stderr: "",
    };
  }

  const report = resolveReviewThreads(repo, pr, ghRun, only);
  return {
    exitCode: report.exitCode,
    stdout: JSON.stringify({ repo, pr, ...report }),
    stderr: report.error ? `[resolve-review-threads] ${report.error}` : "",
  };
}

if (isMainModule(import.meta.url)) {
  const r = runCli(process.argv.slice(2), (args) => spawnGhSync(args, process.cwd(), 30_000));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exitCode = r.exitCode;
}
