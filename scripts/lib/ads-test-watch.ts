/**
 * scripts/lib/ads-test-watch.ts (#5845)
 *
 * Lógica PURA da task diária `Diaria-Ads-Test-Watch` — cobra sozinha os
 * marcos do ciclo de vida do teste de 3 canais pagos (#5524) que hoje
 * dependem 100% da memória do editor (`data/aquisicao/campanhas-260816/00-PROTOCOLO.md`
 * §7.1/§7.2/§8.3). I/O (leitura de `run-state.json`/`clicks-2608.csv`,
 * envio de e-mail, invocação de `build-origem-map.ts`+`cac-report.ts`) mora
 * em `scripts/ads-test-watch.ts` — este arquivo só decide.
 *
 * ## As 5 checagens diárias (independentes, não mutuamente exclusivas)
 *
 * `planAdsTestWatchActions` decide, pra cada dia, quais das 5 ações abaixo
 * são cabíveis HOJE — várias podem coexistir (ex: se a task ficou parada
 * dias, religar-brevo e apuração podem estar ambas atrasadas no mesmo run):
 *
 * 1. `alarmMissingD0Overdue` — D0 planejado já passou e ninguém rodou
 *    `ads-test-d0.ts` ainda.
 * 2. `checkClicksCoverage` — dentro da janela: falta linha de ONTEM em
 *    `clicks-2608.csv` pra algum dos 3 braços?
 * 3. `checkDeathConditions` — dentro da janela: alguma condição de morte da
 *    §3.2 disparou (aqui, só o item 3, "gasto acumulado > 2× o planejado",
 *    que é o único verificável a partir da série de `clicks-2608.csv" — os
 *    outros dois, reprovação de política e limite de conta, exigem
 *    julgamento humano do painel)?
 * 4. `triggerReligarBrevo` — D+21 chegou e o religamento ainda não foi
 *    disparado (idempotente — 1x só, `AdsTestWatchState.religarBrevoTriggeredAt`).
 * 5. `runApuracao` — a data de apuração pré-registrada chegou e a apuração
 *    ainda não rodou (idempotente — 1x só, `AdsTestWatchState.apuracaoCompletedAt`
 *    — re-rodar sobrescreveria o relatório congelado, §7.2).
 *
 * ## Idempotência assimétrica (#5845 item 3)
 *
 * `triggerReligarBrevo`/`runApuracao` são eventos de UMA VEZ — repetir
 * geraria ruído (religar 2×) ou dano real (sobrescrever o relatório
 * congelado). `alarmMissingD0Overdue`/`checkClicksCoverage`/
 * `checkDeathConditions` são, de propósito, o OPOSTO: repetem TODO dia
 * enquanto a condição continuar verdadeira — dinheiro real em jogo (achado
 * faltando reconciliação ou condição de morte tem custo assimétrico de
 * esquecer, ver corpo da issue). Por isso `AdsTestWatchState` só persiste
 * os dois primeiros; os três "repeat" não têm cursor de idempotência
 * nenhum — o caller (I/O) os reavalia do zero a cada execução.
 */

import Papa from "papaparse";
import { addDays, daysBetween, type DateOnlyString } from "./ads-test-schedule.ts";
import type { AdsTestRunState } from "./ads-test-run-state.ts";
import { plannedBudgetBRL, type AdsTestBudgetPeriod, type AdsTestPauseInterval } from "./ads-test-pause-window.ts";
import type { CacReport, CacRow } from "./cac.ts";

// ---------------------------------------------------------------------------
// Plano diário
// ---------------------------------------------------------------------------

/** Estado persistido (`data/aquisicao/teste-2608/watch-state.json`) — só os
 *  2 marcos de UMA VEZ. Ver docstring do módulo pra por que os demais não
 *  entram aqui. */
export interface AdsTestWatchState {
  religarBrevoTriggeredAt: string | null;
  apuracaoCompletedAt: string | null;
  apuracaoReportPath: string | null;
}

export function emptyAdsTestWatchState(): AdsTestWatchState {
  return { religarBrevoTriggeredAt: null, apuracaoCompletedAt: null, apuracaoReportPath: null };
}

export interface AdsTestWatchPlan {
  alarmMissingD0Overdue: boolean;
  checkClicksCoverage: boolean;
  checkDeathConditions: boolean;
  triggerReligarBrevo: boolean;
  runApuracao: boolean;
}

