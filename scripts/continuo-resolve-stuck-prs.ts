#!/usr/bin/env npx tsx
/**
 * scripts/continuo-resolve-stuck-prs.ts (#8767)
 *
 * I/O do resolvedor de PRs `continuo/*` travadas — decisão pura em
 * `scripts/lib/continuo-stuck-pr.ts` (`decideStuckPrAction`, leia a
 * docstring de lá pro porquê e pra ordem de precedência). Chamado por
 * `hermes/scripts/continuo-pr-review.sh` antes do laço de review.
 *
 * Uso:
 *   npx tsx scripts/continuo-resolve-stuck-prs.ts            # decide + age
 *   npx tsx scripts/continuo-resolve-stuck-prs.ts --dry-run  # só imprime o plano
 *
 * Saída: 1 linha JSON em stdout `{ "checked": N, "actions": [{pr, kind, ok}] }`.
 * `checked: -1` = `gh pr list` falhou (fail-soft: nada feito). Logs em stderr.
 *
 * Toda leitura que falha vira "desconhecido" (`null`), e a lógica pura trata
 * desconhecido como "não age" — nunca fecha PR por falha de rede.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import type { CiVerdict } from "./lib/continuo-ci-fixer-eligibility.ts";
import { latestCommitDate, type PrCommitEntry } from "./lib/stale-red-pr-alarm.ts";
import {
  buildCloseComment,
  buildIssueRequeueComment,
  countRejectReviews,
  decideStuckPrAction,
  extractLinkedIssues,
  UPDATE_BRANCH_MARKER,
  type StuckPrAction,
  type StuckPrInput,
} from "./lib/continuo-stuck-pr.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = "[continuo-resolve-stuck-prs]";
const GH_TIMEOUT_MS = 30_000;

interface PrListRaw {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  isDraft: boolean;
  mergeable: string | null;
  labels: { name: string }[];
}

function gh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnGhSync(args, ROOT, GH_TIMEOUT_MS);
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

function ghJson<T>(args: string[]): T | null {
  const r = gh(args);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

/** Mesmo mapeamento exit code → verdict de `check-continuo-ci-fixer-candidate.ts`. */
const VERDICT_BY_EXIT_CODE: Record<number, CiVerdict> = {
  0: "pass",
  1: "fail",
  2: "pending",
  3: "error",
  4: "blocked_by_conflict",
  5: "claude_binary_error",
  6: "gh_incompatible_flags",
};

function fetchCiVerdict(pr: number): CiVerdict {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-pr-checks-gate.ts", "--pr", String(pr)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  return r.status === null ? "error" : (VERDICT_BY_EXIT_CODE[r.status] ?? "error");
}

function fetchIssueState(n: number): "OPEN" | "CLOSED" | null {
  const r = ghJson<{ state: string }>(["issue", "view", String(n), "--json", "state"]);
  if (!r) return null;
  return r.state === "CLOSED" ? "CLOSED" : "OPEN";
}

function gatherInput(pr: PrListRaw): StuckPrInput | null {
  const linked: { number: number; state: "OPEN" | "CLOSED" }[] = [];
  for (const n of extractLinkedIssues(pr.title, pr.body ?? "")) {
    const state = fetchIssueState(n);
    if (state === null) return null; // estado desconhecido de issue → não decide nada nesta PR
    linked.push({ number: n, state });
  }

  const view = ghJson<{ comments?: { body: string }[]; commits?: PrCommitEntry[] }>([
    "pr",
    "view",
    String(pr.number),
    "--json",
    "comments,commits",
  ]);
  const comments = view?.comments?.map((c) => c.body) ?? null;
  const last = view?.commits ? latestCommitDate(view.commits) : null;
  const hoursSinceLastCommit = last ? (Date.now() - Date.parse(last)) / 3_600_000 : null;

  // Pelo NOME da branch, não pelo SHA: `headRefOid` não existe no `gh` 2.46
  // do 300 (#6923).
  const behind = gh(["api", `repos/{owner}/{repo}/compare/master...${pr.headRefName}`, "--jq", ".behind_by"]);
  const behindParsed = behind.ok ? Number(behind.stdout.trim()) : NaN;

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    headRefName: pr.headRefName,
    isDraft: pr.isDraft,
    labels: pr.labels.map((l) => l.name),
    mergeable: pr.mergeable,
    ciVerdict: fetchCiVerdict(pr.number),
    linkedIssues: linked,
    // comentários desconhecidos → 0 rejects/sem marcador: os dois caem no
    // lado conservador (não fecha por reject-cap; update-branch é 1x e
    // reversível).
    rejectCount: comments ? countRejectReviews(comments) : 0,
    updateBranchDone: comments ? comments.some((b) => b.includes(UPDATE_BRANCH_MARKER)) : true,
    behindBy: Number.isFinite(behindParsed) ? behindParsed : null,
    hoursSinceLastCommit,
  };
}

function apply(pr: StuckPrInput, action: StuckPrAction): boolean {
  if (action.kind === "update_branch") {
    const r = gh(["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr.number}/update-branch`]);
    if (!r.ok) {
      console.error(`${LOG} PR #${pr.number}: update-branch falhou: ${r.stderr.trim()}`);
      return false;
    }
    gh([
      "pr",
      "comment",
      String(pr.number),
      "--body",
      `Resolvedor de PRs travadas (#8767): CI vermelho com a branch ${action.behindBy} commit(s) atrás do master — master trazido pra branch (update-branch) pra descartar falha do base. Feito 1x por PR; se o CI seguir vermelho, a PR é fechada no próximo ciclo parado.\n\n${UPDATE_BRANCH_MARKER}`,
    ]);
    return true;
  }
  if (action.kind === "skip") return true;

  const r = gh(["pr", "close", String(pr.number), "--comment", buildCloseComment(action, pr)]);
  if (!r.ok) {
    console.error(`${LOG} PR #${pr.number}: gh pr close falhou: ${r.stderr.trim()}`);
    return false;
  }
  if (action.kind !== "close_superseded") {
    for (const i of pr.linkedIssues.filter((x) => x.state === "OPEN")) {
      gh(["issue", "comment", String(i.number), "--body", buildIssueRequeueComment(pr.number, action)]);
    }
  }
  return true;
}

function main(): void {
  const dryRun = hasFlag(process.argv.slice(2), "dry-run");
  const prs = ghJson<PrListRaw[]>([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,body,headRefName,isDraft,mergeable,labels",
  ]);
  if (prs === null) {
    console.error(`${LOG} gh pr list falhou — nada feito nesta rodada`);
    console.log(JSON.stringify({ checked: -1, actions: [] }));
    return;
  }

  const actions: { pr: number; kind: string; ok: boolean }[] = [];
  for (const raw of prs.filter((p) => p.headRefName.startsWith("continuo/"))) {
    const input = gatherInput(raw);
    if (!input) {
      console.error(`${LOG} PR #${raw.number}: leitura incompleta — pulando`);
      continue;
    }
    const action = decideStuckPrAction(input);
    if (action.kind === "skip") {
      console.error(`${LOG} PR #${raw.number}: skip (${action.reason})`);
      continue;
    }
    console.error(`${LOG} PR #${raw.number}: ${action.kind}${dryRun ? " (dry-run)" : ""}`);
    actions.push({ pr: raw.number, kind: action.kind, ok: dryRun ? true : apply(input, action) });
  }
  console.log(JSON.stringify({ checked: prs.length, actions }));
}

if (isMainModule(import.meta.url)) main();
