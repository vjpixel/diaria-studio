#!/usr/bin/env node
/**
 * reconcile-brave-path-b.ts (#2668 follow-up, #3122 fix)
 *
 * Reconcilia a contagem do Path B (WebSearch dos agentes de pesquisa → Brave)
 * de forma DETERMINÍSTICA, a partir do gap real do header X-RateLimit-Remaining,
 * em vez do multiplicador frágil `N*2+M+J` que o orchestrator computava à mão
 * num passo de playbook (que nunca rodou — 0 entradas estimadas em maio E junho,
 * causa do esgotamento dos $5 em jun/2026).
 *
 * ## Ancoragem incremental (#3122)
 *
 * O header `X-RateLimit-Remaining` do Brave é cumulativo pelo CICLO DE COBRANÇA
 * da conta, que NÃO é mês-calendário (provavelmente aniversário de signup). Por
 * isso, atribuir `header_absoluto - tracked_do_mês_corrente` ao mês corrente
 * (comportamento pré-#3122) dumpa TODO o residual de meses anteriores no mês
 * novo assim que ele vira — foi exatamente o que gerou o alarme falso de
 * 1951/2000 na edição 260708 (real de julho era 220; os outros 1731 eram gap
 * cumulativo de junho reatribuído a julho numa única rodada).
 *
 * O fix: em vez do gap absoluto, ancoramos no delta INCREMENTAL desde a última
 * rodada bem-sucedida do reconcile — estado persistido em
 * `data/brave-reconcile-state.json` (sobrevive à virada de mês, ao contrário dos
 * stats de `computeBraveCreditStats`, que são escopados ao mês-calendário). Cada
 * rodada grava só o que mudou no header desde a rodada anterior, e isso é
 * atribuído ao mês/edição corrente — o que é correto porque o incremento é, por
 * construção, o uso que aconteceu NO INTERVALO desde a última leitura (tipicamente
 * ~1 dia, já que o reconcile roda 1x/edição).
 *
 * Sem estado anterior (bootstrap — primeira vez que o script roda, ou sidecar
 * perdido), cai no comportamento antigo (gap vs. mês corrente) só nessa rodada —
 * mitigado pelo sanity cap abaixo.
 *
 * ## Sanity cap (#3122 fix 3, defense-in-depth)
 *
 * Independente da lógica incremental, uma ÚNICA rodada nunca injeta mais que o
 * espaço restante no free tier deste mês (`FREE_TIER_LIMIT - queries_this_month_real`)
 * — protege contra qualquer bug residual na lógica incremental (estado corrompido,
 * cycle reset mal-detectado, etc.) sem depender só do heuristic de descarte do #3002.
 * Quando o cap dispara, loga um warning bem visível — nunca falha silenciosamente.
 *
 * Como funciona: lê o counter (`computeBraveCreditStats`) e o estado do último
 * reconcile (`readBraveReconcileState`). Se o delta incremental (ou o gap de
 * bootstrap) for > 0 (após o cap), grava esse tanto de entradas `estimated:true`
 * (source `path-b-reconcile`) para o mês corrente — então `queries_this_month`
 * local passa a bater com o uso real do Brave. Idempotente (2ª rodada sem novo
 * header lido vê delta≈0 contra o estado já atualizado pela 1ª).
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
  readBraveReconcileState,
  writeBraveReconcileState,
  DEFAULT_PATH,
  DEFAULT_RECONCILE_STATE_PATH,
  FREE_TIER_LIMIT,
} from "./lib/brave-credits.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

export function main(
  argv: string[] = process.argv.slice(2),
  path: string = DEFAULT_PATH,
  now: Date = new Date(),
  statePath: string = DEFAULT_RECONCILE_STATE_PATH,
): void {
  // --edition OBRIGATÓRIO: identifica a rodada (aparece nas entradas estimated).
  const edition = getArg(argv, "edition");
  if (!edition) {
    console.error("❌ --edition AAMMDD é obrigatório (chave de idempotência).");
    process.exit(1);
  }
  const stats = computeBraveCreditStats(edition, path, now);

  // delta_untracked ausente = sem header este mês OU header descartado por
  // divergência implausível (#3002) — nada de confiável pra reconciliar.
  // real_used_raw ausente é o mesmo sinal (quota_remaining nunca lido este mês);
  // checar os dois é defensivo (mantém o gate correto se a relação entre os
  // dois campos mudar no futuro).
  if (typeof stats.delta_untracked !== "number" || typeof stats.real_used_raw !== "number") {
    console.error(
      "[reconcile-brave-path-b] sem header X-RateLimit-Remaining este mês (ou " +
        "header descartado por divergência implausível, #3002) — nada a reconciliar " +
        "(rode após ≥1 chamada Path A).",
    );
    console.log(JSON.stringify({ reconciled: 0, reason: "no_header" }));
    return;
  }

  const rawRealUsedNow = stats.real_used_raw;
  const priorState = readBraveReconcileState(statePath);

  let gap: number;
  let gapBasis: "incremental" | "month_scoped_bootstrap";
  if (priorState) {
    // (#3122) delta desde a ÚLTIMA rodada — não o absoluto vs. mês corrente.
    gap = rawRealUsedNow - priorState.real_used;
    gapBasis = "incremental";
  } else {
    // Bootstrap: sem âncora anterior. Cai no gap absoluto vs. mês corrente só
    // desta primeira vez (comportamento pré-#3122); o sanity cap abaixo evita
    // que um bootstrap numa virada de ciclo injete um valor implausível.
    gap = stats.delta_untracked;
    gapBasis = "month_scoped_bootstrap";
  }

  // Persiste o header mais recente visto — mesmo em no-op — pra próxima rodada
  // medir o incremento a partir daqui (inclusive cross-mês).
  const persistState = (): void =>
    writeBraveReconcileState(
      {
        quota_remaining: stats.quota_remaining_last_seen!,
        real_used: rawRealUsedNow,
        timestamp: now.toISOString(),
      },
      statePath,
    );

  if (gap <= 0) {
    persistState();
    console.error(
      `[reconcile-brave-path-b] gap=${gap} (<=0, base=${gapBasis}) — nada de novo desde a ` +
        `última leitura do header (real bruto ${rawRealUsedNow}).`,
    );
    console.log(JSON.stringify({ reconciled: 0, gap, gap_basis: gapBasis, reason: "no_gap_or_stale_header" }));
    return;
  }

  // (#3122 fix 3) Sanity cap: uma única rodada nunca injeta mais que o espaço
  // livre no free tier deste mês, mesmo que o gap calculado seja maior (defense-
  // in-depth contra bug residual na lógica incremental).
  const cap = Math.max(0, FREE_TIER_LIMIT - stats.queries_this_month_real);
  let injected = gap;
  let capped = false;
  if (injected > cap) {
    capped = true;
    console.error(
      `🚨 [reconcile-brave-path-b] SANITY CAP disparado: gap calculado (${gap}, base=${gapBasis}) ` +
        `excede o espaço livre do free tier este mês (${cap} = ${FREE_TIER_LIMIT} - ` +
        `${stats.queries_this_month_real} reais). Injetando ${cap} em vez de ${gap} — ` +
        `INVESTIGAR (estado de reconcile corrompido? cycle reset não detectado?).`,
    );
    injected = cap;
  }

  recordBraveCreditEstimate({ edition, source: "path-b-reconcile", count: injected }, path, now);
  persistState();
  console.error(
    `[reconcile-brave-path-b] +${injected} queries Path B reconciliadas (base=${gapBasis}` +
      `${capped ? ", CAPPED" : ""}) do header (local ${stats.queries_this_month} → real bruto ${rawRealUsedNow}).`,
  );
  console.log(JSON.stringify({ reconciled: injected, gap, gap_basis: gapBasis, capped, edition }));
}

if (isMainModule(import.meta.url)) {
  main();
}