/**
 * Decide o plano de ações do dia. `plannedD0` é a data que o
 * `00-PROTOCOLO.md` recomenda pro acendimento (documentada em prosa, não
 * derivada de `run-state.json` — é justamente o caso "ninguém registrou
 * ainda" que este campo cobre); passe `null` quando não houver nenhuma data
 * planejada conhecida (o caller então nunca alarma `alarmMissingD0Overdue`).
 *
 * `brevoTaskEnabled` (#8853) — estado ATUAL da task `Diaria-Brevo-Diaria-Evaluate`
 * em `scripts/lib/scheduled-tasks.ts` (`true` = `enabled` — ausência do campo
 * conta como `true`, ver `getScheduledTaskByName(...)?.enabled !== false` no
 * caller; `false` = task desarmada de propósito, `enabled: false`). `null` =
 * indeterminado (falha ao ler o registro) — fail-safe: continua disparando o
 * alarme, melhor ruído a mais do que perder um religamento de verdade. Caso
 * real que motivou (#8851): a task já estava religada desde 21/08 (#5838) e o
 * alarme disparou mesmo assim, porque só olhava a DATA, nunca o estado real
 * da task.
 *
 * @pure
 */
export function planAdsTestWatchActions(
  nowDateStr: DateOnlyString,
  runState: AdsTestRunState | null,
  plannedD0: DateOnlyString | null,
  watchState: AdsTestWatchState,
  brevoTaskEnabled: boolean | null = null,
): AdsTestWatchPlan {
  if (runState == null) {
    return {
      alarmMissingD0Overdue: plannedD0 != null && nowDateStr > plannedD0,
      checkClicksCoverage: false,
      checkDeathConditions: false,
      triggerReligarBrevo: false,
      runApuracao: false,
    };
  }
  const withinWindow = runState.d0 <= nowDateStr && nowDateStr <= runState.fim_janela;
  // `checkClicksCoverage` audita a linha de ONTEM (ver scripts/ads-test-watch.ts),
  // não a de hoje — por isso o gate dela é sobre `nowDateStr - 1`, não sobre
  // `nowDateStr` (que é o que `withinWindow` mede). Usar `withinWindow` direto
  // aqui tem 2 bugs simétricos (#5845 self-review, findings 1/2):
  //   1. no D0 exato, "ontem" é D0-1 — antes da campanha existir, nenhuma
  //      linha pode existir ainda, e o alarme de cobertura falso-dispara
  //      garantido todo D0.
  //   2. o ÚLTIMO dia da janela (fim_janela) nunca seria auditado, porque
  //      checá-lo exige rodar em fim_janela+1, que já é `nowDateStr >
  //      fim_janela` (fora de `withinWindow`).
  // Gate correto, independente do de `checkDeathConditions`: "ontem" cai
  // dentro de [d0, fim_janela] — cobre exatamente cada dia da janela, uma
  // vez, no dia seguinte.
  const yesterday = addDays(nowDateStr, -1);
  const coverageDateInRange = runState.d0 <= yesterday && yesterday <= runState.fim_janela;
  return {
    alarmMissingD0Overdue: false,
    checkClicksCoverage: coverageDateInRange,
    checkDeathConditions: withinWindow,
    triggerReligarBrevo:
      nowDateStr >= runState.religar_brevo && watchState.religarBrevoTriggeredAt == null && brevoTaskEnabled !== true,
    runApuracao: nowDateStr >= runState.apuracao_snapshot && watchState.apuracaoCompletedAt == null,
  };
}

export function markReligarBrevoTriggered(state: AdsTestWatchState, nowIso: string): AdsTestWatchState {
  return { ...state, religarBrevoTriggeredAt: nowIso };
}

export function markApuracaoCompleted(state: AdsTestWatchState, nowIso: string, reportPath: string): AdsTestWatchState {
  return { ...state, apuracaoCompletedAt: nowIso, apuracaoReportPath: reportPath };
}

// ---------------------------------------------------------------------------
// clicks-2608.csv — parse + cobertura + condição de morte (§3.2 item 3)
// ---------------------------------------------------------------------------

export interface ClicksCsvRow {
  canal: string;
  data_apuracao: DateOnlyString;
  gasto_acumulado: number;
  /** #5239 — coluna OPCIONAL (`leitores_acumulado`), leitores-v1
   *  (`scripts/lib/leitor.ts`) atribuídos a este braço até esta data,
   *  cruzados manualmente pelo editor contra `cac-report.ts` (mesma
   *  disciplina de reconciliação manual de `gasto_acumulado`, §8.3).
   *  `null` quando a coluna está ausente do header OU vazia nesta linha —
   *  nunca um erro (a linha continua válida pra `gasto_acumulado`/cobertura;
   *  só fica sem amostra pro kill switch até o editor preencher). Coluna
   *  presente mas com valor não-numérico/negativo É erro (mesma disciplina
   *  das demais colunas numéricas). Campo OPCIONAL no tipo (não só no CSV) —
   *  objetos construídos à mão (testes, código pré-#5239) continuam
   *  válidos sem precisar declarar este campo; `undefined` e `null` são
   *  tratados de forma idêntica por `buildArmCostSamplesFromRows`
   *  (`scripts/lib/ads-kill-switch.ts`). */
  leitoresAcumulado?: number | null;
  /** #7577 — coluna OPCIONAL (`cadastros_acumulado`), cadastros atribuídos a
   *  este braço até esta data (Kit, campo personalizado `utm_source`). Mesma
   *  disciplina de `leitoresAcumulado` acima: `null` quando ausente do header
   *  OU vazia na linha (nunca erro); presente com valor não-numérico/negativo
   *  É erro. É o numerador do CAC da janela móvel de 3 dias
   *  (`scripts/lib/ads-rolling-window.ts`) — antes do #7577 nada parseava esta
   *  coluna, embora ela exista no CSV desde o começo do teste. */
  cadastrosAcumulado?: number | null;
}

