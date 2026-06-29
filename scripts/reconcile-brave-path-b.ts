#!/usr/bin/env node
/**
 * reconcile-brave-path-b.ts (#2668 follow-up)
 *
 * Reconcilia a contagem do Path B (WebSearch dos agentes de pesquisa → Brave)
 * de forma DETERMINÍSTICA, a partir do gap real do header X-RateLimit-Remaining,
 * em vez do multiplicador frágil `N*2+M+J` que o orchestrator computava à mão
 * num passo de playbook (que nunca rodou — 0 entradas estimadas em maio E junho,
 * causa do esgotamento dos $5 em jun/2026).
 *
 * Como funciona: lê o counter (`computeBraveCreditStats`), pega `delta_untracked`
 * (= uso real do header − contagem local). Se > 0, grava esse tanto de entradas
 * `estimated:true` (source `path-b-reconcile`) — então `queries_this_month` local
 * passa a bater com o uso real do Brave. Idempotente (recordBraveCreditEstimate
 * pula se já reconciliou esta edição/source no mês).
 *
 * O ALERTA já não depende disto (usa o header direto desde #2668) — isto é só
 * pra o breakdown local do relatório ficar fiel. Roda 1× ao fim do Stage 1.
 *
 * Uso:
 *   npx tsx scripts/reconcile-brave-path-b.ts --edition AAMMDD
 *
 * Premissa: requer que ≥1 chamada Path A (fetch-websearch-batch) tenha capturado
 * o header `quota_remaining` este mês. Sem header, é no-op (nada a reconciliar).
 */

import {
  computeBraveCreditStats,
  recordBraveCreditEstimate,
} from "./lib/brave-credits.ts";
import { getArg } from "./lib/cli-args.ts";

const DEFAULT_PATH = "data/brave-credits.jsonl";

export function main(
  argv: string[] = process.argv.slice(2),
  path: string = DEFAULT_PATH,
): void {
  const edition = getArg(argv, "edition") || undefined;
  const stats = computeBraveCreditStats(edition ?? null, path);

  if (typeof stats.delta_untracked !== "number") {
    console.error(
      "[reconcile-brave-path-b] sem header X-RateLimit-Remaining este mês — " +
        "nada a reconciliar (rode após ≥1 chamada Path A).",
    );
    console.log(JSON.stringify({ reconciled: 0, reason: "no_header" }));
    return;
  }

  const gap = stats.delta_untracked;
  if (gap <= 0) {
    console.error(
      `[reconcile-brave-path-b] gap=${gap} (≤0) — contagem local já bate com o ` +
        `header (uso real ${stats.effective_used}). Nada a fazer.`,
    );
    console.log(JSON.stringify({ reconciled: 0, gap, reason: "no_gap" }));
    return;
  }

  recordBraveCreditEstimate(
    {
      edition,
      source: "path-b-reconcile",
      count: gap,
    },
    path,
  );
  console.error(
    `[reconcile-brave-path-b] +${gap} queries Path B reconciliadas do header ` +
      `(local ${stats.queries_this_month} → real ${stats.effective_used}). Idempotente.`,
  );
  console.log(JSON.stringify({ reconciled: gap, gap, edition: edition ?? null }));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
