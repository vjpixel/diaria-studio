#!/usr/bin/env npx tsx
/**
 * scripts/check-issue-open-pr.ts (#7788)
 *
 * CLI fino do preflight de PR ABERTA — ver `scripts/lib/issue-open-pr-check.ts`
 * para a lógica pura e o racional completo. Roda ANTES do dispatch, ao
 * lado do preflight de trabalho MERGEADO
 * (`scripts/check-issue-duplicate-preflight.ts`, #7020) — os dois cobrem
 * estados diferentes da mesma pergunta ("essa issue já está sendo/foi
 * resolvida?"): merged vs. em voo.
 *
 * Uso:
 *   npx tsx scripts/check-issue-open-pr.ts --issue 7746
 *
 * Saída (stdout): JSON `OpenPrCheckResult` (ver módulo pra shape).
 * Exit codes:
 *   0 — "no-open-pr": sem PR aberta cobrindo o escopo, dispatch normal.
 *   1 — "open-pr-covers-scope": há PR aberta candidata — aplicar o
 *       checklist de 3 perguntas do item 16 de
 *       context/overnight-dispatch-rules.md antes de dispatchar.
 *   2 — "cannot-verify" ou uso incorreto: `gh` indisponível/erro, ou
 *       `--issue` ausente/inválido. NUNCA tratar como "sem PR aberta" —
 *       essa é a regra inegociável do #7788.
 *
 * @see scripts/lib/issue-open-pr-check.ts
 * @see scripts/lib/gh-open-pr-fetch.ts
 * @see scripts/check-issue-duplicate-preflight.ts (preflight irmão — trabalho MERGEADO)
 */
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { assessOpenPrCoverage } from "./lib/issue-open-pr-check.ts";
import { fetchOpenPrs, type CommandRunner } from "./lib/gh-open-pr-fetch.ts";

/**
 * `runner` é injetável (default: `gh` real via `fetchOpenPrs`) — permite
 * testar `main()` sem bater na API do GitHub (#7788: "nos testes, injete
 * o executor de gh").
 */
export function main(argv: string[], cwd: string, runner?: CommandRunner): number {
  const { values } = parseArgs(argv);
  const issueRaw = values.issue;
  if (!issueRaw) {
    console.error("[check-issue-open-pr] uso: --issue N");
    return 2;
  }
  const issueNumber = Number(issueRaw);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    console.error(`[check-issue-open-pr] --issue inválido: ${issueRaw}`);
    return 2;
  }

  const fetched = runner ? fetchOpenPrs(cwd, runner) : fetchOpenPrs(cwd);
  if (fetched.error) {
    // Regra inegociável do #7788: falha de fetch NUNCA vira "sem PR
    // aberta". Sempre cannot-verify, sempre exit 2.
    const result = {
      verdict: "cannot-verify" as const,
      issueNumber,
      matches: [],
      error: fetched.error,
      recommendation:
        "gh indisponível/erro ao listar PRs abertas — NÃO tratar como ausência de PR aberta. " +
        "Retry, ou checar manualmente (`gh pr list --state open`) antes do dispatch.",
    };
    console.log(JSON.stringify(result, null, 2));
    console.error(`[check-issue-open-pr] ${fetched.error}`);
    return 2;
  }

  const result = assessOpenPrCoverage(issueNumber, fetched.prs);
  console.log(JSON.stringify(result, null, 2));
  return result.verdict === "open-pr-covers-scope" ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
