#!/usr/bin/env npx tsx
/**
 * check-continuo-reject-label.ts (#7567)
 *
 * CLI wrapper de `scripts/lib/continuo-reject-owner.ts` — todo I/O (`gh pr view` + REST) fica aqui; a decisão pura fica na lib. Consumido pelo
 * ramo `gate=reject` de `try_merge_gate()` em
 * `hermes/scripts/continuo-pr-review.sh`: aplica o label
 * `continuo-rejeitado` (idempotente) e diz ao chamador se esta é a PRIMEIRA
 * vez que a PR é rejeitada (pra decidir se notifica no resumo do tick, que
 * o cron do Hermes entrega ao Telegram, ou só conta em silêncio) — mesmo
 * padrão de `check-continuo-escalate-label.ts` (#7446 item 2), aplicado ao
 * lado `reject` que ficou sem dono (#7567).
 *
 * Uso:
 *   npx tsx scripts/check-continuo-reject-label.ts --pr 7593
 *
 * Saída: JSON `{"firstTime": boolean, "labelApplied": boolean, "source":
 * "ok" | "error"}` em stdout. `source: "error"` (gh falhou ao ler labels)
 * resolve `firstTime: true` — fail-OPEN em direção a notificar (o pior caso
 * de um falso positivo aqui é 1 notificação a mais, nunca um merge indevido
 * nem uma PR rejeitada ficando muda para sempre).
 *
 * Exit code sempre 0 exceto uso inválido (`--pr` ausente/não-numérico, 2).
 *
 * @see scripts/lib/continuo-reject-owner.ts
 * @see hermes/scripts/continuo-pr-review.sh (ramo `2)` de `try_merge_gate()`)
 */

import { execFileSync } from "node:child_process";
import { isAlreadyRejectLabeled } from "./lib/continuo-reject-owner.ts";
import { CONTINUO_REJECTED_LABEL_SPEC, ensureContinuoLabel } from "./lib/continuo-labels.ts";
import { addPrLabelsRest } from "./lib/gh-pr-safe-edit.ts";

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

/**
 * Cria o label (se ausente) e o aplica na PR, ambos por REST.
 *
 * **Nunca `gh label create` + `gh pr edit --add-label` (#7704).** Os dois
 * falhavam e o `catch {}` engolia: o `create` saía 422 porque a descrição
 * passava dos 100 chars do GitHub, e o `--add-label` seguinte saía 1 porque
 * o label não existia — `labelApplied: false` era o ÚNICO sinal, e o bash
 * chamador o ignorava. `addPrLabelsRest` (#6292) ainda cobre o outro modo de
 * falha do `gh pr edit`: exit 0 sem aplicar nada quando a mutação GraphQL
 * bate em `projectCards`.
 *
 * Continua best-effort quanto ao PROCESSO (nunca aborta — a decisão
 * `firstTime` já foi tomada), mas o motivo da falha agora sai em stderr em
 * vez de sumir, pra `continuo-pr-review.sh` registrar como erro de infra.
 */
function applyLabel(pr: string): boolean {
  const cwd = process.cwd();
  const ensured = ensureContinuoLabel(CONTINUO_REJECTED_LABEL_SPEC, cwd);
  if (!ensured.ok) {
    process.stderr.write(`[check-continuo-reject-label] ${CONTINUO_REJECTED_LABEL_SPEC.name}: ${ensured.error}\n`);
    return false;
  }

  const applied = addPrLabelsRest(Number(pr), [CONTINUO_REJECTED_LABEL_SPEC.name], cwd);
  if (!applied.ok) {
    process.stderr.write(`[check-continuo-reject-label] PR #${pr}: ${applied.error}\n`);
    return false;
  }
  return true;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("uso: check-continuo-reject-label.ts --pr <N>\n");
    process.exitCode = 2;
    return;
  }

  const labels = fetchLabels(args.pr);
  if (labels === null) {
    console.log(JSON.stringify({ firstTime: true, labelApplied: false, source: "error" }));
    return;
  }

  const alreadyRejected = isAlreadyRejectLabeled(labels);
  const labelApplied = alreadyRejected ? false : applyLabel(args.pr);
  console.log(JSON.stringify({ firstTime: !alreadyRejected, labelApplied, source: "ok" }));
}

main();
