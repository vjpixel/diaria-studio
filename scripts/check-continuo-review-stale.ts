#!/usr/bin/env npx tsx
/**
 * check-continuo-review-stale.ts (#8445)
 *
 * CLI de `scripts/lib/continuo-review-staleness.ts`. Consumido por
 * `hermes/scripts/continuo-pr-review.sh` no ramo "PR já tem review": se a
 * revisão é de um SHA anterior ao HEAD atual, a PR precisa de review novo em
 * vez de ir direto ao portão de merge (que só vai escalar por "HEAD mudou").
 *
 * Uso: npx tsx scripts/check-continuo-review-stale.ts --pr 8381
 *
 * Saída: JSON `{pr, verdict, reason, currentHeadSha, reviewedHeadSha}`.
 * Exit: 0 = fresh, unknown ou stale-com-tentativas-esgotadas (manter o caminho de sempre),
 *       10 = stale (re-revisar), 2 = uso inválido, 3 = gh falhou/payload ruim.
 *       NUNCA 1 pra stale: exceção não tratada do Node sai 1 (review da PR #8451).
 *       O chamador só re-revisa em 10; qualquer outro código mantém o caminho seguro.
 *       Teto de MAX_RE_REVIEW_ATTEMPTS por PR+SHA (estado em --attempts-file).
 */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attemptsFilePath,
  consumeReReviewAttempt,
  evaluateReviewStaleness,
  STALE_EXIT_CODE,
  type ReReviewAttempts,
} from "./lib/continuo-review-staleness.ts";
import { extractIndependentReviewHeadSha } from "./lib/pr-review-authenticity.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const pr = Number(values["pr"]);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error("[check-continuo-review-stale] uso: --pr N");
    process.exit(2);
  }
  const res = spawnSync("gh", ["pr", "view", String(pr), "--json", "headRefOid,comments"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error || res.status !== 0) {
    console.error(`[check-continuo-review-stale] gh pr view falhou: ${res.error?.message ?? res.stderr}`);
    process.exit(3);
  }
  let payload: { headRefOid?: unknown; comments?: unknown };
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    console.error("[check-continuo-review-stale] JSON malformado de gh pr view");
    process.exit(3);
  }
  const currentHeadSha = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
  const reviewedHeadSha = extractIndependentReviewHeadSha(payload.comments);
  const result = evaluateReviewStaleness({ currentHeadSha, reviewedHeadSha });
  if (result.verdict !== "stale" || !currentHeadSha) {
    console.log(JSON.stringify({ pr, ...result, currentHeadSha, reviewedHeadSha }));
    process.exit(0);
  }
  // stale: só re-revisa se ainda há tentativa pra este PR+SHA, e só se conseguir
  // GRAVAR o consumo — sem persistência não há teto, e sem teto o laço de custo volta.
  // mesma resolução (relativa ao REPO, nunca ao cwd) do detector check-continuo-stale-review-health.ts —
  // se divergissem, o detector leria um arquivo diferente do que o merger grava.
  const attemptsFile = resolve(values["attempts-file"] ?? attemptsFilePath(REPO_ROOT));
  let state: ReReviewAttempts = {};
  try {
    if (existsSync(attemptsFile)) state = JSON.parse(readFileSync(attemptsFile, "utf8")) as ReReviewAttempts;
  } catch {
    // Estado ilegível NUNCA reseta o teto: zerar aqui reabriria o laço de custo que o teto
    // existe pra impedir. Caminho seguro (sem re-review); o gate escala como sempre.
    console.log(JSON.stringify({ pr, ...result, reReview: false, currentHeadSha, reviewedHeadSha, reason: result.reason + " — arquivo de estado das tentativas ilegível, mantendo caminho seguro" }));
    process.exit(0);
  }
  const { allowed, next } = consumeReReviewAttempt(state, pr, currentHeadSha);
  let persisted = false;
  if (allowed) {
    try {
      mkdirSync(dirname(attemptsFile), { recursive: true });
      // escrita atômica: leitor concorrente (o detector diário) nunca vê JSON truncado
      const tmp = `${attemptsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next));
      renameSync(tmp, attemptsFile);
      persisted = true;
    } catch {
      persisted = false;
    }
  }
  const reReview = allowed && persisted;
  console.log(JSON.stringify({ pr, ...result, reReview, currentHeadSha, reviewedHeadSha, ...(allowed ? {} : { reason: result.reason + " — tentativas esgotadas pra este SHA, mantendo caminho seguro" }) }));
  process.exit(reReview ? STALE_EXIT_CODE : 0);
}

if (isMainModule(import.meta.url)) main();