export interface ClicksCsvRowError {
  line: number;
  reason: string;
}

export interface ClicksCsvParseResult {
  rows: ClicksCsvRow[];
  errors: ClicksCsvRowError[];
}

/**
 * Parse tolerante-mas-barulhento de `clicks-2608.csv` (mesma disciplina de
 * `aquisicao-spend.ts`): header faltando lança (arquivo inválido inteiro);
 * célula vazia/inválida numa linha específica exclui só aquela linha,
 * registrada em `errors`, nunca coagida a `0`/`""` silencioso.
 *
 * @pure
 */
export function parseClicksCsv(content: string): ClicksCsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];
  const missingHeaders = (["canal", "data_apuracao", "gasto_acumulado"] as const).filter((h) => !fields.includes(h));
  if (missingHeaders.length > 0) {
    throw new Error(
      `[clicks-2608.csv] coluna(s) obrigatória(s) ausente(s) no header: ${missingHeaders.join(", ")}. ` +
        `Esperado (mínimo): canal,data_apuracao,gasto_acumulado. Encontrado: ${fields.length > 0 ? fields.join(",") : "(vazio)"}.`,
    );
  }

  const rows: ClicksCsvRow[] = [];
  const errors: ClicksCsvRowError[] = [];
  parsed.data.forEach((raw, idx) => {
    const line = idx + 2;
    const canal = (raw.canal ?? "").trim();
    const data_apuracao = (raw.data_apuracao ?? "").trim();
    const gastoRaw = (raw.gasto_acumulado ?? "").trim();
    if (!canal || !data_apuracao || !gastoRaw) {
      errors.push({ line, reason: `campo(s) obrigatório(s) vazio(s) (canal/data_apuracao/gasto_acumulado)` });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_apuracao)) {
      errors.push({ line, reason: `"data_apuracao" não é YYYY-MM-DD: "${data_apuracao}"` });
      return;
    }
    const gasto_acumulado = Number(gastoRaw);
    if (!Number.isFinite(gasto_acumulado) || gasto_acumulado < 0) {
      errors.push({ line, reason: `"gasto_acumulado" não é um número não-negativo válido: "${gastoRaw}"` });
      return;
    }
    // #5239 — coluna OPCIONAL: ausente do header OU vazia nesta linha ->
    // `null` (sem amostra pro kill switch ainda, nunca um erro da linha
    // inteira). Presente E não-vazia -> valida como as demais colunas
    // numéricas (não-numérico/negativo É erro, nunca coagido em silêncio).
    let leitoresAcumulado: number | null = null;
    const leitoresRaw = (raw.leitores_acumulado ?? "").trim();
    if (leitoresRaw !== "") {
      const parsedLeitores = Number(leitoresRaw);
      if (!Number.isFinite(parsedLeitores) || parsedLeitores < 0) {
        errors.push({ line, reason: `"leitores_acumulado" não é um número não-negativo válido: "${leitoresRaw}"` });
        return;
      }
      leitoresAcumulado = parsedLeitores;
    }
    // #7577: mesma disciplina da coluna acima — vazia é `null` (sem amostra),
    // presente e inválida é erro da linha.
    let cadastrosAcumulado: number | null = null;
    const cadastrosRaw = (raw.cadastros_acumulado ?? "").trim();
    if (cadastrosRaw !== "") {
      const parsedCadastros = Number(cadastrosRaw);
      if (!Number.isFinite(parsedCadastros) || parsedCadastros < 0) {
        errors.push({ line, reason: `"cadastros_acumulado" não é um número não-negativo válido: "${cadastrosRaw}"` });
        return;
      }
      cadastrosAcumulado = parsedCadastros;
    }
    rows.push({ canal, data_apuracao, gasto_acumulado, leitoresAcumulado, cadastrosAcumulado });
  });
  return { rows, errors };
}

/** Braços SEM nenhuma linha em `dateStr` (§8.3 — cobrança obrigatória
 *  diária). Retorna a sublista de `bracos` faltante, na mesma ordem. */
export function findMissingClicksBracosForDate(
  rows: readonly ClicksCsvRow[],
  bracos: readonly string[],
  dateStr: DateOnlyString,
): string[] {
  const present = new Set(rows.filter((r) => r.data_apuracao === dateStr).map((r) => r.canal));
  return bracos.filter((b) => !present.has(b));
}

