#!/usr/bin/env npx tsx
/**
 * check-trade-off-label-cleared.ts (#5821)
 *
 * CLI para o gate de "label `trade-off-real` removida após decisão cat. C" —
 * ver `scripts/lib/trade-off-label-gate.ts` para a lógica pura/docs
 * completas do mecanismo. Este arquivo só busca os dados via `gh` e imprime
 * o veredito, mesmo padrão de `scripts/check-state-changed-pending.ts` /
 * `scripts/check-overnight-comment-coverage.ts`.
 *
 * Roda na Fase 0.5 do `/diaria-develop`, logo depois de postar o comentário
 * de decisão de uma cat. C (`decisao-editor`, #5373) — bloqueia (`exit 1`)
 * se a decisão já foi registrada mas a label `trade-off-real` ainda está
 * presente na issue. `gh` indisponível → fail-soft (#738): vira warning em
 * stderr, `exit 0` (não trava a rodada por causa de rede/CLI ausente — o
 * mesmo espírito dos gates irmãos).
 *
 * Uso:
 *   npx tsx scripts/check-trade-off-label-cleared.ts --issue 5415
 *
 * @see scripts/lib/trade-off-label-gate.ts
 * @see scripts/lib/issue-decisions.ts (fetchCommentBodies, latestDecisionFor, reusados aqui)
 * @see scripts/check-state-changed-pending.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-develop/SKILL.md (Fase 0.5)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { fetchCommentBodies } from "./lib/issue-decisions.ts";
import { checkTradeOffLabelCleared, TRADE_OFF_LABEL } from "./lib/trade-off-label-gate.ts";

interface GhIssueViewLabels {
  labels?: Array<{ name?: string } | string>;
}

interface FetchLabelsResult {
  labels: string[];
  error?: string;
}

/** Busca as labels atuais de uma issue via `gh issue view`. Fail-soft — nunca
 * lança; qualquer falha (CLI ausente, sem auth, rate limit, JSON malformado)
 * volta como `{ labels: [], error }` pro chamador degradar (#738). */
function fetchIssueLabels(issueNumber: number, cwd: string): FetchLabelsResult {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "labels"],
    { cwd, encoding: "utf8", timeout: 15_000 },
  );
  if (result.error) {
    return { labels: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { labels: [], error: `gh issue view saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) {
    return { labels: [], error: "gh issue view retornou stdout vazio" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { labels: [], error: `JSON malformado de gh issue view: ${(e as Error).message}` };
  }
  const raw = (parsed as GhIssueViewLabels).labels;
  if (!Array.isArray(raw)) {
    return { labels: [], error: "gh issue view retornou payload sem labels[]" };
  }
  const labels = raw
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  return { labels };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const issueRaw = values.issue;
  const issueNumber = issueRaw ? Number(issueRaw) : NaN;
  if (!issueRaw || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.error("[check-trade-off-label-cleared] uso: --issue N");
    process.exit(2);
  }

  const cwd = process.cwd();
  const labelsResult = fetchIssueLabels(issueNumber, cwd);
  const bodies = fetchCommentBodies(issueNumber, cwd);

  if (labelsResult.error) {
    console.error(
      `[check-trade-off-label-cleared] gh indisponível — pulando gate (fail-soft, #738): ${labelsResult.error}`,
    );
    process.exit(0);
  }

  const result = checkTradeOffLabelCleared(labelsResult.labels, bodies);

  if (result.status === "no-decision") {
    console.log(`[check-trade-off-label-cleared] #${issueNumber}: nenhuma decisão registrada ainda — gate não se aplica.`);
    process.exit(0);
  }

  if (result.status === "ok") {
    console.log(`[check-trade-off-label-cleared] #${issueNumber}: ok — decisão registrada e label '${TRADE_OFF_LABEL}' já removida.`);
    process.exit(0);
  }

  console.error(
    `[check-trade-off-label-cleared] #${issueNumber}: decisão registrada em ${result.decision?.decided_at}, mas a label '${TRADE_OFF_LABEL}' ainda está presente. ` +
      `Rode: gh issue edit ${issueNumber} --remove-label ${TRADE_OFF_LABEL}`,
  );
  process.exit(1);
}
