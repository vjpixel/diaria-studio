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
 *   npx tsx scripts/fetch-open-issues-for-triage.ts --repos all
 *   npx tsx scripts/fetch-open-issues-for-triage.ts --repos vjpixel/diaria-studio,vjpixel/diaria-design
 *
 * **Multi-repo (#10618) é OPT-IN.** Sem `--repos`, varre SÓ o
 * `vjpixel/diaria-studio` — a fila de sempre, a que overnight, contínuo e
 * zerar-fila consomem (vários gates ainda leem `number` como número do
 * studio; até a fatia 3, só o `/diaria-develop` passa `--repos`).
 * `--repos all` = todos de `platform.config.json → issue_repos`; `--repos a,b`
 * = lista validada contra essa allowlist (slug ilegível ou fora dela → exit 1).
 * O repo default entra sempre, primeiro. Cada item traz `repo` e `ref`
 * (`owner/repo#N`); `number` é o número cru dentro de `repo`. Falha de um
 * repo EXTRA → exit 3 (PARCIAL): a lista do que veio sai no stdout e o aviso
 * no stderr; quem avança cursor (`last_scan_at`) NÃO avança com exit 3.
 * Falha do repo default continua exit 1.
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
 * Exit codes: 0 = ok; 1 = falha de fetch/classificação ou `--repos` inválido
 * (mensagem em stderr); 3 = resultado PARCIAL (#10618 — algum repo extra de
 * `--repos` falhou; stdout traz o resto, stderr nomeia o repo).
 *
 * @see scripts/lib/issue-triage-fetch.ts
 */
import { parseArgs, isMainModule, getStringArg } from "./lib/cli-args.ts";
import {
  fetchOpenIssuesForTriage,
  resolveTriageRepos,
  triageAllowedRepos,
  type TriageIssue,
} from "./lib/issue-triage-fetch.ts";

/** #10618 — exit code de resultado PARCIAL (repo extra falhou). Distinto de 1
 * (nada utilizável) e de 0 (lista completa). */
export const EXIT_PARTIAL = 3;

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

  // #10618: multi-repo só por opt-in explícito (`--repos all` ou lista
  // validada contra `issue_repos`). Sem a flag: só o diaria-studio.
  const resolvedRepos = resolveTriageRepos(values.repos, triageAllowedRepos());
  if ("error" in resolvedRepos) {
    console.error(`[fetch-open-issues-for-triage] ${resolvedRepos.error}`);
    return 1;
  }
  const repos = resolvedRepos.repos;

  let result;
  try {
    result = fetchOpenIssuesForTriage(cwd, { since, repos });
  } catch (e) {
    console.error(`[fetch-open-issues-for-triage] ${(e as Error).message}`);
    return 1;
  }
  if (result.error) {
    console.error(`[fetch-open-issues-for-triage] ${result.error}`);
    return 1;
  }
  const repoErrors = result.repoErrors ?? [];
  for (const { repo, error } of repoErrors) {
    console.error(`[fetch-open-issues-for-triage] AVISO — issues de ${repo} NÃO entraram na lista: ${error}`);
  }
  const issues = filterByFlags(result.issues, bugsOnly, priorityFilter);
  console.log(JSON.stringify(issues, null, 2));
  if (repoErrors.length > 0) {
    console.error(
      `[fetch-open-issues-for-triage] resultado PARCIAL (exit ${EXIT_PARTIAL}) — não trate como varredura completa nem avance last_scan_at.`,
    );
    return EXIT_PARTIAL;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
