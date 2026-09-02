#!/usr/bin/env npx tsx
/**
 * scripts/fetch-open-issues-for-triage.ts (#7018 itens 2 e 3)
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
 *   npx tsx scripts/fetch-open-issues-for-triage.ts --since 2026-08-29T10:00:00Z
 *
 * `--since {ISO 8601}` (item 3, exclusivo do `/diaria-continuo` — ver
 * SKILL.md § Loop invariável passo 2): restringe a varredura ao delta desde
 * aquele instante (`gh issue list --search "updated:>={since}"`) em vez do
 * backlog aberto inteiro. A garantia fail-closed (`body` ausente → exit 1)
 * vale idêntica nos dois modos — `--since` reduz quantas issues voltam,
 * nunca quais campos cada uma carrega.
 *
 * Saída (stdout, sucesso): array JSON de `TriageIssue` (ver
 * `scripts/lib/issue-triage-fetch.ts`).
 * Exit codes: 0 = ok; 1 = falha de fetch/classificação (mensagem em stderr).
 *
 * @see scripts/lib/issue-triage-fetch.ts
 */
import { parseArgs, isMainModule, getStringArg } from "./lib/cli-args.ts";
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
  let since: string | undefined;
  try {
    since = getStringArg(argv, "since", { example: "2026-08-29T10:00:00Z" });
  } catch (e) {
    console.error(`[fetch-open-issues-for-triage] ${(e as Error).message}`);
    return 1;
  }

  let result;
  try {
    result = fetchOpenIssuesForTriage(cwd, { since });
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
