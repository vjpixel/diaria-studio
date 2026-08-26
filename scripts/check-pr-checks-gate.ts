#!/usr/bin/env npx tsx
/**
 * check-pr-checks-gate.ts (#6225)
 *
 * CLI pra condição 1 do gate de merge autônomo (overnight/develop/continuo)
 * — ver `scripts/lib/pr-checks-gate.ts` pra lógica pura/docs completas.
 * Este arquivo só chama `gh pr view --json statusCheckRollup`, trata falha
 * de comando/JSON malformado como veredito `"error"` (nunca como "0 checks
 * reprovados") e imprime o resultado.
 *
 * Substitui `gh pr checks {N} --json bucket --jq '...'`, que não roda no
 * `gh` 2.46.0 do `helios` (apt do Ubuntu — `--json` só chegou em `gh pr
 * checks` numa versão posterior; achado ao vivo #6225 aplicando o gate ao
 * PR #6212).
 *
 * Uso:
 *   npx tsx scripts/check-pr-checks-gate.ts --pr 6212
 *
 * Exit codes (todo valor != 0 significa "condição 1 NÃO satisfeita" — o
 * chamador nunca precisa distinguir "erro" de "reprovado" pra decidir se
 * pode mergear, só pra decidir a mensagem):
 *   0 = pass    (verdict "pass" — autorizado)
 *   1 = fail    (ao menos 1 check reprovado)
 *   2 = pending (checks ainda rodando, ou nenhum check registrado ainda)
 *   3 = error   (gh falhou, PR inexistente, JSON malformado, payload sem statusCheckRollup)
 *
 * @see scripts/lib/pr-checks-gate.ts
 * @see .claude/skills/diaria-overnight/SKILL.md (condição 1 do gate — #2210/#2222)
 * @see .claude/skills/diaria-develop/SKILL.md (GATE 2)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { evaluatePrChecksGate, type PrChecksGateResult } from "./lib/pr-checks-gate.ts";

interface GhPrViewStatusCheckRollup {
  statusCheckRollup?: unknown;
}

/**
 * Busca `statusCheckRollup` via `gh pr view`. Fail-hard por design (ao
 * contrário do gate de label #5821, que é hygiene e pode fail-soft): esta
 * é a condição 1 de um gate que AUTORIZA merge — qualquer falha de comando
 * vira `verdict: "error"`, nunca `"pass"`, e o entrypoint sai com código
 * != 0. Nunca lança.
 */
function fetchPrChecksGate(prNumber: number, cwd: string): PrChecksGateResult {
  const result = spawnSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "statusCheckRollup"],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );

  if (result.error) {
    return {
      verdict: "error",
      failingChecks: [],
      pendingChecks: [],
      reason: `gh não pôde ser executado: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      verdict: "error",
      failingChecks: [],
      pendingChecks: [],
      reason: `gh pr view saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (!result.stdout) {
    return {
      verdict: "error",
      failingChecks: [],
      pendingChecks: [],
      reason: "gh pr view retornou stdout vazio",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return {
      verdict: "error",
      failingChecks: [],
      pendingChecks: [],
      reason: `JSON malformado de gh pr view: ${(e as Error).message}`,
    };
  }

  const rollup = (parsed as GhPrViewStatusCheckRollup).statusCheckRollup;
  return evaluatePrChecksGate(rollup);
}

const EXIT_CODES: Record<PrChecksGateResult["verdict"], number> = {
  pass: 0,
  fail: 1,
  pending: 2,
  error: 3,
};

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const prRaw = values.pr;
  const prNumber = prRaw ? Number(prRaw) : NaN;
  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[check-pr-checks-gate] uso: --pr N");
    process.exit(2);
  }

  const result = fetchPrChecksGate(prNumber, process.cwd());
  const prefix = `[check-pr-checks-gate] PR #${prNumber}: verdict=${result.verdict}`;

  if (result.verdict === "pass") {
    console.log(`${prefix} — ${result.reason}`);
  } else {
    console.error(`${prefix} — ${result.reason}`);
  }

  process.exit(EXIT_CODES[result.verdict]);
}
