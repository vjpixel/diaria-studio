/**
 * scripts/lib/ads-test-pause-window.ts (#8240, #8241)
 *
 * Helper PURO e ÚNICO para os intervalos de pausa do teste 2608
 * (`data/aquisicao/teste-2608/run-state.json` -> `revisao.pausa`),
 * consumido pelo alarme de gasto (#8240) e pela janela móvel/
 * comparabilidade (#8241) — e, no futuro, pela tela `/ads` (#8210
 * melhoria 1) e pelo relatório diário (#8246). Nunca duplicar o parser de
 * pausa: um único lugar decide o que "pausado" significa.
 *
 * `scripts/lib/ads-test-run-state.ts` não foi tocado aqui de propósito —
 * está sob fronteira de arquivo de outro PR em voo no mesmo momento
 * (#8250) — então os tipos de `revisao`/`pausa` vivem NESTE arquivo, como
 * uma extensão ESTRUTURAL (duck-typed) do shape gravado em
 * `run-state.json`, não uma mudança no tipo `AdsTestRunState` em si. O
 * caller lê o JSON bruto (já validado por `assertValidRunState` pros
 * campos que ele conhece) e faz cast pra `AdsTestRunStateWithPause` pra
 * enxergar os campos extras.
 */
import { addDays, daysBetween, type DateOnlyString } from "./ads-test-schedule.ts";

export interface AdsTestPauseInterval {
  /** ISO 8601 com offset (ex: "2026-09-09T09:10:00-03:00"). */
  inicio: string;
  /** ISO 8601 com offset, ou `null` = pausa em andamento (ainda não retomada). */
  fim: string | null;
}

/** `revisao.pausa` aceita objeto único (formato atual) OU lista (2ª pausa
 *  futura — #8240 item 1 do "O que fazer"). */
export type AdsTestPauseField = AdsTestPauseInterval | AdsTestPauseInterval[] | null | undefined;

/** Uma entrada de `orcamento_diario_brl[braco]` — diário vigente a partir
 *  de `desde` (ISO com offset, pode carregar hora — ex: Microsoft mudou
 *  100->200 em "2026-09-06T17:07:00-03:00", não à meia-noite). */
export interface AdsTestBudgetPeriod {
  desde: string;
  brl: number;
}

/** Shape estrutural de `run-state.json` cobrindo os campos que
 *  `AdsTestRunState` ainda não tipa: `revisao.pausa` (#8240/#8241) e
 *  `orcamento_diario_brl` (#8240 item 2 — diário vigente por braço, com
 *  histórico de vigência). Usar via cast estrutural
 *  (`raw as AdsTestRunStateWithPause`) sobre o objeto já validado por
 *  `assertValidRunState`. */
export interface AdsTestRunStateWithPause {
  revisao?: {
    pausa?: AdsTestPauseField;
  };
  /** Braço ausente do mapa usa o default do caller
   *  (`DEFAULT_PLANNED_DAILY_BUDGET_BRL`). Entradas devem vir ordenadas
   *  por `desde` ascendente — ordem errada é erro de dado, não algo que
   *  este módulo corrige em silêncio. */
  orcamento_diario_brl?: Record<string, AdsTestBudgetPeriod[]>;
}

/** Normaliza `revisao.pausa` pra sempre uma lista (vazia quando ausente). */
export function normalizePauseIntervals(pausa: AdsTestPauseField): AdsTestPauseInterval[] {
  if (pausa == null) return [];
  return Array.isArray(pausa) ? pausa : [pausa];
}

/** ms desde epoch. Lança em timestamp inválido — mesma disciplina de
 *  "falhar alto" do resto do módulo de agendamento (`ads-test-schedule.ts`). */
function parseIsoMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`ads-test-pause-window: timestamp ISO inválido: "${iso}"`);
  return ms;
}

/** Início do dia BRT (00:00 America/Sao_Paulo, offset fixo -03:00 — sem
 *  DST desde 2019, mesma convenção de `ads-rolling-window.ts`) em ms desde
 *  epoch, para `dateStr` (YYYY-MM-DD). */
function brtDayStartMs(dateStr: DateOnlyString): number {
  return parseIsoMs(`${dateStr}T00:00:00-03:00`);
}

/**
 * Fração do dia BRT `dateStr` (0..1) coberta por pausa (parcial ou total).
 * Intervalos sobrepostos entre si são mesclados antes de somar — sem isso,
 * duas pausas que se sobrepõem contariam a mesma hora duas vezes e o dia
 * pareceria mais pausado do que de fato foi.
 *
 * @pure
 */
