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
import { fetchMasterCommitsForIssue } from "./lib/master-commit-fetch.ts";

export function main(argv: string[], cwd: string): number {
  const { values } = parseArgs(argv);
  const issueRaw = values.issue;
  if (!issueRaw) {
    console.error("[check-issue-duplicate-preflight] uso: --issue N [--updated-at ISO8601]");
    return 2;
  }
  const issueNumber = Number(issueRaw);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    console.error(`[check-issue-duplicate-preflight] --issue inválido: ${issueRaw}`);
    return 2;
  }

  const fetchResult = fetchMasterCommitsForIssue(cwd, issueNumber);
  if (fetchResult.error) {
    console.error(`[check-issue-duplicate-preflight] ${fetchResult.error}`);
    return 2;
  }

  const result = assessDuplicatePreflight({
    issueNumber,
    issueUpdatedAt: values["updated-at"] ?? null,
    commits: fetchResult.commits,
  });

  console.log(JSON.stringify(result, null, 2));
  return result.verdict === "not-in-master" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