export interface SpendOverageFinding {
  braco: string;
  /** Linha mais recente conhecida (`data_apuracao`) usada pra checar. */
  lastKnownDate: DateOnlyString;
  gastoAcumulado: number;
  plannedCumulativeBRL: number;
  ratio: number;
}

/** Opções de {@link evaluateSpendOverageDeathCondition}/
 *  {@link evaluateSpendWarning} — pausa (#8240 item 1) e diário vigente por
 *  braço (#8240 item 3), ambas OPCIONAIS: omitidas, o comportamento é
 *  idêntico ao pré-#8240 (planejado = diário fixo × dias de CALENDÁRIO,
 *  sem desconto de pausa) — é o que mantém os testes de regressão do #5845
 *  passando sem mudança. */
export interface SpendOverageEvalOptions {
  pauseIntervals?: readonly AdsTestPauseInterval[];
  /** Braço ausente do mapa usa `plannedDailyBudgetBRL` (o default) —
   *  mesma semântica de `dailyBudgetForDate` em `ads-test-pause-window.ts`. */
  budgetScheduleByBraco?: Readonly<Record<string, readonly AdsTestBudgetPeriod[]>>;
}

/**
 * §3.2 item 3 — "cobrança acima do nominal: gasto acumulado > 2× o
 * planejado do período". Pra cada braço, usa a linha mais recente conhecida
 * (`data_apuracao` mais próxima de `todayDateStr`, sem ultrapassá-lo) e
 * compara `gasto_acumulado` contra 2× o planejado acumulado desde D0 até
 * aquela data (inclusive). Braço sem nenhuma linha ainda não entra na lista
 * (nada a avaliar — vira achado de cobertura faltante, não de morte).
 *
 * O planejado é `plannedBudgetBRL` (`ads-test-pause-window.ts`) — dias de
 * VEICULAÇÃO (não calendário, `opts.pauseIntervals`) × diário VIGENTE por
 * braço (`opts.budgetScheduleByBraco`, com histórico de vigência — #8240
 * item 3). `plannedDailyBudgetBRL` continua sendo o default pra braço sem
 * schedule declarado E o multiplicador quando `opts` é omitido inteiro —
 * o número em si é decisão de negócio (`00-PROTOCOLO.md` §"Orçamento do 1º
 * mês", R$ 100/dia por braço na revisão de 18/08/2026) e pode mudar sem
 * exigir mudança de código.
 *
 * @pure
 */
export function evaluateSpendOverageDeathCondition(
  rows: readonly ClicksCsvRow[],
  bracos: readonly string[],
  d0: DateOnlyString,
  todayDateStr: DateOnlyString,
  plannedDailyBudgetBRL: number,
  opts: SpendOverageEvalOptions = {},
): SpendOverageFinding[] {
  const findings: SpendOverageFinding[] = [];
  for (const braco of bracos) {
    const candidateRows = rows.filter((r) => r.canal === braco && r.data_apuracao <= todayDateStr);
    if (candidateRows.length === 0) continue;
    const latest = candidateRows.reduce((a, b) => (a.data_apuracao >= b.data_apuracao ? a : b));
    const plannedCumulativeBRL = plannedBudgetBRL(
      d0,
      latest.data_apuracao,
      opts.budgetScheduleByBraco?.[braco],
      opts.pauseIntervals ?? [],
      plannedDailyBudgetBRL,
    );
    const threshold = 2 * plannedCumulativeBRL;
    if (latest.gasto_acumulado > threshold) {
      findings.push({
        braco,
        lastKnownDate: latest.data_apuracao,
        gastoAcumulado: latest.gasto_acumulado,
        plannedCumulativeBRL,
        ratio: latest.gasto_acumulado / plannedCumulativeBRL,
      });
    }
  }
  return findings;
}

/** Limiar de AVISO (#8240 item 4) — abaixo da condição de morte (2×), mas
 *  alto o suficiente pra não disparar em ruído do dia a dia. Decisão desta
 *  issue, não do `00-PROTOCOLO.md` (que só define o limiar de morte). */
export const SPEND_WARNING_RATIO_THRESHOLD = 1.25;

/**
 * Aviso SEM efeito de morte (#8240 item 4) — mesmo cálculo de planejado de
 * {@link evaluateSpendOverageDeathCondition}, mas o intervalo é
 * `[SPEND_WARNING_RATIO_THRESHOLD, 2]` (INCLUSIVO nas duas pontas — ratio
 * exatamente `2` entra aqui, nunca na condição de morte, que só dispara
 * acima de `2×` estrito; um braço abaixo do limiar de aviso não gera nada).
 * Um braço que já cruzou a morte (`> 2×`) só
 * aparece em {@link evaluateSpendOverageDeathCondition} — reportá-lo nas
 * duas listas duplicaria a mesma informação com urgências diferentes.
 *
 * @pure
 */
