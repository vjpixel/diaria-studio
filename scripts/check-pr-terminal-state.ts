#!/usr/bin/env npx tsx
/**
 * check-pr-terminal-state.ts (#5831)
 *
 * CLI para o gate de "todo PR aberto por esta sessão chegou a um estado
 * terminal antes do relatório final" — ver `scripts/lib/pr-terminal-state.ts`
 * para a lógica pura/documentação completa do mecanismo. Este arquivo é só
 * o ponto de entrada de linha de comando, mesmo padrão de
 * `scripts/check-overnight-comment-coverage.ts`/`scripts/check-state-changed-pending.ts`.
 *
 * Roda na Fase 2 (relatório final) de `/diaria-develop` e `/diaria-overnight`,
 * junto dos gates irmãos (`check-state-changed-pending.ts`,
 * `check-overnight-comment-coverage.ts`). `exit 1` = há PR aberto no GitHub
 * que esta sessão deveria ter fechado (mergeado ou fechado sem merge) e não
 * fechou — voltar, checar o PR (`gh pr view N`), mergear/fechar/atualizar o
 * `plan.json` com o status correto antes de escrever o relatório.
 *
 * Uso:
 *   npx tsx scripts/check-pr-terminal-state.ts --plan data/overnight/260820/plan.json
 *   npx tsx scripts/check-pr-terminal-state.ts --plan {path} --skip-gh-checks
 *
 * @see scripts/lib/pr-terminal-state.ts
 * @see scripts/check-overnight-comment-coverage.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 2)
 * @see .claude/skills/diaria-develop/SKILL.md (Fase 2)
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import {
  checkPrTerminalState,
  type OpenPrLike,
  type PlanIssueWithPrLike,
} from "./lib/pr-terminal-state.ts";

interface GhFetchResult<T> {
  value: T | null;
  error?: string;
}

/** Fail-soft: nunca lança. `gh` ausente, sem auth, rate-limited, JSON
 * malformado — tudo vira `{ value: null, error }` pro chamador decidir. */
function fetchOpenPrs(cwd: string): GhFetchResult<OpenPrLike[]> {
  const result = spawnSync(
    "gh",
    ["pr", "list", "--state", "open", "--json", "headRefName,number,createdAt", "--limit", "200"],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { value: null, error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { value: null, error: `gh pr list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) return { value: null, error: "gh pr list retornou stdout vazio" };
  try {
    return { value: JSON.parse(result.stdout) as OpenPrLike[] };
  } catch (e) {
    return { value: null, error: `JSON malformado de gh pr list: ${(e as Error).message}` };
  }
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-pr-terminal-state] uso: --plan {path} [--skip-gh-checks]");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-pr-terminal-state] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  if (flags.has("skip-gh-checks")) {
    console.error(
      "[check-pr-terminal-state] --skip-gh-checks: pulando checagem de estado terminal de PR (não avaliada nesta invocação).",
    );
    process.exit(0);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-pr-terminal-state] plan.json malformado — pulando checagem (fail-soft, #738): ${(e as Error).message}`,
    );
    process.exit(0);
  }

  const fetched = fetchOpenPrs(process.cwd());
  if (fetched.error) {
    console.error(`[check-pr-terminal-state] gh indisponível — pulando checagem (fail-soft, #738): ${fetched.error}`);
    process.exit(0);
  }

  const openPrs = fetched.value ?? [];
  const planIssues = normalizeIssues<PlanIssueWithPrLike>(planRaw as IssuesBearing<PlanIssueWithPrLike>);
  const verdict = checkPrTerminalState(openPrs, planIssues);

  if (verdict.status === "ok") {
    console.log(
      `ok — nenhum PR aberto sem estado terminal registrado (${openPrs.length} PR(s) aberto(s) checado(s))`,
    );
    process.exit(0);
  }

  if (verdict.registeredNotTerminal.length > 0) {
    console.error("[check-pr-terminal-state] PR(s) registrado(s) em plan.json ainda aberto(s) sem status terminal:");
    for (const d of verdict.registeredNotTerminal) {
      const issuesList = d.issueNumbers.map((n) => `#${n}`).join(", ");
      const statusList = d.statuses.map((s) => s ?? "(sem status)").join(", ");
      console.error(`  PR #${d.pr} — issue(s) ${issuesList}, status atual: ${statusList}`);
    }
  }

  if (verdict.unregisteredCandidates.length > 0) {
    console.error(
      "[check-pr-terminal-state] PR(s) aberto(s) em branch desta linha de skills (develop/overnight/fix) SEM registro em plan.json — candidato(s) pra revisão humana, autoria não confirmada:",
    );
    for (const c of verdict.unregisteredCandidates) {
      console.error(`  PR #${c.pr} — branch ${c.headRefName}`);
    }
  }

  console.error(
    "[check-pr-terminal-state] → confirme o estado real de cada PR (gh pr view N), mergeie/feche/atualize plan.json com o status correto antes de escrever o relatório final.",
  );
  process.exit(1);
}
