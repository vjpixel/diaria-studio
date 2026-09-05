#!/usr/bin/env npx tsx
/**
 * mark-continuo-ci-fix-attempted.ts (#7446 item 3)
 *
 * Aplica o label `continuo-ci-fix-tentado` (idempotente — cria o label se
 * ausente, `gh pr edit --add-label` não falha se já presente) numa PR
 * `continuo/*` depois que o tick tentou consertar o CI dela — INDEPENDENTE
 * do resultado da tentativa (sucesso ou não). É o que fecha o cap de 1
 * tentativa por PR em `selectCiFixCandidate`
 * (`scripts/lib/continuo-ci-fixer-eligibility.ts`): sem este marcador
 * durável, o próximo tick veria a mesma PR com CI ainda vermelho e tentaria
 * de novo — o livelock que este mecanismo existe pra evitar.
 *
 * Uso (chamado pelo tick do contínuo LOGO DEPOIS de escolher a candidata —
 * `hermes/skills/hermes-diaria-continuo/SKILL.md` §3b — ANTES de tentar o
 * conserto, não depois: review da PR #7450 (P2, confiança média) apontou
 * que marcar só APÓS a tentativa deixa uma janela de corrida do tamanho do
 * conserto inteiro entre 2 ticks concorrentes escolhendo a MESMA PR;
 * marcar antes reduz a janela pro intervalo entre "escolher" e "marcar",
 * bem menor):
 *   npx tsx scripts/mark-continuo-ci-fix-attempted.ts --pr 7429
 *
 * Exit code (review da PR #7450, achado #2: exit 0 incondicional escondia
 * falha real de `gh pr edit` atrás de um campo de JSON que só um humano
 * leria — o consumidor real é um harness LLM que pode não notar):
 *   0 = label aplicado com sucesso (`labelApplied: true`).
 *   1 = `gh pr edit --add-label` falhou de verdade (rede, auth, PR sumiu) —
 *       o cap de 1 tentativa NÃO foi fechado; o chamador deve tratar como
 *       falha real (retry manual ou escalar), nunca assumir que "tentou e
 *       seguiu" é suficiente — é exatamente o livelock que este script
 *       existe pra evitar.
 *   2 = uso inválido (`--pr` ausente/não-numérico).
 *
 * @see scripts/lib/continuo-ci-fixer-eligibility.ts
 * @see scripts/check-continuo-ci-fixer-candidate.ts
 */

import { execFileSync } from "node:child_process";
import { CI_FIX_ATTEMPTED_LABEL } from "./lib/continuo-ci-fixer-eligibility.ts";

function parseArgs(argv: string[]): { pr: string } | null {
  let pr: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") pr = argv[++i] ?? null;
  }
  if (!pr || !/^\d+$/.test(pr)) return null;
  return { pr };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("uso: mark-continuo-ci-fix-attempted.ts --pr <N>\n");
    process.exitCode = 2;
    return;
  }

  try {
    execFileSync(
      "gh",
      [
        "label",
        "create",
        CI_FIX_ATTEMPTED_LABEL,
        "--color",
        "5319E7",
        "--description",
        "1 tentativa de conserto de CI já feita nesta PR pelo contínuo (#7446 item 3) — não retentar mecanicamente",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
  } catch {
    // best-effort: "already exists" é o caso comum depois da 1ª chamada em
    // todo o repo; qualquer outra falha (gh indisponível) segue pro
    // gh pr edit abaixo mesmo assim — se falhar também, o catch de fora
    // reporta.
  }

  try {
    execFileSync("gh", ["pr", "edit", args.pr, "--add-label", CI_FIX_ATTEMPTED_LABEL], {
      encoding: "utf8",
      timeout: 30_000,
    });
    console.log(JSON.stringify({ pr: Number(args.pr), labelApplied: true }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ pr: Number(args.pr), labelApplied: false, error: message }));
    process.exitCode = 1;
  }
}

main();