export function evaluateSpendWarning(
  rows: readonly ClicksCsvRow[],
  bracos: readonly string[],
  d0: DateOnlyString,
  todayDateStr: DateOnlyString,
  plannedDailyBudgetBRL: number,
  opts: SpendOverageEvalOptions = {},
): SpendOverageFinding[] {
  const findings: SpendOverageFinding[] = [];
  for (const braco of bracos) {
    const candidateRows = rows.filter((r) => r.canal === braco && r.data_apuracao <= todayDateStr);
    if (candidateRows.length === 0) continue;
    const latest = candidateRows.reduce((a, b) => (a.data_apuracao >= b.data_apuracao ? a : b));
    const plannedCumulativeBRL = plannedBudgetBRL(
      d0,
      latest.data_apuracao,
      opts.budgetScheduleByBraco?.[braco],
      opts.pauseIntervals ?? [],
      plannedDailyBudgetBRL,
    );
    if (plannedCumulativeBRL <= 0) continue;
    const ratio = latest.gasto_acumulado / plannedCumulativeBRL;
    if (ratio >= SPEND_WARNING_RATIO_THRESHOLD && ratio <= 2) {
      findings.push({ braco, lastKnownDate: latest.data_apuracao, gastoAcumulado: latest.gasto_acumulado, plannedCumulativeBRL, ratio });
    }
  }
  return findings;
}

export interface BudgetCrossingProjection {
  braco: string;
  /** Data (BRT) em que o acumulado projetado cruza `nominalTotalBRL`. */
  crossesOn: DateOnlyString;
  fimJanela: DateOnlyString;
  nominalTotalBRL: number;
  /** Ritmo diário usado na projeção — média dos últimos deltas fechados
   *  conhecidos, ou o diário vigente quando não há deltas (braço parado/
   *  recém-retomado). */
  ritmoUsadoBRL: number;
}

/**
 * Projeta se `braco` cruza `nominalTotalBRL` (entrega nominal do braço,
 * ex: R$ 1.500) ANTES de `fimJanela` — aviso sem efeito de morte (#8240
 * item 4, 2º ponto). `null` quando: braço sem nenhuma linha; braço já
 * cruzou (não é mais "projeção", é fato corrente — cabe às funções acima);
 * ritmo não-positivo (nunca cruza); ou o cruzamento só aconteceria depois
 * de `fimJanela`.
 *
 * Ritmo: média dos últimos até 3 deltas dia-a-dia FECHADOS e não-negativos
 * (um acumulado que caiu é dado inconsistente, mesma disciplina de
 * `ads-rolling-window.ts` — não entra na média). Sem nenhum delta assim
 * (braço pausado a série inteira, ou só 1 linha conhecida), cai no
 * `ritmoFallbackBRL` do caller — tipicamente o diário vigente do braço em
 * `todayDateStr`.
 *
 * @pure
 */
export function projectBudgetCrossing(
  rows: readonly ClicksCsvRow[],
  braco: string,
  todayDateStr: DateOnlyString,
  fimJanela: DateOnlyString,
  nominalTotalBRL: number,
  ritmoFallbackBRL: number,
): BudgetCrossingProjection | null {
  const bracoRows = rows
    .filter((r) => r.canal === braco && r.data_apuracao <= todayDateStr)
    .sort((a, b) => a.data_apuracao.localeCompare(b.data_apuracao));
  if (bracoRows.length === 0) return null;
  const latest = bracoRows[bracoRows.length - 1];
  if (latest.gasto_acumulado > nominalTotalBRL) return null;

  // Normalizado por dia de CALENDÁRIO entre as duas linhas — `rows` é uma
  // série de reconciliação manual que pode ficar parada vários dias (fonte
  // automática do #8240 item 3 resolve isso numa linha só quando o CSV tem
  // baseline, mas o CSV cru continua podendo ter saltos). Sem dividir por
  // `daysBetween`, um salto de 4 dias de gasto num delta só inflava o ritmo
  // ~4× e antecipava falsamente o aviso de cruzamento (#8262 review, achado 3).
  const closedDeltas: number[] = [];
  for (let i = bracoRows.length - 1; i > 0 && closedDeltas.length < 3; i--) {
    const delta = bracoRows[i].gasto_acumulado - bracoRows[i - 1].gasto_acumulado;
    const dias = Math.max(1, daysBetween(bracoRows[i - 1].data_apuracao, bracoRows[i].data_apuracao));
    if (delta >= 0) closedDeltas.push(delta / dias);
  }
  const ritmo = closedDeltas.length > 0 ? closedDeltas.reduce((a, b) => a + b, 0) / closedDeltas.length : ritmoFallbackBRL;
  if (ritmo <= 0) return null;

  let acumulado = latest.gasto_acumulado;
  let d = latest.data_apuracao;
  while (acumulado <= nominalTotalBRL) {
    if (d >= fimJanela) return null;
    d = addDays(d, 1);
    acumulado += ritmo;
  }
  return { braco, crossesOn: d, fimJanela, nominalTotalBRL, ritmoUsadoBRL: ritmo };
}

