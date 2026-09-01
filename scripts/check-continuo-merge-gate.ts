#!/usr/bin/env npx tsx
/**
 * check-continuo-merge-gate.ts (#6926)
 *
 * CLI que decide se `continuo-pr-review.sh` pode mergear a PR que acabou de
 * revisar — ver `scripts/lib/continuo-merge-gate.ts` pra lógica pura/ordem
 * dos portões. Este arquivo só faz I/O: 1 chamada `gh pr view` (todos os
 * campos precisados de uma vez — headRefOid, mergeable, statusCheckRollup,
 * comments, body, additions, deletions, files — em vez de 3+ chamadas
 * separadas), 1 chamada `gh issue view` por issue referenciada pelo corpo
 * (tipicamente 0 ou 1), e imprime o veredito como JSON.
 *
 * Uso:
 *   npx tsx scripts/check-continuo-merge-gate.ts --pr 6929 --reviewed-head-sha abc123
 *
 * `--reviewed-head-sha`: o SHA do HEAD capturado pelo script bash ANTES de
 * invocar a sessão de review — comparado contra o HEAD atual pra fechar a
 * corrida do #5716 (revisão que não cobre commit pós-revisão).
 *
 * `--diff-threshold` (opcional): override do limiar de linhas de diff —
 * default é `EFFORT_DIFF_LINE_THRESHOLD` (DUPLICADO, não importado, de
 * `.claude/hooks/pr-create-review.mjs` — ver comentário na constante
 * abaixo — mas reusando o MESMO VALOR, #4813/#6393, decisão do editor de
 * não inventar limiar novo). Existe só pra teste/debug; o cron nunca
 * precisa passá-lo.
 *
 * `--assume-approved` (flag booleana, sem valor): trata veredito ausente
 * (`null`) como `approve` — cobre o caminho "AUTH_RC=0" de
 * `continuo-pr-review.sh` (PR que já tinha review independente ANTES do
 * campo `verdict=` existir, #6926). Nunca sobrescreve um `verdict=reject`
 * explícito. Só o chamador que já confirmou `check-pr-review-
 * authenticity.ts` → `pass` deve passar esta flag.
 *
 * Exit codes (fail-closed — todo valor != 0 significa "NÃO mergear"):
 *   0 = merge     (todos os portões passaram)
 *   1 = escalate  (algum portão pediu revisão humana/próximo tick — não é
 *                  erro, é "ainda não dá pra decidir sozinho")
 *   2 = reject    (superseded, ou veredito da revisão foi reject)
 *   3 = error     (gh falhou, PR inexistente, JSON malformado, uso inválido)
 *
 * @see scripts/lib/continuo-merge-gate.ts
 * @see scripts/lib/continuo-superseded-check.ts
 * @see scripts/lib/pr-review-authenticity.ts (extractIndependentReviewVerdict)
 * @see scripts/lib/pr-checks-gate.ts (evaluatePrChecksGate)
 * @see scripts/lib/sensitive-path-guard.ts (classifyChangedPaths)
 * @see hermes/scripts/continuo-pr-review.sh
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { evaluatePrChecksGate } from "./lib/pr-checks-gate.ts";
import { classifyChangedPaths } from "./lib/sensitive-path-guard.ts";
import { extractIndependentReviewVerdict } from "./lib/pr-review-authenticity.ts";
import { extractClosingIssueNumbers, computeSupersededVerdict } from "./lib/continuo-superseded-check.ts";
import { evaluateContinuoMergeGate, type ContinuoMergeGateResult } from "./lib/continuo-merge-gate.ts";

/**
 * #6926: reusa o MESMO valor do limiar de tamanho de diff que já decide
 * effort de review em `.claude/hooks/pr-create-review.mjs`
 * (`EFFORT_DIFF_LINE_THRESHOLD`, #4813/#6393) — decisão do editor,
 * "não inventa limiar novo". DUPLICADO, não importado: `tsconfig.json`
 * só inclui `scripts/**\/*.ts` (o hook é `.mjs`, sem declaração de tipos —
 * `import` direto falha `tsc --noEmit` com TS7016), e o próprio hook é
 * self-contained de propósito (nunca importa `scripts/*.ts` de volta — ver
 * docblock dele). Se o valor mudar lá, mudar aqui também —
 * `test/continuo-merge-gate-threshold-sync.test.ts` trava os dois iguais.
 */
export const EFFORT_DIFF_LINE_THRESHOLD = 500;

interface GhPrViewPayload {
  headRefOid?: unknown;
  mergeable?: unknown;
  statusCheckRollup?: unknown;
  comments?: unknown;
  body?: unknown;
  additions?: unknown;
  deletions?: unknown;
  files?: unknown;
}

interface GhIssueViewPayload {
  state?: unknown;
}

