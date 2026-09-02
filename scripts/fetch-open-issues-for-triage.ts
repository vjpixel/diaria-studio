#!/usr/bin/env npx tsx
/**
 * scripts/fetch-open-issues-for-triage.ts (#7018 item 2)
 *
 * CLI fino sobre `scripts/lib/issue-triage-fetch.ts` — ponto de entrada
 * único que a Fase 0 do overnight/develop (e o passo de classificação
 * inicial do continuo) roda em vez de montar `gh issue list --json ...` à
 * mão em prosa. Imprime a lista de issues já classificada (`execTrack`
 * incluso) como JSON em stdout; erro de fetch (transporte, `gh`
 * indisponível, `--json` sem `body`) vai pro stderr com exit != 0.
 *
 * Uso:
 *   npx tsx scripts/fetch-open-issues-for-triage.ts
 *   npx tsx scripts/fetch-open-issues-for-triage.ts --bugs
 *   npx tsx scripts/fetch-open-issues-for-triage.ts --priority P0,P1
 *
 * Saída (stdout, sucesso): array JSON de `TriageIssue` (ver
 * `scripts/lib/issue-triage-fetch.ts`).
 * Exit codes: 0 = ok; 1 = falha de fetch/classificação (mensagem em stderr).
 *
 * @see scripts/lib/issue-triage-fetch.ts
 */
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { fetchOpenIssuesForTriage, type TriageIssue } from "./lib/issue-triage-fetch.ts";

function filterByFlags(issues: TriageIssue[], bugsOnly: boolean, priorityFilter: string[] | null): TriageIssue[] {
  return issues.filter((issue) => {
    if (bugsOnly && !issue.labels.includes("bug")) return false;
    if (priorityFilter && !issue.labels.some((l) => priorityFilter.includes(l))) return false;
    return true;
  });
}

export function main(argv: string[], cwd: string): number {
  const { flags, values } = parseArgs(argv);
  const bugsOnly = flags.has("bugs");
  const priorityFilter = values.priority ? values.priority.split(",").map((s) => s.trim()).filter(Boolean) : null;

  let result;
  try {
    result = fetchOpenIssuesForTriage(cwd);
  } catch (e) {
    console.error(`[fetch-open-issues-for-triage] ${(e as Error).message}`);
    return 1;
  }
  if (result.error) {
    console.error(`[fetch-open-issues-for-triage] ${result.error}`);
    return 1;
  }
  const issues = filterByFlags(result.issues, bugsOnly, priorityFilter);
  console.log(JSON.stringify(issues, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