export function pausedFractionOfDay(dateStr: DateOnlyString, intervals: readonly AdsTestPauseInterval[]): number {
  if (intervals.length === 0) return 0;
  const dayStart = brtDayStartMs(dateStr);
  const dayEnd = dayStart + 86_400_000;
  const clipped: Array<[number, number]> = [];
  for (const iv of intervals) {
    const s = Math.max(dayStart, parseIsoMs(iv.inicio));
    const e = Math.min(dayEnd, iv.fim ? parseIsoMs(iv.fim) : dayEnd);
    if (e > s) clipped.push([s, e]);
  }
  if (clipped.length === 0) return 0;
  clipped.sort((a, b) => a[0] - b[0]);
  let merged = 0;
  let [curStart, curEnd] = clipped[0];
  for (let i = 1; i < clipped.length; i++) {
    const [s, e] = clipped[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      merged += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  merged += curEnd - curStart;
  return Math.min(1, merged / 86_400_000);
}

/** `true` se QUALQUER parte de `dateStr` (dia BRT) caiu dentro de alguma
 *  pausa — parcial conta (#8241: "pausada, total ou parcial"). @pure */
export function isDatePaused(dateStr: DateOnlyString, intervals: readonly AdsTestPauseInterval[]): boolean {
  return pausedFractionOfDay(dateStr, intervals) > 0;
}

/** Dias (BRT, `YYYY-MM-DD`) dentro de `[startDate, endDate]` inclusive com
 *  QUALQUER cobertura de pausa. @pure */
export function pausedDatesInRange(
  startDate: DateOnlyString,
  endDate: DateOnlyString,
  intervals: readonly AdsTestPauseInterval[],
): DateOnlyString[] {
  if (intervals.length === 0 || startDate > endDate) return [];
  const out: DateOnlyString[] = [];
  const totalDays = daysBetween(startDate, endDate) + 1;
  let d = startDate;
  for (let i = 0; i < totalDays; i++) {
    if (isDatePaused(d, intervals)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/**
 * Dias de VEICULAÇÃO (não de calendário) entre `d0` e `throughDate`
 * (inclusive dos dois lados), descontando a fração de pausa de cada dia
 * (#8240 item 1). Ex: 8 dias corridos 100% pausados descontam 8 do total;
 * 1 dia pausado metade do tempo desconta 0,5.
 *
 * @pure
 */
export function veiculationDaysInRange(
  d0: DateOnlyString,
  throughDate: DateOnlyString,
  intervals: readonly AdsTestPauseInterval[],
): number {
  const totalCalendarDays = daysBetween(d0, throughDate) + 1;
  if (totalCalendarDays <= 0) return 0;
  let paused = 0;
  let d = d0;
  for (let i = 0; i < totalCalendarDays; i++) {
    paused += pausedFractionOfDay(d, intervals);
    d = addDays(d, 1);
  }
  return totalCalendarDays - paused;
}

/**
 * Orçamento diário VIGENTE em `dateStr` — última entrada de `schedule` com
 * `desde` anterior ao FIM daquele dia (comparação por instante, não por
 * dia civil: `desde` pode carregar hora, ex: Microsoft 06/09 17:07). Sem
 * entrada vigente (schedule ausente/vazio, ou `dateStr` inteiro anterior à
 * 1ª entrada), usa `defaultBudgetBRL`.
 *
 * @pure
 */
export function dailyBudgetForDate(
  dateStr: DateOnlyString,
  schedule: readonly AdsTestBudgetPeriod[] | undefined,
  defaultBudgetBRL: number,
): number {
  if (!schedule || schedule.length === 0) return defaultBudgetBRL;
  const dayEndMs = brtDayStartMs(dateStr) + 86_400_000;
  let current = defaultBudgetBRL;
  for (const entry of schedule) {
    if (parseIsoMs(entry.desde) < dayEndMs) current = entry.brl;
  }
  return current;
}

/**
 * Planejado acumulado por braço, em R$, de `d0` até `throughDate`
 * (inclusive), integrando o diário VIGENTE (que pode mudar dentro do
 * período, ex: Microsoft R$100->200 em 06/09 17:07) sobre os dias de
 * VEICULAÇÃO (excluindo pausa — #8240 itens 1+3).
 *
 * Precisão: soma por DIA inteiro usando o diário vigente ao FIM daquele
 * dia (`dailyBudgetForDate`) multiplicado pela fração não-pausada do dia —
 * não faz integração sub-diária do próprio orçamento (o dia em que o
 * diário muda e também tem pausa parcial usa o diário vigente ao fim do
 * dia inteiro). A imprecisão é de horas sobre um número que já é uma
 * aproximação de negócio (§"Orçamento do 1º mês" do `00-PROTOCOLO.md` não
 * pretende precisão de minuto).
 *
 * @pure
 */
export function plannedBudgetBRL(
  d0: DateOnlyString,
  throughDate: DateOnlyString,
  schedule: readonly AdsTestBudgetPeriod[] | undefined,
  intervals: readonly AdsTestPauseInterval[],
  defaultBudgetBRL: number,
): number {
  const totalCalendarDays = daysBetween(d0, throughDate) + 1;
  if (totalCalendarDays <= 0) return 0;
  let total = 0;
  let d = d0;
  for (let i = 0; i < totalCalendarDays; i++) {
    const veiculado = 1 - pausedFractionOfDay(d, intervals);
    total += veiculado * dailyBudgetForDate(d, schedule, defaultBudgetBRL);
    d = addDays(d, 1);
  }
  return total;
}