/** `spawnSync` de `gh`, fail-hard: erro/JSON malformado nunca vira dado "ok". */
function ghJson<T>(args: string[], cwd: string): { ok: true; data: T } | { ok: false; reason: string } {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, reason: `gh não pôde ser executado: ${result.error.message}` };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { ok: false, reason: `gh saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) return { ok: false, reason: "gh retornou stdout vazio" };
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch (e) {
    return { ok: false, reason: `JSON malformado de gh: ${(e as Error).message}` };
  }
}

/** Estado (`OPEN`/`CLOSED`) de cada issue referenciada pelo corpo, via `gh
 *  issue view` — 1 chamada por número (tipicamente 0 ou 1 issue por PR).
 *  Issue que falha ao buscar (fechada indevidamente, `gh` com erro
 *  transitório, número inexistente) fica SEM entrada no mapa — tratada como
 *  estado desconhecido por `computeSupersededVerdict` (fail-closed: nunca
 *  "CLOSED" por omissão). */
function fetchIssueStates(numbers: readonly number[], cwd: string): Map<number, "OPEN" | "CLOSED"> {
  const states = new Map<number, "OPEN" | "CLOSED">();
  for (const n of numbers) {
    const result = ghJson<GhIssueViewPayload>(["issue", "view", String(n), "--json", "state"], cwd);
    if (result.ok && (result.data.state === "OPEN" || result.data.state === "CLOSED")) {
      states.set(n, result.data.state);
    }
  }
  return states;
}

const EXIT_CODES: Record<ContinuoMergeGateResult["action"], number> = {
  merge: 0,
  escalate: 1,
  reject: 2,
};

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const prRaw = values.pr;
  const prNumber = prRaw ? Number(prRaw) : NaN;
  const reviewedHeadSha = values["reviewed-head-sha"];
  const diffThreshold = values["diff-threshold"] ? Number(values["diff-threshold"]) : EFFORT_DIFF_LINE_THRESHOLD;

  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0 || !reviewedHeadSha) {
    console.error("[check-continuo-merge-gate] uso: --pr N --reviewed-head-sha SHA [--diff-threshold N]");
    process.exit(3);
  }

  const cwd = process.cwd();
  const prView = ghJson<GhPrViewPayload>(
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "headRefOid,mergeable,statusCheckRollup,comments,body,additions,deletions,files",
    ],
    cwd,
  );

  if (!prView.ok) {
    console.error(`[check-continuo-merge-gate] PR #${prNumber}: erro ao buscar dados — ${prView.reason}`);
    process.exit(3);
  }

  const payload = prView.data;
  const currentHeadSha = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
  const mergeable =
    payload.mergeable === "MERGEABLE" || payload.mergeable === "CONFLICTING" || payload.mergeable === "UNKNOWN"
      ? payload.mergeable
      : null;
  const checksResult = evaluatePrChecksGate(payload.statusCheckRollup, {
    mergeable: typeof payload.mergeable === "string" ? payload.mergeable : undefined,
  });
  let verdict = extractIndependentReviewVerdict(payload.comments);
  // #6926: `--assume-approved` cobre o caminho "AUTH_RC=0" de
  // continuo-pr-review.sh — PR que já tinha review independente ANTES do
  // campo `verdict=` existir (marcador legado, pré-#6926), então
  // `extractIndependentReviewVerdict` devolve `null` mesmo com review de
  // verdade presente. O chamador só passa esta flag depois de confirmar via
  // `check-pr-review-authenticity.ts` (`AUTH_RC=0`, verdict="pass") que
  // existe review independente — nunca por padrão, nunca quando o veredito é
  // `null` por AUSÊNCIA de qualquer review (aí não há nada legado pra
  // assumir). Um `verdict="reject"` explícito (review MAIS recente que já
  // usa o campo novo) sempre vence — a flag só preenche o silêncio, nunca
  // sobrescreve um veredito que já existe.
  if (flags.has("assume-approved") && verdict === null) {
    verdict = "approve";
  }

  const files = Array.isArray(payload.files)
    ? (payload.files as Array<{ path?: unknown }>)
        .map((f) => (typeof f?.path === "string" ? f.path : null))
        .filter((p): p is string => p !== null)
    : null;
  const sensitive = files === null ? null : classifyChangedPaths(files).sensitive;

  const closingIssueNumbers = extractClosingIssueNumbers(payload.body);
  const issueStates = fetchIssueStates(closingIssueNumbers, cwd);
  const supersededVerdict = computeSupersededVerdict(closingIssueNumbers, issueStates);

  const additions = typeof payload.additions === "number" ? payload.additions : null;
  const deletions = typeof payload.deletions === "number" ? payload.deletions : null;
  const diffLineCount = additions !== null && deletions !== null ? additions + deletions : null;

  const result = evaluateContinuoMergeGate({
    superseded: supersededVerdict.superseded,
    verdict,
    currentHeadSha,
    reviewedHeadSha,
    sensitive,
    checksVerdict: checksResult.verdict,
    mergeable,
    diffLineCount,
    diffLineThreshold: diffThreshold,
  });

  const output = {
    pr: prNumber,
    action: result.action,
    reason: result.reason,
    details: {
      superseded: supersededVerdict,
      verdict,
      currentHeadSha,
      reviewedHeadSha,
      sensitive,
      checksVerdict: checksResult.verdict,
      mergeable,
      diffLineCount,
      diffLineThreshold: diffThreshold,
    },
  };

  console.log(JSON.stringify(output));
  if (result.action !== "merge") {
    console.error(`[check-continuo-merge-gate] PR #${prNumber}: ${result.action} — ${result.reason}`);
  }
  process.exit(EXIT_CODES[result.action]);
}
