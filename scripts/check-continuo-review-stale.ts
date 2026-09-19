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
 * Exit: 0 = fresh ou unknown (manter o comportamento de sempre),
 *       1 = stale (re-revisar), 2 = uso inválido, 3 = gh falhou/payload ruim
 *       (o chamador trata como "não re-revisar": o portão decide sozinho).
 */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { evaluateReviewStaleness } from "./lib/continuo-review-staleness.ts";
import { extractIndependentReviewHeadSha } from "./lib/pr-review-authenticity.ts";

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
  console.log(JSON.stringify({ pr, ...result, currentHeadSha, reviewedHeadSha }));
  process.exit(result.verdict === "stale" ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
