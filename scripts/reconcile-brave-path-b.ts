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
 * ⚠️ BEST-EFFORT, não infalível: deriva do ÚLTIMO header capturado este mês (pela
 * última Path A). Se essa Path A rodou ANTES dos agentes, o header não reflete o
 * Path B → gap=0 → no-op (Path B fica invisível no breakdown). Na prática a Path A
 * (how-to queries) roda em paralelo/depois dos agentes, então normalmente captura
 * o uso deles — mas NÃO é garantido. A REDE DE SEGURANÇA é o ALERTA, que usa o
 * header direto (#2668) independente disto; este script só melhora o breakdown local.
 *
 * Roda 1× por edição/mês (idempotente). Uso:
 *   npx tsx scripts/reconcile-brave-path-b.ts --edition AAMMDD   (--edition OBRIGATÓRIO)
 */

import {
  computeBraveCreditStats,
  recordBraveCreditEstimate,
  DEFAULT_PATH,
} from "./lib/brave-credits.ts";
import { getArg } from "./lib/cli-args.ts";

export function main(
  argv: string[] = process.argv.slice(2),
  path: string = DEFAULT_PATH,
  now: Date = new Date(),
): void {
  // --edition OBRIGATÓRIO: é a chave do guard de idempotência (edition+source+mês).
  // Sem ele, o guard é pulado e re-rodar duplicaria a estimativa.
  const edition = getArg(argv, "edition");
  if (!edition) {
    console.error("❌ --edition AAMMDD é obrigatório (chave de idempotência).");
    process.exit(1);
  }
  const stats = computeBraveCreditStats(edition, path, now);

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
    // gap≤0 NÃO garante "tudo contado": pode significar que o último header foi
    // capturado ANTES dos agentes (Path B invisível). Mensagem honesta.
    console.error(
      `[reconcile-brave-path-b] gap=${gap} (≤0) — o último header (uso real ` +
        `${stats.effective_used}) não mostra Path B não-contado. Se a última Path A ` +
        `rodou antes dos agentes, o Path B pode estar invisível (o alerta header-direct ` +
        `cobre a segurança de qualquer forma).`,
    );
    console.log(JSON.stringify({ reconciled: 0, gap, reason: "no_gap_or_stale_header" }));
    return;
  }

  recordBraveCreditEstimate(
    { edition, source: "path-b-reconcile", count: gap },
    path,
    now,
  );
  console.error(
    `[reconcile-brave-path-b] +${gap} queries Path B reconciliadas do header ` +
      `(local ${stats.queries_this_month} → real ${stats.effective_used}). Idempotente por edição/mês.`,
  );
  console.log(JSON.stringify({ reconciled: gap, gap, edition }));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
