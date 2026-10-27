#!/usr/bin/env -S npx tsx
/**
 * scripts/gh-pr-review-api.ts (#11235)
 *
 * As poucas chamadas REST ao GitHub que o fluxo das rodadas autônomas faz à
 * mão, cada uma com método e endpoint fixos:
 *
 *   comment  — comentário inline numa PR (self-review, item 7 das regras de dispatch)
 *              POST repos/{repo}/pulls/{pr}/comments
 *   reply    — resposta a um comentário inline (dev-fixer recusando um finding)
 *              POST repos/{repo}/pulls/{pr}/comments/{id}/replies
 *   head-sha — SHA do head da PR
 *              GET  repos/{repo}/pulls/{pr}
 *   ref-sha  — SHA de uma branch (base do merge gate, `validated_base_sha`)
 *              GET  repos/{repo}/git/ref/heads/{branch}
 *
 * Por que um helper: o overnight agendado roda em `acceptEdits` e só executa o
 * Bash que casa `permissions.allow`. Uma regra `Bash(gh api repos/...*)` deixa o
 * `*` atravessar espaço e casar `-X DELETE`/`-X PATCH` em qualquer endpoint.
 * Este script fica coberto pela regra pré-existente `Bash(npx tsx scripts/*.ts *)`
 * e valida cada argumento antes de montar a chamada.
 *
 * Uso:
 *   npx tsx scripts/gh-pr-review-api.ts comment  --pr N --path P --line L --body-file F [--commit SHA] [--side RIGHT|LEFT] [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts reply    --pr N --comment-id ID --body-file F [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts head-sha --pr N [--repo owner/name]
 *   npx tsx scripts/gh-pr-review-api.ts ref-sha  --branch master [--repo owner/name]
 *
 * Sem `--commit`, o comentário inline vai no head atual da PR.
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
  | { kind: "head-sha"; repo: string; pr: number }
  | { kind: "ref-sha"; repo: string; branch: string };

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
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
      if (!SHA_RE.test(op.commit)) return `commit inválido: ${op.commit}`;
      if (op.body.trim() === "") return "corpo vazio";
      return null;
    case "reply":
      if (!Number.isInteger(op.commentId) || op.commentId <= 0) return "--comment-id precisa ser inteiro positivo";
      if (op.body.trim() === "") return "corpo vazio";
      return null;
    case "head-sha":
      return null;
    case "ref-sha":
      return BRANCH_RE.test(op.branch) ? null : `--branch inválido: ${op.branch}`;
  }
}

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
    case "head-sha":
      return ["api", "-X", "GET", `${base}/pulls/${op.pr}`, "--jq", ".head.sha"];
    case "ref-sha":
      return ["api", "-X", "GET", `${base}/git/ref/heads/${op.branch}`, "--jq", ".object.sha"];
  }
}

export type GhRunFn = (args: string[]) => GhSpawnResult;

/** Roda a operação; `stdout` aparado em sucesso, erro com o stderr do `gh` em falha. */
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
  if (out === "" || out === "null") return { ok: false, error: "resposta sem o campo esperado" };
  if ((op.kind === "head-sha" || op.kind === "ref-sha") && !SHA_RE.test(out)) return { ok: false, error: `SHA inesperado: ${out}` };
  return { ok: true, out };
}

const CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(): string {
  return [
    "uso:",
    "  npx tsx scripts/gh-pr-review-api.ts comment  --pr N --path P --line L --body-file F [--commit SHA] [--side RIGHT|LEFT] [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts reply    --pr N --comment-id ID --body-file F [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts head-sha --pr N [--repo owner/name]",
    "  npx tsx scripts/gh-pr-review-api.ts ref-sha  --branch master [--repo owner/name]",
  ].join("\n");
}

function fail(msg: string, code = 1): void {
  console.error(`[gh-pr-review-api] ${msg}\n${usage()}`);
  process.exitCode = code;
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const { values, flags } = parseArgs(argv.slice(1));
  const repoFlag = resolveRepoFlag(values, flags, CONFIG_ROOT);
  if ("error" in repoFlag) return fail(repoFlag.error, 2);
  const repo = repoFlag.repo ?? DEFAULT_ISSUE_REPO;
  const ghRun: GhRunFn = (args) => spawnGhSync(args, process.cwd(), 30_000);
  const pr = Number(values.pr);
  const readBody = (): string | null => {
    if (!values["body-file"]) return null;
    try {
      return readFileSync(values["body-file"], "utf8");
    } catch (e) {
      fail(`não li --body-file: ${(e as Error).message}`, 2);
      return null;
    }
  };

  let op: ReviewApiOp;
  switch (sub) {
    case "comment": {
      const body = readBody();
      if (body === null) return process.exitCode ? undefined : fail("--body-file é obrigatório", 2);
      let commit = values.commit;
      if (!commit) {
        const head = runOp({ kind: "head-sha", repo, pr }, ghRun);
        if (!head.ok) return fail(`head da PR: ${head.error}`);
        commit = head.out;
      }
      const side = values.side === "LEFT" ? "LEFT" : "RIGHT";
      op = { kind: "comment", repo, pr, path: values.path ?? "", line: Number(values.line), side, commit, body };
      break;
    }
    case "reply": {
      const body = readBody();
      if (body === null) return process.exitCode ? undefined : fail("--body-file é obrigatório", 2);
      op = { kind: "reply", repo, pr, commentId: Number(values["comment-id"]), body };
      break;
    }
    case "head-sha":
      op = { kind: "head-sha", repo, pr };
      break;
    case "ref-sha":
      op = { kind: "ref-sha", repo, branch: values.branch ?? "" };
      break;
    default:
      return fail(`subcomando desconhecido: ${sub ?? "(nenhum)"}`, 2);
  }
  const r = runOp(op, ghRun);
  if (!r.ok) return fail(r.error);
  console.log(r.out);
}

if (isMainModule(import.meta.url)) main();
