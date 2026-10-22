#!/usr/bin/env npx tsx
/**
 * scripts/check-issue-duplicate-preflight.ts (#7020)
 *
 * CLI fino do preflight de duplicidade do coordenador — ver
 * `scripts/lib/issue-duplicate-preflight.ts` para a lógica pura e o
 * racional completo. Roda ANTES do dispatch de uma issue (Fase 0/entre
 * ondas), não substitui o preflight do subagente (item 14 do
 * `context/overnight-dispatch-rules.md`), que continua como rede.
 *
 * Uso:
 *   npx tsx scripts/check-issue-duplicate-preflight.ts --issue 6875
 *   npx tsx scripts/check-issue-duplicate-preflight.ts --issue 6875 --updated-at 2026-08-20T10:00:00Z
 *
 * Saída (stdout): JSON `DuplicatePreflightResult` (ver módulo pra shape).
 * Exit codes:
 *   0 — "not-in-master": sem indício de duplicidade, dispatch normal.
 *   1 — "closes-should-be-closed" ou "refs-declared-residue": achado em
 *       master, coordenador precisa decidir closeout vs escopo reduzido
 *       antes de dispatchar.
 *   2 — falha de fetch (git ausente, uso incorreto).
 *
 * @see scripts/lib/issue-duplicate-preflight.ts
 * @see scripts/lib/master-commit-fetch.ts
 */
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { assessDuplicatePreflight } from "./lib/issue-duplicate-preflight.ts";
import {
  fetchMasterCommitsForIssue,
  fetchMasterCommitsForProvenance,
  fetchRepoCommitsForIssue,
  type CommitFetchRunner,
} from "./lib/master-commit-fetch.ts";
import { formatIssueRef, legacyIssueNumber, loadIssueRepos, parseIssueRef } from "./lib/issue-repos.ts";

/**
 * `--issue` aceita `N` (diaria-studio, `origin/master` local, como sempre) ou
 * `owner/repo#N` (#10618, fatia 4): issue de outro repo da allowlist
 * `issue_repos` é checada contra a branch default DAQUELE repo, via `gh api`
 * (`fetchRepoCommitsForIssue`). `runner` só é usado nesse caminho (teste).
 */
export function main(argv: string[], cwd: string, runner?: CommitFetchRunner): number {
  const { values } = parseArgs(argv);
  const issueRaw = values.issue;
  if (!issueRaw) {
    console.error("[check-issue-duplicate-preflight] uso: --issue N [--updated-at ISO8601]");
    return 2;
  }
  const ref = parseIssueRef(String(issueRaw));
  if (!ref) {
    console.error(`[check-issue-duplicate-preflight] --issue inválido: ${issueRaw} (esperado N ou owner/repo#N)`);
    return 2;
  }
  const studioNumber = legacyIssueNumber(ref);
  const issueNumber = ref.number;
  const foreignRef = studioNumber === null ? formatIssueRef(ref) : null;
  if (foreignRef !== null && !loadIssueRepos(cwd).includes(ref.repo)) {
    console.error(`[check-issue-duplicate-preflight] ${foreignRef}: repo fora de issue_repos, não consultado`);
    return 2;
  }

  const fetchResult =
    foreignRef === null
      ? fetchMasterCommitsForIssue(cwd, issueNumber)
      : fetchRepoCommitsForIssue(cwd, ref.repo, issueNumber, runner);
  if (fetchResult.error) {
    console.error(`[check-issue-duplicate-preflight] ${fetchResult.error}`);
    return 2;
  }
  // #10901: busca incompleta mas não bloqueante — segue como "sem indício".
  if (fetchResult.warning) console.error(`[check-issue-duplicate-preflight] aviso: ${fetchResult.warning}`);

  // Preflight de PROVENIÊNCIA (#7801) — quando o fix pode estar sob outro número.
  const provenanceRaw = values.provenance ? String(values.provenance) : "";
  const provenanceVals = provenanceRaw ? provenanceRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const provenanceCommits: import("./lib/issue-duplicate-preflight.ts").MasterCommitInfo[] = [];
  // Proveniência busca no `origin/master` do studio: não se aplica a issue de outro repo.
  for (const p of foreignRef === null ? provenanceVals : []) {
    const pr = fetchMasterCommitsForProvenance(cwd, String(p));
    if (!pr.error) provenanceCommits.push(...pr.commits);
  }
  // Dedup por SHA (mesmo commit pode aparecer em #N e em provenance).
  const shaSeen = new Set<string>();
  const provenanceUnique = provenanceCommits.filter((c) => { if (shaSeen.has(c.sha)) return false; shaSeen.add(c.sha); return true; });

  const result = assessDuplicatePreflight({
    issueNumber,
    issueUpdatedAt: values["updated-at"] ?? null,
    commits: fetchResult.commits,
    provenanceCommits: provenanceUnique,
  });

  console.log(JSON.stringify(foreignRef === null ? result : { ...result, ref: foreignRef }, null, 2));
  return result.verdict === "not-in-master" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