// ---------------------------------------------------------------------------
// Fonte de gasto pós-CSV (#8240 item 3) — a fonte automática (ver
// `scripts/lib/ads-campaign-economics-fetch.ts`) COMPLEMENTA o baseline
// manual do CSV, nunca o substitui: sem nenhuma linha no CSV ainda, não há
// baseline pra complementar. As duas fontes nunca são somadas em cima uma
// da outra — a automática só entra nos dias DEPOIS da última linha do CSV.
// ---------------------------------------------------------------------------

export interface ArmSpendResolution {
  gastoAcumulado: number;
  lastKnownDate: DateOnlyString;
  /** `null` quando a fonte automática cobriu todo o intervalo desde a
   *  última linha do CSV. Presente quando caiu total ou parcialmente no
   *  fallback manual — o texto nomeia a última data confiável (§ critério
   *  de aceite #8240 item 3: rótulo "fonte manual, até DD/MM"). */
  label: string | null;
}

/**
 * Resolve o gasto acumulado de `braco` até `todayDateStr`, complementando
 * o CSV com `autoDailySpend` (dia -> gasto DAQUELE dia, já filtrado pro
 * braço — o shape de `ChannelDailyMetric.gastoBrl` de
 * `ads-campaign-economics-fetch.ts`) pros dias FECHADOS depois da última
 * linha do CSV. `autoDailySpend: null` = fonte automática indisponível
 * (credencial ausente, erro de rede) — cai inteiro no CSV, rotulado.
 *
 * @pure
 */
export function resolveArmSpend(
  braco: string,
  rows: readonly ClicksCsvRow[],
  todayDateStr: DateOnlyString,
  autoDailySpend: ReadonlyMap<DateOnlyString, number> | null,
): ArmSpendResolution {
  const bracoRows = rows
    .filter((r) => r.canal === braco && r.data_apuracao <= todayDateStr)
    .sort((a, b) => a.data_apuracao.localeCompare(b.data_apuracao));
  const lastCsv = bracoRows.length > 0 ? bracoRows[bracoRows.length - 1] : null;

  if (!lastCsv) {
    // Sem baseline: a fonte automática não tem o que complementar (ver
    // docstring do módulo) — nem tentamos, senão o "acumulado" reportado
    // seria só o incremento automático, subestimando o total real.
    return { gastoAcumulado: 0, lastKnownDate: todayDateStr, label: "sem linha de base no CSV — fonte automática não pode complementar" };
  }
  if (!autoDailySpend) {
    return { gastoAcumulado: lastCsv.gasto_acumulado, lastKnownDate: lastCsv.data_apuracao, label: `fonte manual, até ${lastCsv.data_apuracao}` };
  }

  let acumulado = lastCsv.gasto_acumulado;
  let lastKnownDate = lastCsv.data_apuracao;
  let anyAuto = false;
  // Datas dentro do intervalo SEM valor automático — inclui tanto um buraco
  // no MEIO do range (dia sem dado entre dois dias com dado) quanto uma
  // lacuna no FINAL (API ainda não publicou o dia mais recente). Um buraco
  // no meio contribui 0 pro acumulado mas NÃO deve virar "fonte automática
  // completa, sem ressalva" — subestimaria `gasto_acumulado` sem avisar
  // (#8262 review, achado 4).
  const missingDates: DateOnlyString[] = [];
  let d = addDays(lastCsv.data_apuracao, 1);
  while (d <= todayDateStr) {
    const v = autoDailySpend.get(d);
    if (v != null) {
      acumulado += v;
      lastKnownDate = d;
      anyAuto = true;
    } else {
      missingDates.push(d);
    }
    d = addDays(d, 1);
  }
  let label: string | null;
  if (!anyAuto) {
    label = `fonte manual, até ${lastCsv.data_apuracao}`;
  } else if (missingDates.length > 0) {
    label = `automático com lacuna em ${missingDates.join(", ")}`;
  } else {
    label = null;
  }
  return { gastoAcumulado: acumulado, lastKnownDate, label };
}

/** Orçamento diário planejado por braço, R$ (§"Orçamento do 1º mês",
 *  18/08/2026 — os 3 braços do teste 2608 têm o mesmo diário nominal).
 *  Override via `--planned-daily-budget` no script CLI se o valor de
 *  negócio mudar antes do código ser atualizado. */
export const DEFAULT_PLANNED_DAILY_BUDGET_BRL = 100;

/** Entrega nominal por braço, R$ (`00-PROTOCOLO.md` §"Paridade é por
 *  ENTREGA" — R$ 1.500/braço na janela de 15 dias, R$ 100/dia × 15). Usado
 *  só por {@link projectBudgetCrossing} (#8240 item 4, 2º aviso) — a
 *  condição de morte em si (§3.2 item 3) nunca compara contra este valor,
 *  só contra 2× o planejado do período. */
