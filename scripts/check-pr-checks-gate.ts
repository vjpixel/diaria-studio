#!/usr/bin/env npx tsx
/**
 * check-pr-checks-gate.ts (#6225)
 *
 * CLI pra condição 1 do gate de merge autônomo (overnight/develop/continuo)
 * — ver `scripts/lib/pr-checks-gate.ts` pra lógica pura/docs completas.
 * Este arquivo só chama `gh pr view --json statusCheckRollup,mergeable,commits`,
 * trata falha de comando/JSON malformado como veredito `"error"` (nunca
 * como "0 checks reprovados") e imprime o resultado. `commits` alimenta a
 * heurística de janela de corrida do #7060 (`headCommittedAt` —
 * `evaluatePrChecksGate`): um veredito fail/pass que se resolveu poucos
 * segundos após o push do commit HEAD sai como `pending` em vez de ser
 * aceito — o merge ref pode não ter sido recalculado ainda pelo GitHub, e
 * o chamador já trata `pending` como "tenta de novo", que é a reconfirmação
 * de fato (o poll seguinte reflete o estado real).
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
 *   0 = pass                (verdict "pass" — autorizado)
 *   1 = fail                (ao menos 1 check reprovado)
 *   2 = pending             (checks ainda rodando, nenhum check registrado ainda, ou dentro da janela
 *                            de corrida do #7060 — fail/pass que resolveu segundos após o push do HEAD)
 *   3 = error               (gh falhou, PR inexistente, JSON malformado, payload sem statusCheckRollup)
 *   4 = blocked_by_conflict (#6768 — PR CONFLICTING com a base; CI nunca vai rodar pra este SHA,
 *                            nenhuma espera resolve — precisa merge/rebase com a base primeiro)
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
  /** `"MERGEABLE" | "CONFLICTING" | "UNKNOWN"` — ver #6768/`evaluatePrChecksGate`. */
  mergeable?: unknown;
  /** #7060: usado só pra extrair `committedDate` do commit HEAD (último
   * item) — mesma convenção de campo já usada em
   * `check-branch-issue-consistency.ts`. */
  commits?: unknown;
}

/**
 * #7060: `committedDate` do ÚLTIMO commit da lista (`gh pr view --json
 * commits` retorna em ordem cronológica — o mesmo pressuposto já feito por
 * `check-branch-issue-consistency.ts`), que é o commit HEAD atual. `null`
 * se o campo faltar/tiver shape inesperado/lista vazia — nunca lança;
 * chamador trata como "sem dado pra heurística de corrida", que é o
 * comportamento pré-#7060.
 */
function extractHeadCommittedAt(commits: unknown): string | null {
  if (!Array.isArray(commits) || commits.length === 0) return null;
  const head = commits[commits.length - 1] as { committedDate?: unknown } | null;
  return typeof head?.committedDate === "string" ? head.committedDate : null;
}

/**
 * Busca `statusCheckRollup` (+ `mergeable`, #6768; + `commits`, #7060) via
 * `gh pr view`. Fail-hard por design (ao contrário do gate de label #5821,
 * que é hygiene e pode fail-soft): esta é a condição 1 de um gate que
 * AUTORIZA merge — qualquer falha de comando vira `verdict: "error"`,
 * nunca `"pass"`, e o entrypoint sai com código != 0. Nunca lança.
 */
function fetchPrChecksGate(prNumber: number, cwd: string): PrChecksGateResult {
  const result = spawnSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "statusCheckRollup,mergeable,commits"],
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

  const payload = parsed as GhPrViewStatusCheckRollup;
  const rollup = payload.statusCheckRollup;
  const mergeable = typeof payload.mergeable === "string" ? payload.mergeable : undefined;
  const headCommittedAt = extractHeadCommittedAt(payload.commits) ?? undefined;
  return evaluatePrChecksGate(rollup, { mergeable, headCommittedAt });
}

const EXIT_CODES: Record<PrChecksGateResult["verdict"], number> = {
  pass: 0,
  fail: 1,
  pending: 2,
  error: 3,
  blocked_by_conflict: 4,
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
