#!/usr/bin/env npx tsx
/**
 * scripts/check-branch-issue-consistency.ts (#6804)
 *
 * CLI do gate de rastreabilidade branch↔commit do `hermes-diaria-continuo`
 * — ver `scripts/lib/branch-issue-consistency.ts` pra lógica pura/docs
 * completas. Este arquivo só busca `headRefName`+`commits` via `gh pr view`,
 * trata falha de comando como INCONCLUSIVO (nunca "sem dado, logo
 * consistente"), e imprime o veredito.
 *
 * Uso:
 *   npx tsx scripts/check-branch-issue-consistency.ts --pr 6782
 *
 * Exit codes:
 *   0 = consistent  (branch não-numerada, OU issue do nome está nos commits)
 *   1 = mismatch    (issue do nome NUNCA aparece em nenhum commit — o bug
 *       severo da #6804, ex: continuo/fix-6043-onboarding sem nenhum commit
 *       #6043)
 *   2 = error       (gh falhou, PR inexistente, JSON malformado)
 *   3 = uso inválido (--pr ausente/não-numérico)
 *
 * @see scripts/lib/branch-issue-consistency.ts
 * @see hermes/skills/hermes-diaria-continuo/SKILL.md (§4, passo 3)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { checkBranchIssueConsistency, type BranchIssueConsistencyResult } from "./lib/branch-issue-consistency.ts";

interface Outcome {
  readonly verdict: "consistent" | "mismatch" | "error";
  readonly result?: BranchIssueConsistencyResult;
  readonly branchName?: string;
  readonly reason?: string;
}

interface PrCommitsPayload {
  headRefName?: string;
  commits?: Array<{ messageHeadline?: string; messageBody?: string }>;
}

function fetchPrBranchAndCommits(prNumber: number, cwd: string): Outcome {
  const r = spawnSync("gh", ["pr", "view", String(prNumber), "--json", "headRefName,commits"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) return { verdict: "error", reason: `gh não pôde ser executado: ${r.error.message}` };
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").toString().trim();
    return { verdict: "error", reason: `gh pr view saiu com status ${r.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!r.stdout) return { verdict: "error", reason: "gh pr view retornou stdout vazio" };

  let parsed: PrCommitsPayload;
  try {
    parsed = JSON.parse(r.stdout) as PrCommitsPayload;
  } catch (e) {
    return { verdict: "error", reason: `JSON malformado de gh pr view: ${(e as Error).message}` };
  }

  const branchName = parsed.headRefName;
  if (!branchName) return { verdict: "error", reason: "gh pr view não retornou headRefName" };

  const messages = (parsed.commits ?? []).map((c) => `${c.messageHeadline ?? ""}\n${c.messageBody ?? ""}`);
  const result = checkBranchIssueConsistency(branchName, messages);
  return { verdict: result.consistent ? "consistent" : "mismatch", result, branchName };
}

const EXIT_CODES: Record<Outcome["verdict"], number> = { consistent: 0, mismatch: 1, error: 2 };

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const prRaw = values.pr;
  const prNumber = prRaw ? Number(prRaw) : NaN;
  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[check-branch-issue-consistency] uso: --pr N");
    process.exit(3);
  }

  const outcome = fetchPrBranchAndCommits(prNumber, process.cwd());
  const prefix = `[check-branch-issue-consistency] PR #${prNumber} (branch ${outcome.branchName ?? "?"}): verdict=${outcome.verdict}`;

  if (outcome.verdict === "error") {
    console.error(`${prefix} — ${outcome.reason}`);
  } else if (outcome.verdict === "mismatch") {
    console.error(
      `${prefix} — nome referencia #${outcome.result?.branchIssue}, mas nenhum commit da branch menciona essa issue (commits mencionam: ${outcome.result?.commitIssues.join(", ") || "nenhuma issue"})`,
    );
  } else {
    console.log(`${prefix} — ok`);
  }

  process.exit(EXIT_CODES[outcome.verdict]);
}