export const DEFAULT_NOMINAL_ARM_BUDGET_BRL = 1500;

/**
 * Seção de texto (linhas prontas, sem e-mail próprio — #8240 item 4: "o
 * aviso e a projeção não criam e-mail novo") pros avisos de gasto e
 * projeções de cruzamento do teste 2608. Consumida por `ads-test-watch.ts`
 * (console/`--dry-run`) e, no digest diário (`ads-daily-digest.ts`), como
 * mais uma seção do e-mail que já sai todo dia — nunca as duas juntas
 * disparando alarme separado. Vazio (`[]`) quando não há nada a dizer.
 *
 * @pure
 */
export function buildSpendWatchDigestSection(
  warnings: readonly SpendOverageFinding[],
  projections: readonly BudgetCrossingProjection[],
): string[] {
  if (warnings.length === 0 && projections.length === 0) return [];
  const lines: string[] = ["Teste 2608 — avisos de gasto (sem efeito de morte):"];
  for (const w of warnings) {
    lines.push(
      `  - ${w.braco}: R$ ${w.gastoAcumulado.toFixed(2)} acumulado até ${w.lastKnownDate} ` +
        `(planejado: R$ ${w.plannedCumulativeBRL.toFixed(2)}, razão ${w.ratio.toFixed(2)}×) — acima de ${SPEND_WARNING_RATIO_THRESHOLD}×.`,
    );
  }
  for (const p of projections) {
    lines.push(
      `  - ${p.braco}: cruza R$ ${p.nominalTotalBRL.toFixed(2)} em ${p.crossesOn}, antes do fim da janela (${p.fimJanela}) ` +
        `— ritmo projetado R$ ${p.ritmoUsadoBRL.toFixed(2)}/dia.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------------

export function buildMissingD0OverdueEmail(plannedD0: DateOnlyString, nowDateStr: DateOnlyString): { subject: string; body: string } {
  return {
    subject: `⚠️ Teste 2608: D0 planejado (${plannedD0}) já passou sem registro`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `A data planejada de acendimento (${plannedD0}) já passou (hoje: ${nowDateStr}) e ninguém rodou`,
      `\`npx tsx scripts/ads-test-d0.ts --d0 AAAA-MM-DD\` ainda.`,
      "",
      "Se o teste já acendeu numa data diferente da planejada, rode o comando acima com a data REAL — o",
      "pré-registro precisa existir antes de qualquer reconciliação diária ser cobrada (00-PROTOCOLO.md §7.1).",
      "Se o teste ainda não vai acender, ignore este e-mail (ele repete todo dia até o registro existir).",
    ].join("\n"),
  };
}

export function buildMissingClicksCoverageEmail(missingBracos: readonly string[], dateStr: DateOnlyString): { subject: string; body: string } {
  return {
    subject: `⚠️ Teste 2608: reconciliação de gasto faltando para ${dateStr}`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `Falta linha de gasto em data/aquisicao/clicks-2608.csv para ${dateStr}, nos braços:`,
      ...missingBracos.map((b) => `  - ${b}`),
      "",
      "Reconciliar HOJE nos painéis (00-PROTOCOLO.md §8.3) — a regra de morte da §3.2 item 3",
      "(\"gasto acumulado > 2× o planejado\") fica inverificável sem série diária, e um braço que",
      "estourou não seria descoberto até a apuração final, quando já não há o que fazer.",
    ].join("\n"),
  };
}

export function buildDeathConditionEmail(findings: readonly SpendOverageFinding[]): { subject: string; body: string } {
  return {
    subject: `🚨 Teste 2608: condição de morte disparada (gasto > 2× o planejado)`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845) — 00-PROTOCOLO.md §3.2 item 3.`,
      "",
      "Braço(s) com gasto acumulado acima de 2× o planejado do período:",
      ...findings.map(
        (f) =>
          `  - ${f.braco}: R$ ${f.gastoAcumulado.toFixed(2)} acumulado até ${f.lastKnownDate} ` +
          `(planejado: R$ ${f.plannedCumulativeBRL.toFixed(2)}, razão ${f.ratio.toFixed(2)}×)`,
      ),
      "",
      "Ação: confirmar no painel da plataforma se é cobrança de entrega além do nominal (o Google pode",
      "gastar até 2× o diário num dia isolado — normal) ou um problema real de conta. Registrar a decisão",
      "no 00-PROTOCOLO.md §3.2/§4 antes de qualquer ação sobre a campanha (congelamento operacional §3.4).",
      "",
      "Este alarme REPETE todo dia enquanto a condição continuar verdadeira — dinheiro real em jogo.",
    ].join("\n"),
  };
}

export function buildReligarBrevoDueEmail(religarDate: DateOnlyString): { subject: string; body: string } {
  return {
    subject: `Teste 2608: D+21 chegou (${religarDate}) — religar Diaria-Brevo-Diaria-Evaluate`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `A data de religamento pré-registrada (D+21 = ${religarDate}) chegou. #5838 rastreia esta ação —`,
      "ver o comentário automático desta task nela, ou reverter manualmente `enabled: false` na entrada",
      "`Diaria-Brevo-Diaria-Evaluate` de scripts/lib/scheduled-tasks.ts.",
    ].join("\n"),
  };
}

