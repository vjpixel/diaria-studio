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
 * Roda em DOIS pontos, logo depois de postar o comentário de decisão
 * (`decisao-editor`, #5373): no briefing da Fase 0 do `/diaria-overnight`
 * (passo 5 — desde o #7493, é lá que a ambiguidade de trade-off real é
 * decidida) e na Fase 0.5 do `/diaria-develop` (cat. C, quando uma sessão
 * supervisionada pega a issue antes). Em ambos, bloqueia (`exit 1`)
 * se a decisão já foi registrada mas a label `trade-off-real` ainda está
 * presente na issue. `gh` indisponível → fail-soft (#738): vira warning em
 * stderr, `exit 0` (não trava a rodada por causa de rede/CLI ausente — o
 * mesmo espírito dos gates irmãos).
 *
 * **`exit 3` = não verificável (#10618, fatia 4, review G):** labels lidas,
 * `trade-off-real` presente, mas a leitura dos COMENTÁRIOS falhou — sem eles
 * não dá pra saber se já há decisão registrada. Antes isso virava "nenhuma
 * decisão" e `exit 0`, deixando passar justo o esquecimento que o gate pega.
 * O chamador trata `exit 3` como "rodar de novo"; nunca como `ok`.
 *
 * Uso:
 *   npx tsx scripts/check-trade-off-label-cleared.ts --issue 5415
 *
 * @see scripts/lib/trade-off-label-gate.ts
 * @see scripts/lib/issue-decisions.ts (fetchCommentBodiesResult, latestDecisionFor, reusados aqui)
 * @see scripts/check-state-changed-pending.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 0 passo 5 — briefing)
 * @see .claude/skills/diaria-develop/SKILL.md (Fase 0.5)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { fetchCommentBodiesResult } from "./lib/issue-decisions.ts";
import { checkTradeOffLabelCleared, TRADE_OFF_LABEL } from "./lib/trade-off-label-gate.ts";
import { formatIssueRef, legacyIssueNumber, loadIssueRepos, parseIssueRef } from "./lib/issue-repos.ts";

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
function fetchIssueLabels(issueNumber: number, cwd: string, repo?: string): FetchLabelsResult {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issueNumber), ...(repo ? ["-R", repo] : []), "--json", "labels"],
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
  // #10618 (fatia 4): `N` (diaria-studio) ou `owner/repo#N` (repo da allowlist).
  const ref = issueRaw ? parseIssueRef(String(issueRaw)) : null;
  if (!ref) {
    console.error("[check-trade-off-label-cleared] uso: --issue N | owner/repo#N");
    process.exit(2);
  }
  const issueNumber = ref.number;
  const cwd = process.cwd();
  const foreign = legacyIssueNumber(ref) === null;
  if (foreign && !loadIssueRepos(cwd).includes(ref.repo)) {
    console.error(`[check-trade-off-label-cleared] ${formatIssueRef(ref)}: repo fora de issue_repos, não consultado`);
    process.exit(2);
  }
  const repoArg = foreign ? ref.repo : undefined;
  const label = foreign ? formatIssueRef(ref) : `#${issueNumber}`;
  const editArgs = foreign ? `${issueNumber} -R ${ref.repo}` : `${issueNumber}`;
  const labelsResult = fetchIssueLabels(issueNumber, cwd, repoArg);
  const comments = fetchCommentBodiesResult(issueNumber, cwd, repoArg);

  if (labelsResult.error) {
    console.error(
      `[check-trade-off-label-cleared] gh indisponível — pulando gate (fail-soft, #738): ${labelsResult.error}`,
    );
    process.exit(0);
  }

  // Sem a label não há o que cobrar — a falha de comentários não muda o
  // veredito (nenhuma das saídas exige ler a decisão). Com a label presente,
  // os comentários decidem: falha de leitura = não verificável, nunca "ok".
  if (comments.error && labelsResult.labels.includes(TRADE_OFF_LABEL)) {
    console.error(
      `[check-trade-off-label-cleared] ${label}: label '${TRADE_OFF_LABEL}' presente, mas os comentários não puderam ser lidos — NÃO verificável (exit 3), rode de novo: ${comments.error}`,
    );
    process.exit(3);
  }

  const result = checkTradeOffLabelCleared(labelsResult.labels, comments.bodies);

  if (result.status === "no-decision") {
    console.log(`[check-trade-off-label-cleared] ${label}: nenhuma decisão registrada ainda — gate não se aplica.`);
    process.exit(0);
  }

  if (result.status === "ok") {
    console.log(`[check-trade-off-label-cleared] ${label}: ok — decisão registrada e label '${TRADE_OFF_LABEL}' já removida.`);
    process.exit(0);
  }

  console.error(
    `[check-trade-off-label-cleared] ${label}: decisão registrada em ${result.decision?.decided_at}, mas a label '${TRADE_OFF_LABEL}' ainda está presente. ` +
      `Rode: gh issue edit ${editArgs} --remove-label ${TRADE_OFF_LABEL}`,
  );
  process.exit(1);
}
