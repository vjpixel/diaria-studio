/**
 * scripts/lib/ads-window-context.ts (#8246)
 *
 * Contexto de janela do teste 2608, pronto pra um relatório consumir sem
 * refazer a aritmética em prosa: janela encerrada sim/não, coorte madura
 * sim/não, gasto esperado por braço até ontem.
 *
 * ## Por que este módulo existe
 *
 * A task local `relatorio-diario-teste-2608` (fora do repo, #8246) tinha
 * essas 3 perguntas respondidas em PROSA — datas copiadas do `run-state.json`
 * na hora em que o SKILL.md foi escrito, que ficaram velhas assim que o
 * arquivo foi revisado de novo (pausa 09/09→17/09, `fim_janela` mudou de
 * 19/09 pra 27/09) sem que a prosa acompanhasse. `ads-rolling-cac.ts --json`
 * já expõe o CAC da janela móvel; faltava só isto — o "onde estamos no
 * calendário do teste" — pra a task local não precisar mais interpretar
 * `run-state.json` por conta própria.
 *
 * ## Sem cálculo paralelo
 *
 * `gastoEsperadoAteOntemPorBraco` reusa `plannedBudgetBRL`
 * (`ads-test-pause-window.ts`, #8240/#8241) — o único lugar que sabe
 * integrar orçamento diário vigente por braço sobre dias de VEICULAÇÃO
 * (descontando pausa). Este módulo não soma dia nenhum sozinho.
 */
import { addDays, type DateOnlyString } from "./ads-test-schedule.ts";
import { plannedBudgetBRL, type AdsTestBudgetPeriod, type AdsTestPauseInterval } from "./ads-test-pause-window.ts";

/** Campos de `run-state.json` que este módulo lê — subconjunto estrutural de
 *  `AdsTestRunState` (`ads-test-run-state.ts`) + `AdsTestRunStateWithPause`
 *  (`ads-test-pause-window.ts`), nunca um tipo paralelo. */
export interface AdsWindowContextRunState {
  d0?: string;
  fim_janela?: string;
  coorte_madura?: string;
  orcamento_diario_brl?: Record<string, readonly AdsTestBudgetPeriod[]>;
}

export interface AdsWindowContext {
  hoje: DateOnlyString;
  /** `null` quando `run-state.json` está ausente/sem `d0`/`fim_janela` —
   *  "não sei", nunca inferido de outra fonte. */
  d0: DateOnlyString | null;
  fimJanela: DateOnlyString | null;
  /** `hoje > fimJanela`. `null` = não sabemos (sem run-state válido). */
  janelaEncerrada: boolean | null;
  coorteMadura: DateOnlyString | null;
  /** `hoje >= coorteMadura`. `null` = não sabemos. */
  coorteAtingida: boolean | null;
  /**
   * Gasto PLANEJADO acumulado de `d0` até ONTEM (o último dia fechado —
   * mesma convenção de `ads-rolling-cac.ts`), por braço, descontando pausa
   * e usando o diário vigente de cada braço. `null` no objeto todo quando
   * não há `d0`/`fim_janela` conhecidos; um braço específico sempre tem
   * entrada (0 se `hoje` ainda é `<= d0`, isto é, o teste ainda não
   * começou a acumular gasto esperado).
   */
  gastoEsperadoAteOntemPorBraco: Record<string, number> | null;
}

/**
 * @pure
 */
export function computeAdsWindowContext(
  runState: AdsWindowContextRunState | null | undefined,
  bracos: readonly string[],
  pauseIntervals: readonly AdsTestPauseInterval[],
  hoje: DateOnlyString,
  defaultDailyBudgetBRL: number,
): AdsWindowContext {
  if (!runState?.d0 || !runState?.fim_janela) {
    return {
      hoje,
      d0: null,
      fimJanela: null,
      janelaEncerrada: null,
      coorteMadura: null,
      coorteAtingida: null,
      gastoEsperadoAteOntemPorBraco: null,
    };
  }
  const { d0, fim_janela: fimJanela } = runState;
  const ontem = addDays(hoje, -1);
  // Ontem antes de d0: o teste ainda não começou a acumular gasto esperado
  // — 0 é o valor certo, não "não sei" (diferente do caso sem run-state
  // acima, que É "não sei").
  // Ontem depois de fim_janela: o planejado trava no fim da janela — dias
  // além dela não somam mais orçamento planejado.
  const throughDate: DateOnlyString | null = ontem < d0 ? null : ontem > fimJanela ? fimJanela : ontem;

  const gastoEsperadoAteOntemPorBraco: Record<string, number> = {};
  for (const braco of bracos) {
    gastoEsperadoAteOntemPorBraco[braco] =
      throughDate == null
        ? 0
        : plannedBudgetBRL(d0, throughDate, runState.orcamento_diario_brl?.[braco], pauseIntervals, defaultDailyBudgetBRL);
  }

  return {
    hoje,
    d0,
    fimJanela,
    janelaEncerrada: hoje > fimJanela,
    coorteMadura: runState.coorte_madura ?? null,
    coorteAtingida: runState.coorte_madura != null ? hoje >= runState.coorte_madura : null,
    gastoEsperadoAteOntemPorBraco,
  };
}