export function buildApuracaoSnapshotUnusableEmail(snapshotDate: DateOnlyString, reason: string): { subject: string; body: string } {
  return {
    subject: `🚨 Teste 2608: apuração de ${snapshotDate} NÃO rodou — snapshot inutilizável`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `Hoje é a data de apuração pré-registrada (${snapshotDate}), mas o snapshot correspondente de`,
      `data/beehiiv-backup/${snapshotDate}/ está inutilizável: ${reason}`,
      "",
      "A apuração NÃO foi rodada (00-PROTOCOLO.md §7.2 — um relatório congelado sobre snapshot ruim é",
      "pior que nenhum, porque o id do relatório é a data do snapshot e re-rodar sobrescreve). Este alarme",
      "REPETE todo dia até o snapshot ficar utilizável ou você intervir manualmente.",
    ].join("\n"),
  };
}

export function buildApuracaoSuccessEmail(snapshotDate: DateOnlyString, reportUrl: string): { subject: string; body: string } {
  return {
    subject: `Teste 2608: apuração congelada rodou (snapshot ${snapshotDate})`,
    body: [
      `A apuração pré-registrada (00-PROTOCOLO.md §7.1) rodou automaticamente hoje.`,
      "",
      `Relatório: ${reportUrl}`,
      "",
      "build-origem-map.ts rodou imediatamente antes de cac-report.ts, como exige a §7.2.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Guard de cadastros zerados (#8238) — nunca congelar um relatório com 0
// cadastros nos 3 braços como se fosse "concluído": é o sintoma exato de
// `cac-report.ts` ter lido a coorte da fonte errada (snapshot Beehiiv, que
// nunca viu cadastros nascidos no Kit).
// ---------------------------------------------------------------------------

/** Cadastros medidos por canal — só linhas `measured` de `CacReport.rows`
 *  têm o campo `cadastros`; qualquer outro tipo (`boost-estimate`) ou canal
 *  ausente do relatório conta como 0 (sinal igualmente ruim: nem apareceu).
 *  @pure */
function cadastrosPorCanal(rows: readonly CacRow[]): Map<string, number> {
  const byCanal = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "measured") byCanal.set(row.canal, row.cadastros);
  }
  return byCanal;
}

/**
 * Devolve os `bracos` (nomes de canal EXATOS, ver `ADS_TEST_2608_BRACOS`)
 * cujo `cadastros` no relatório é 0 (ou o canal nem aparece em `rows` —
 * mesmo sinal, tratado igual). Usada pelo caller (`scripts/ads-test-watch.ts`)
 * pra decidir se TODOS os braços zeraram — sinal de fonte de dados errada
 * (#8238) — antes de marcar a apuração como concluída. @pure
 */
export function detectZeroCadastrosAcrossArms(rows: readonly CacRow[], bracos: readonly string[]): string[] {
  const byCanal = cadastrosPorCanal(rows);
  return bracos.filter((braco) => (byCanal.get(braco) ?? 0) === 0);
}

/** Mesmo que `detectZeroCadastrosAcrossArms`, mas recebendo o `CacReport`
 *  inteiro — conveniência pro caller que já tem o objeto retornado por
 *  `cac-report.ts::main()` em mãos. @pure */
export function detectZeroCadastrosAcrossArmsFromReport(report: CacReport, bracos: readonly string[]): string[] {
  return detectZeroCadastrosAcrossArms(report.rows, bracos);
}

export function buildApuracaoZeroCadastrosEmail(
  snapshotDate: DateOnlyString,
  zeroArmBracos: readonly string[],
): { subject: string; body: string } {
  return {
    subject: `🚨 Teste 2608: apuração de ${snapshotDate} deu 0 cadastros em TODOS os braços — NÃO congelada`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#8238).`,
      "",
      `A apuração pré-registrada (${snapshotDate}) rodou, mas os ${zeroArmBracos.length} braço(s) do teste`,
      `(${zeroArmBracos.join(", ")}) saíram com 0 cadastros — sinal de fonte de dados errada`,
      "(ex: cac-report.ts leu só o snapshot Beehiiv, mas o cadastro real nasceu no Kit e nunca passou por lá).",
      "",
      "A apuração NÃO foi marcada como concluída — este alarme repete todo dia até os cadastros aparecerem",
      'ou até você investigar manualmente (checar "--fonte store" em cac-report.ts, #8238).',
    ].join("\n"),
  };
}
