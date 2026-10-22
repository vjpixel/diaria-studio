#!/usr/bin/env npx tsx
/**
 * check-pr-retido-gate.ts (#10278)
 *
 * CLI da condição 3 do gate determinístico de merge do `/diaria-overnight`
 * (Fase 0 passo 2b — pickup de PR `continuo/*` — e Fase 1 passo 3): a PR
 * está retida para o editor? Lógica pura em
 * `scripts/lib/pr-retido-para-editor.ts`; este arquivo só faz 1 chamada
 * `gh pr view --json labels,body` e imprime o veredito como JSON.
 *
 * O portão de merge do `continuo-pr-review.sh` já lê o mesmo sinal por
 * dentro de `scripts/check-continuo-merge-gate.ts` — este CLI existe para o
 * coordenador do overnight, que mergeia por `gh pr merge` direto (não passa
 * por aquele script).
 *
 * Uso:
 *   npx tsx scripts/check-pr-retido-gate.ts --pr 10221
 *   npx tsx scripts/check-pr-retido-gate.ts --pr 23 --issue vjpixel/diaria-design#21   (#10618: repo do PR derivado da issue)
 *   npx tsx scripts/check-pr-retido-gate.ts --pr 23 --repo vjpixel/diaria-design
 *
 * Exit codes (todo valor != 0 significa "NÃO mergear"):
 *   0 = livre    (sem label `retido-para-editor` e sem marcador no corpo)
 *   1 = retido   (label ou marcador presente — merge só com decisão do editor)
 *   3 = error    (gh falhou, JSON malformado, labels ilegíveis, uso inválido
 *                 ou exceção não-tratada — fail-closed, nunca "livre")
 *
 * @see scripts/lib/pr-retido-para-editor.ts
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { evaluatePrRetido } from "./lib/pr-retido-para-editor.ts";
import { prLabelInRepo, resolvePrTargetRepo } from "./lib/issue-repos.ts";

function run(): number {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const prRaw = values.pr;
  const prNumber = prRaw ? Number(prRaw) : NaN;
  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[check-pr-retido-gate] uso: --pr N [--repo owner/name | --issue N|owner/repo#N]");
    return 3;
  }
  // #10618 (fatia 4): PR de outro repo da allowlist (`--repo vjpixel/diaria-design`,
  // ou derivado de `--issue owner/repo#N` — review J: o PR mora no repo da issue).
  const repoFlag = resolvePrTargetRepo(values, flags, process.cwd());
  if ("error" in repoFlag) {
    console.error(`[check-pr-retido-gate] ${repoFlag.error}`);
    return 3;
  }
  const repo = repoFlag.repo;
  const label = prLabelInRepo(prNumber, repo);

  const result = spawnSync("gh", ["pr", "view", String(prNumber), ...(repo ? ["-R", repo] : []), "--json", "labels,body"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    const why = result.error?.message ?? (result.stderr ?? "").toString().trim();
    console.error(
      `[check-pr-retido-gate] ${label}: gh falhou — ${why || (result.status === 0 ? "stdout vazio" : `status ${result.status}`)}`,
    );
    return 3;
  }

  let payload: { labels?: unknown; body?: unknown };
  try {
    payload = JSON.parse(result.stdout);
  } catch (e) {
    console.error(`[check-pr-retido-gate] ${label}: JSON malformado de gh — ${(e as Error).message}`);
    return 3;
  }

  const verdict = evaluatePrRetido({ labels: payload.labels, body: payload.body });
  console.log(JSON.stringify({ pr: prNumber, ...(repo ? { repo } : {}), retido: verdict.retido, reason: verdict.reason }));
  if (verdict.retido === null) {
    console.error(`[check-pr-retido-gate] ${label}: ${verdict.reason}`);
    return 3;
  }
  if (verdict.retido) {
    console.error(`[check-pr-retido-gate] ${label}: ${verdict.reason}`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  let exitCode: number;
  try {
    exitCode = run();
  } catch (e) {
    console.error(`[check-pr-retido-gate] exceção não tratada: ${(e as Error)?.stack ?? String(e)}`);
    exitCode = 3;
  }
  process.exit(exitCode);
}
