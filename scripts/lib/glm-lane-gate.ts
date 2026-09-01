/**
 * glm-lane-gate.ts (#6930)
 *
 * Lógica PURA/testável dos critérios de morte e do teto do piloto
 * `z-ai/glm-5.3-flash` (`docs/lane-glm.md`, normativo — leia lá as
 * condições (a)-(d) antes de mexer aqui). Este módulo só decide, a partir
 * do histórico de unidades já registrado, se o PRÓXIMO despacho pode
 * acontecer — todo I/O (ler `data/glm-lane/units.jsonl`, comparar contra
 * config) fica em `scripts/dispatch-glm-lane-unit.sh`.
 *
 * ## Critérios de morte (docs/lane-glm.md, "Teto e reversão")
 *
 * 1. **Teto de 10 unidades.** Esgotadas, o piloto acaba — continuar exige
 *    decisão nova e escrita (não é este módulo que decide "mais 10").
 * 2. **Zero PRs nos 3 primeiros despachos.** Sinal medido em #6922 (10
 *    ticks do primário mais barato → zero claims, zero PRs, relatório
 *    coerente) — o modo de falha do modelo barato em trabalho autônomo
 *    não é "erra", é "para cedo e relata bem". Só avaliável com >= 3
 *    unidades já despachadas; com menos, `firstThreeHadAnyPr` é `null`
 *    (ainda não dá pra saber) e este critério não decide nada.
 * 3. **Média de rodadas de review > 2.** Precisa de `avgReviewRounds`
 *    calculado sobre unidades cujo PR já foi revisado ao menos uma vez —
 *    `null` (sem dado ainda) nunca bloqueia.
 * 4. **`$/issue` acima do equivalente no lane Sonnet.** `null` em
 *    QUALQUER um dos dois lados (custo do GLM ainda não medido, ou
 *    baseline do Sonnet não configurada) nunca bloqueia — este critério é
 *    o único que depende de um número que o repo não coleta ainda
 *    (`docs/lane-glm.md` não define uma fonte pronta pra "$/issue do lane
 *    Sonnet"); enquanto `sonnetLaneCostPerIssueUsd` for `null`, o piloto
 *    roda sem essa comparação — decisão explícita de não INVENTAR um
 *    número de referência, ver docstring de `GlmLaneState.
 *    sonnetLaneCostPerIssueUsd` abaixo.
 *
 * Primeira condição que decide vence (mesmo padrão de
 * `continuo-merge-gate.ts`) — teto de unidades checado antes de qualquer
 * critério de morte, porque é o mais barato de avaliar e o mais
 * definitivo.
 */

export interface GlmLaneState {
  /** Quantas unidades já foram despachadas (linhas em `units.jsonl`). */
  unitsDispatched: number;
  /** Teto do piloto — `docs/lane-glm.md` diz 10; parametrizado aqui só
   *  pra não hardcodar um mágico dentro da função pura. */
  unitsCap: number;
  /** `true` = ao menos 1 PR entre as 3 primeiras unidades; `false` =
   *  nenhuma das 3 primeiras abriu PR; `null` = ainda não há 3 unidades
   *  despachadas, critério não avaliável ainda. */
  firstThreeHadAnyPr: boolean | null;
  /** Média de rodadas de review entre as unidades com PR revisado pelo
   *  menos uma vez. `null` = sem dado (nenhuma unidade revisada ainda). */
  avgReviewRounds: number | null;
  /** `$/issue` medido do lane GLM até agora. `null` = sem unidade com
   *  custo medido ainda. */
  costPerIssueUsd: number | null;
  /** Baseline de `$/issue` do lane Sonnet, pra comparação. `null` =
   *  baseline não configurada — o repo não tem hoje uma fonte única de
   *  "$/issue do lane Sonnet" (overnight/develop não emitem esse número
   *  agregado); até existir, este critério fica inerte de propósito, não
   *  aproximado por um chute. */
  sonnetLaneCostPerIssueUsd: number | null;
}

export interface GlmLaneGateVerdict {
  allow: boolean;
  reason: string;
}

export function evaluateGlmLaneGate(state: GlmLaneState): GlmLaneGateVerdict {
  if (state.unitsDispatched >= state.unitsCap) {
    return {
      allow: false,
      reason: `teto de ${state.unitsCap} unidades atingido (${state.unitsDispatched} já despachadas) — continuar exige decisão nova e escrita, não este gate`,
    };
  }

  if (state.firstThreeHadAnyPr === false) {
    return {
      allow: false,
      reason: "critério de morte: zero PRs nos 3 primeiros despachos (mesmo modo de falha medido no #6922 — para cedo e relata bem)",
    };
  }

  if (state.avgReviewRounds !== null && state.avgReviewRounds > 2) {
    return {
      allow: false,
      reason: `critério de morte: média de rodadas de review = ${state.avgReviewRounds} (> 2)`,
    };
  }

  if (state.costPerIssueUsd !== null && state.sonnetLaneCostPerIssueUsd !== null) {
    if (state.costPerIssueUsd > state.sonnetLaneCostPerIssueUsd) {
      return {
        allow: false,
        reason: `critério de morte: $/issue do GLM (${state.costPerIssueUsd}) acima do lane Sonnet (${state.sonnetLaneCostPerIssueUsd})`,
      };
    }
  }

  return { allow: true, reason: "nenhum critério de morte disparou, teto não atingido" };
}

/** Um registro de unidade já despachada, lido de `data/glm-lane/units.jsonl`. */
export interface GlmLaneUnitRecord {
  issue: number;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  /** `null` = snapshot de crédito falhou (fail-soft, nunca vira "custo
   *  zero" — ver `scripts/glm-lane-credits.ts`). */
  costUsd: number | null;
  /** número da PR aberta por esta unidade, ou `null` se nenhuma. */
  prNumber: number | null;
  /** rodadas de review já observadas nesta PR no momento em que o
   *  registro foi atualizado pela última vez, ou `null` se ainda não
   *  medido. */
  reviewRounds: number | null;
}

/**
 * Deriva `GlmLaneState` a partir dos registros já persistidos — pura,
 * sem tocar `gh`/rede. `sonnetLaneCostPerIssueUsd` é sempre repassado
 * como veio (não calculado aqui: não há fonte no repo, ver docstring do
 * campo em `GlmLaneState`).
 */
export function computeGlmLaneState(
  records: readonly GlmLaneUnitRecord[],
  opts: { unitsCap: number; sonnetLaneCostPerIssueUsd: number | null },
): GlmLaneState {
  const unitsDispatched = records.length;

  let firstThreeHadAnyPr: boolean | null = null;
  if (unitsDispatched >= 3) {
    firstThreeHadAnyPr = records.slice(0, 3).some((r) => r.prNumber !== null);
  }

  const roundsKnown = records.map((r) => r.reviewRounds).filter((r): r is number => r !== null);
  const avgReviewRounds = roundsKnown.length > 0 ? roundsKnown.reduce((a, b) => a + b, 0) / roundsKnown.length : null;

  const costsWithPr = records.filter((r) => r.prNumber !== null && r.costUsd !== null).map((r) => r.costUsd as number);
  const costPerIssueUsd =
    costsWithPr.length > 0 ? costsWithPr.reduce((a, b) => a + b, 0) / costsWithPr.length : null;

  return {
    unitsDispatched,
    unitsCap: opts.unitsCap,
    firstThreeHadAnyPr,
    avgReviewRounds,
    costPerIssueUsd,
    sonnetLaneCostPerIssueUsd: opts.sonnetLaneCostPerIssueUsd,
  };
}
