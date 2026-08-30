#!/usr/bin/env npx tsx
/**
 * check-pr-review-authenticity.ts (#6732)
 *
 * CLI do gate "review independente pré-merge" do `hermes-diaria-continuo`
 * (§3 da SKILL) — ver `scripts/lib/pr-review-authenticity.ts` pra lógica
 * pura/docs completas. Este arquivo só chama `gh pr view --json comments`,
 * trata falha de comando/JSON malformado como veredito `"error"` (nunca
 * como "0 comentários, logo passou") e imprime o resultado.
 *
 * Uso:
 *   npx tsx scripts/check-pr-review-authenticity.ts --pr 6782
 *
 * Exit codes (fail-closed — todo valor != 0 significa "NÃO mergear ainda"):
 *   0 = pass        (review independente confirmado)
 *   1 = self_review (comentário marcado com o marcador de self-review)
 *   2 = no_review   (nenhum comentário de review encontrado)
 *   3 = error       (gh falhou, PR inexistente, JSON malformado)
 *
 * @see scripts/lib/pr-review-authenticity.ts
 * @see hermes/skills/hermes-diaria-continuo/SKILL.md (§3, passo 3)
 * @see .claude/hooks/pr-create-review.mjs (emite a instrução de self-review)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  evaluatePrReviewAuthenticity,
  type PrReviewAuthenticityResult,
} from "./lib/pr-review-authenticity.ts";

/**
 * Busca `comments` via `gh pr view`. Fail-hard por design (mesmo padrão de
 * `fetchPrChecksGate`, #6225): esta é a condição de um gate que AUTORIZA
 * merge — qualquer falha de comando vira `verdict: "error"`, nunca `"pass"`.
 * Nunca lança.
 */
function fetchPrReviewAuthenticity(prNumber: number, cwd: string): PrReviewAuthenticityResult {
  const result = spawnSync("gh", ["pr", "view", String(prNumber), "--json", "comments"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });

  if (result.error) {
    return { verdict: "error", reason: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      verdict: "error",
      reason: `gh pr view saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (!result.stdout) {
    return { verdict: "error", reason: "gh pr view retornou stdout vazio" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { verdict: "error", reason: `JSON malformado de gh pr view: ${(e as Error).message}` };
  }

  const payload = parsed as { comments?: unknown };
  return evaluatePrReviewAuthenticity(payload.comments);
}

const EXIT_CODES: Record<PrReviewAuthenticityResult["verdict"], number> = {
  pass: 0,
  self_review: 1,
  no_review: 2,
  error: 3,
};

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const prRaw = values.pr;
  const prNumber = prRaw ? Number(prRaw) : NaN;
  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[check-pr-review-authenticity] uso: --pr N");
    process.exit(2);
  }

  const result = fetchPrReviewAuthenticity(prNumber, process.cwd());
  const prefix = `[check-pr-review-authenticity] PR #${prNumber}: verdict=${result.verdict}`;

  if (result.verdict === "pass") {
    console.log(`${prefix} — ${result.reason}`);
  } else {
    console.error(`${prefix} — ${result.reason}`);
  }

  process.exit(EXIT_CODES[result.verdict]);
}
