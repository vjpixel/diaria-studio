#!/usr/bin/env -S npx tsx
/**
 * scripts/gh-pr-review-api.ts (#11235)
 *
 * As poucas chamadas REST ao GitHub que o fluxo das rodadas autônomas faz à
 * mão, cada uma com método e endpoint fixos:
 *
 *   comment       — comentário inline numa PR (self-review, item 7 das regras de dispatch)
 *                   POST repos/{repo}/pulls/{pr}/comments
 *   reply         — resposta a um comentário inline (dev-fixer recusando um finding)
 *                   POST repos/{repo}/pulls/{pr}/comments/{id}/replies
 *   list-comments — comentários inline da PR, paginado (dev-fixer lendo os findings;
 *                   `gh pr view --json comments` não traz os inline)
 *                   GET  repos/{repo}/pulls/{pr}/comments
 *   head-sha      — SHA do head da PR
 *                   GET  repos/{repo}/pulls/{pr}
 *   ref-sha       — SHA de uma branch (base do merge gate, `validated_base_sha`)
 *                   GET  repos/{repo}/git/ref/heads/{branch}
 *
 * Por que um helper: o overnight agendado roda em `acceptEdits` e só executa o
 * Bash que casa `permissions.allow`. Uma regra `Bash(gh api repos/...*)` deixa o
 * `*` atravessar espaço e casar `-X DELETE`/`-X PATCH` em qualquer endpoint.
 * Este script fica coberto pela regra pré-existente `Bash(npx tsx scripts/*.ts *)`
 * e valida cada argumento antes de montar a chamada.
 *
 * Uso:
 *   npx tsx scripts/gh-pr-review-api.ts comment       --pr N --path P --line L --body-file F [--commit SHA40] [--side RIGHT|LEFT] [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts reply         --pr N --comment-id ID --body-file F [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts list-comments --pr N [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts head-sha      --pr N [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts ref-sha       --branch master [--repo owner/name]
 *
 * Sem `--commit`, o comentário inline vai no head atual da PR. `list-comments`
 * imprime um array JSON com `id`, `path`, `line`, `body`, `author_association`
 * e `user` — filtrar `author_association` (OWNER/MEMBER/COLLABORATOR) é do
 * chamador (item 30 das regras de dispatch).
 *
 * Exit:
 *   0 — ok (stdout: URL do comentário, SHA, ou o array JSON)
 *   1 — o `gh` falhou ou devolveu algo fora do esperado
 *   2 — uso inválido (subcomando/flag desconhecida, argumento inválido, --body-file ilegível)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { DEFAULT_ISSUE_REPO, resolveRepoFlag } from "./lib/issue-repos.ts";

export type ReviewApiOp =
  | { kind: "comment"; repo: string; pr: number; path: string; line: number; side: "RIGHT" | "LEFT"; commit: string; body: string }
  | { kind: "reply"; repo: string; pr: number; commentId: number; body: string }
  | { kind: "list-comments"; repo: string; pr: number }
  | { kind: "head-sha"; repo: string; pr: number }
  | { kind: "ref-sha"; repo: string; branch: string };

export const EXIT_OK = 0;
export const EXIT_GH = 1;
export const EXIT_USAGE = 2;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
/** Nome de branch git sem espaço, sem `..`, sem começar por `-` ou `/`. */
const BRANCH_RE = /^(?![-/])(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Valida a operação; devolve a mensagem de erro, ou `null` se ok. */
export function validateOp(op: ReviewApiOp): string | null {
  if (!REPO_RE.test(op.repo)) return `repo inválido: ${op.repo}`;
  if ("pr" in op && (!Number.isInteger(op.pr) || op.pr <= 0)) return "--pr precisa ser inteiro positivo";
  switch (op.kind) {
    case "comment":
      if (!op.path || op.path.startsWith("-") || op.path.startsWith("/") || op.path.includes("..")) return `--path inválido: ${op.path}`;
      if (!Number.isInteger(op.line) || op.line <= 0) return "--line precisa ser inteiro positivo";
      if (op.side !== "RIGHT" && op.side !== "LEFT") return `--side inválido: ${op.side}`;
      if (!SHA40_RE.test(op.commit)) return `commit inválido (SHA de 40 caracteres): ${op.commit}`;
      if (op.body.trim() === "") return "corpo vazio";
      return null;
    case "reply":
      if (!Number.isInteger(op.commentId) || op.commentId <= 0) return "--comment-id precisa ser inteiro positivo";
      if (op.body.trim() === "") return "corpo vazio";
      return null;
    case "list-comments":
    case "head-sha":
      return null;
    case "ref-sha":
      return BRANCH_RE.test(op.branch) ? null : `--branch inválido: ${op.branch}`;
  }
}

/** jq do `list-comments`: um objeto por linha (NDJSON), um por comentário de todas as páginas. */
export const LIST_COMMENTS_JQ = ".[] | {id, path, line, body, author_association, user: .user.login}";

/** Argumentos do `gh` para a operação (método explícito em todas). */
export function buildGhApiArgs(op: ReviewApiOp): string[] {
  const err = validateOp(op);
  if (err) throw new Error(err);
  const base = `repos/${op.repo}`;
  switch (op.kind) {
    case "comment":
      return [
        "api", "-X", "POST", `${base}/pulls/${op.pr}/comments`,
        "-f", `body=${op.body}`, "-f", `commit_id=${op.commit}`, "-f", `path=${op.path}`,
        "-F", `line=${op.line}`, "-f", `side=${op.side}`, "--jq", ".html_url",
      ];
    case "reply":
      return ["api", "-X", "POST", `${base}/pulls/${op.pr}/comments/${op.commentId}/replies`, "-f", `body=${op.body}`, "--jq", ".html_url"];
    case "list-comments":
      return ["api", "-X", "GET", "--paginate", `${base}/pulls/${op.pr}/comments`, "--jq", LIST_COMMENTS_JQ];
    case "head-sha":
      return ["api", "-X", "GET", `${base}/pulls/${op.pr}`, "--jq", ".head.sha"];
    case "ref-sha":
      return ["api", "-X", "GET", `${base}/git/ref/heads/${op.branch}`, "--jq", ".object.sha"];
  }
}

export type GhRunFn = (args: string[]) => GhSpawnResult;

/** Roda a operação; stdout normalizado em sucesso, erro com o stderr do `gh` em falha. */
export function runOp(op: ReviewApiOp, ghRun: GhRunFn): { ok: true; out: string } | { ok: false; error: string } {
  let args: string[];
  try {
    args = buildGhApiArgs(op);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const r = ghRun(args);
  const out = r.stdout.trim();
  if (r.status !== 0) return { ok: false, error: `gh exit ${r.status}: ${r.stderr.trim()}` };
  if (op.kind === "list-comments") {
    const items: unknown[] = [];
    for (const line of out.split("\n").filter((l) => l.trim() !== "")) {
      try {
        items.push(JSON.parse(line));
      } catch {
        return { ok: false, error: `linha de comentário não é JSON: ${line.slice(0, 120)}` };
      }
    }
    return { ok: true, out: JSON.stringify(items) };
  }
  if (out === "" || out === "null") return { ok: false, error: "resposta sem o campo esperado" };
  if ((op.kind === "head-sha" || op.kind === "ref-sha") && !SHA40_RE.test(out)) return { ok: false, error: `SHA inesperado: ${out}` };
  return { ok: true, out };
}

const CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function usage(): string {
  return [
    "uso:",
    "  npx tsx scripts/gh-pr-review-api.ts comment       --pr N --path P --line L --body-file F [--commit SHA40] [--side RIGHT|LEFT] [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts reply         --pr N --comment-id ID --body-file F [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts list-comments --pr N [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts head-sha      --pr N [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts ref-sha       --branch master [--repo owner/name]",
  ].join("\n");
}

const ALLOWED_KEYS: Record<string, readonly string[]> = {
  comment: ["pr", "path", "line", "body-file", "commit", "side", "repo"],
  reply: ["pr", "comment-id", "body-file", "repo"],
  "list-comments": ["pr", "repo"],
  "head-sha": ["pr", "repo"],
  "ref-sha": ["branch", "repo"],
};

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReadFileFn = (path: string) => string;

/** CLI testável: `argv` sem o `node script`, `ghRun`/`readFile` injetáveis. */
export function runCli(
  argv: string[],
  ghRun: GhRunFn,
  readFile: ReadFileFn = (p) => readFileSync(p, "utf8"),
  configRoot: string = CONFIG_ROOT,
): CliResult {
  const fail = (msg: string, code: number): CliResult => ({ exitCode: code, stdout: "", stderr: `[gh-pr-review-api] ${msg}\n${usage()}` });
  const sub = argv[0] ?? "";
  const allowed = ALLOWED_KEYS[sub];
  if (!allowed) return fail(`subcomando desconhecido: ${sub || "(nenhum)"}`, EXIT_USAGE);
  const { values, flags, positional } = parseArgs(argv.slice(1));
  if (positional.length > 0) return fail(`argumento solto: ${positional.join(" ")}`, EXIT_USAGE);
  for (const k of flags) if (k !== "repo") return fail(`--${k} sem valor ou desconhecida`, EXIT_USAGE);
  for (const k of Object.keys(values)) if (!allowed.includes(k)) return fail(`flag desconhecida para ${sub}: --${k}`, EXIT_USAGE);
  const repoFlag = resolveRepoFlag(values, flags, configRoot);
  if ("error" in repoFlag) return fail(repoFlag.error, EXIT_USAGE);
  const repo = repoFlag.repo ?? DEFAULT_ISSUE_REPO;
  const pr = /^\d+$/.test(values.pr ?? "") ? Number(values.pr) : NaN;
  const readBody = (): { body: string } | { error: string } => {
    if (!values["body-file"]) return { error: "--body-file é obrigatório" };
    try {
      return { body: readFile(values["body-file"]) };
    } catch (e) {
      return { error: `não li --body-file: ${(e as Error).message}` };
    }
  };

  let op: ReviewApiOp;
  switch (sub) {
    case "comment": {
      const b = readBody();
      if ("error" in b) return fail(b.error, EXIT_USAGE);
      const side = values.side ?? "RIGHT";
      if (side !== "RIGHT" && side !== "LEFT") return fail(`--side inválido: ${side} (RIGHT ou LEFT)`, EXIT_USAGE);
      if (values.commit !== undefined && !SHA40_RE.test(values.commit)) return fail(`--commit precisa ser SHA de 40 caracteres: ${values.commit}`, EXIT_USAGE);
      let commit = values.commit;
      if (!commit) {
        if (!Number.isInteger(pr) || pr <= 0) return fail("--pr precisa ser inteiro positivo", EXIT_USAGE);
        const head = runOp({ kind: "head-sha", repo, pr }, ghRun);
        if (!head.ok) return fail(`head da PR: ${head.error}`, EXIT_GH);
        commit = head.out;
      }
      op = { kind: "comment", repo, pr, path: values.path ?? "", line: /^\d+$/.test(values.line ?? "") ? Number(values.line) : NaN, side, commit, body: b.body };
      break;
    }
    case "reply": {
      const b = readBody();
      if ("error" in b) return fail(b.error, EXIT_USAGE);
      const cid = values["comment-id"] ?? "";
      op = { kind: "reply", repo, pr, commentId: /^\d+$/.test(cid) ? Number(cid) : NaN, body: b.body };
      break;
    }
    case "list-comments":
      op = { kind: "list-comments", repo, pr };
      break;
    case "head-sha":
      op = { kind: "head-sha", repo, pr };
      break;
    default:
      op = { kind: "ref-sha", repo, branch: values.branch ?? "" };
  }
  const invalid = validateOp(op);
  if (invalid) return fail(invalid, EXIT_USAGE);
  const r = runOp(op, ghRun);
  if (!r.ok) return fail(r.error, EXIT_GH);
  return { exitCode: EXIT_OK, stdout: r.out, stderr: "" };
}

if (isMainModule(import.meta.url)) {
  const r = runCli(process.argv.slice(2), (args) => spawnGhSync(args, process.cwd(), 60_000));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exitCode = r.exitCode;
}
