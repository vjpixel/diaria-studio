#!/usr/bin/env npx tsx
/**
 * check-continuo-escalate-label.ts (#7446 item 2)
 *
 * CLI wrapper de `scripts/lib/continuo-escalate-owner.ts` — todo I/O (`gh pr
 * view`/`gh pr edit`) fica aqui; a decisão pura fica na lib. Consumido pelo
 * ramo `gate=escalate` de `try_merge_gate()` em
 * `hermes/scripts/continuo-pr-review.sh`: aplica o label
 * `continuo-escalado` (idempotente) e diz ao chamador se esta é a PRIMEIRA
 * vez que a PR escala (pra decidir se notifica no resumo do tick, que o cron
 * do Hermes entrega ao Telegram, ou só conta em silêncio).
 *
 * Uso:
 *   npx tsx scripts/check-continuo-escalate-label.ts --pr 7432
 *
 * Saída: JSON `{"firstTime": boolean, "labelApplied": boolean, "source":
 * "ok" | "error"}` em stdout. `source: "error"` (gh falhou ao ler labels)
 * resolve `firstTime: true` — fail-OPEN em direção a notificar (o pior caso
 * de um falso positivo aqui é 1 notificação a mais, nunca um merge indevido
 * nem uma PR escalada ficando muda para sempre).
 *
 * Exit code sempre 0 exceto uso inválido (`--pr` ausente/não-numérico, 2).
 *
 * @see scripts/lib/continuo-escalate-owner.ts
 * @see hermes/scripts/continuo-pr-review.sh (ramo `1)` de `try_merge_gate()`)
 */

import { execFileSync } from "node:child_process";
import { isAlreadyEscalated, CONTINUO_ESCALATED_LABEL } from "./lib/continuo-escalate-owner.ts";

function parseArgs(argv: string[]): { pr: string } | null {
  let pr: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") pr = argv[++i] ?? null;
  }
  if (!pr || !/^\d+$/.test(pr)) return null;
  return { pr };
}

/** `null` = `gh` falhou de verdade (rede, auth, PR sumiu) — distinto de "0
 *  labels" (array vazio), que é estado válido, não erro. */
function fetchLabels(pr: string): string[] | null {
  try {
    const out = execFileSync("gh", ["pr", "view", pr, "--json", "labels", "--jq", "[.labels[].name]"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return JSON.parse(out) as string[];
  } catch {
    return null;
  }
}

/** Best-effort: aplica o label — nunca aborta se `gh` falhar (a decisão
 * `firstTime` já foi tomada; o pior caso é o label não pegar desta vez e a
 * próxima escalada tentar de novo). */
function applyLabel(pr: string): boolean {
  try {
    execFileSync("gh", ["pr", "edit", pr, "--add-label", CONTINUO_ESCALATED_LABEL], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("uso: check-continuo-escalate-label.ts --pr <N>\n");
    process.exitCode = 2;
    return;
  }

  const labels = fetchLabels(args.pr);
  if (labels === null) {
    console.log(JSON.stringify({ firstTime: true, labelApplied: false, source: "error" }));
    return;
  }

  const alreadyEscalated = isAlreadyEscalated(labels);
  const labelApplied = alreadyEscalated ? false : applyLabel(args.pr);
  console.log(JSON.stringify({ firstTime: !alreadyEscalated, labelApplied, source: "ok" }));
}

main();
