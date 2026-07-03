/**
 * billing-cycle.ts (#2910)
 *
 * Fronteira do CICLO DE COBRANÇA Brevo — renova todo dia 4 às 15:45 BRT
 * (aniversário da subscription, horário exato confirmado pelo editor
 * 260703). Janela do ciclo corrente = [dia 4 15:45 do mês anterior → dia 4
 * 15:45 do mês atual). Usado pela seção "Volume enviado no ciclo" do
 * dashboard (denominador dinâmico por mês, nunca 40k hardcoded).
 *
 * ⚠️ Conceito DIFERENTE do "ciclo de conteúdo/envio" do #2909/#2923
 * (`deriveCycleStart` em `scripts/clarice-db-summary.ts`, que é "1º dia do
 * mês corrente" — planejamento de reenvio, não crédito de plano). Os dois
 * NÃO se alinham por design (confirmado pelo editor 260703) — não
 * reconciliar; cada superfície do dashboard deixa explícito qual "ciclo"
 * usa.
 *
 * Pura (sem I/O, sem `Env`) — só matemática de data/fuso, testável isolada.
 * Reusa `zonedTimeToUtc`/`datePartsInTz` de `scripts/lib/next-edition-date.ts`
 * (utilitário de fuso genérico, não específico de "ciclo").
 */
import { datePartsInTz, zonedTimeToUtc, BRT_TIMEZONE } from "../../../scripts/lib/next-edition-date.ts";

/** Dia do mês (BRT) em que o ciclo de cobrança Brevo renova. */
export const BILLING_CYCLE_DAY = 4;
/** Hora (BRT, 24h) do renovo. */
export const BILLING_CYCLE_HOUR = 15;
/** Minuto (BRT) do renovo. */
export const BILLING_CYCLE_MINUTE = 45;

export interface BillingCycleWindow {
  /** Início do ciclo corrente (inclusivo) — instante UTC. */
  start: Date;
  /** Fim do ciclo corrente (exclusivo) — instante UTC; é o `start` do próximo ciclo. */
  end: Date;
}

/** Instante UTC do renovo (dia 4, 15:45 BRT) do mês `month1` (1-based) / `year` dados. */
function billingBoundary(year: number, month1: number): Date {
  return zonedTimeToUtc(
    year,
    month1,
    BILLING_CYCLE_DAY,
    BILLING_CYCLE_HOUR,
    BILLING_CYCLE_MINUTE,
    0,
    BRT_TIMEZONE,
  );
}

function prevMonth(year: number, month1: number): { year: number; month1: number } {
  return month1 === 1 ? { year: year - 1, month1: 12 } : { year, month1: month1 - 1 };
}

function nextMonth(year: number, month1: number): { year: number; month1: number } {
  return month1 === 12 ? { year: year + 1, month1: 1 } : { year, month1: month1 + 1 };
}

/**
 * Janela [start, end) do ciclo de cobrança Brevo corrente pra o instante
 * `now`. `now` antes da fronteira deste mês (dia 4 15:45 BRT) → ciclo é
 * [fronteira do mês ANTERIOR, fronteira deste mês); `now` na fronteira ou
 * depois → ciclo é [fronteira deste mês, fronteira do PRÓXIMO mês).
 */
export function billingCycleWindow(now: Date = new Date()): BillingCycleWindow {
  const { year, month } = datePartsInTz(now, BRT_TIMEZONE);
  const thisMonthBoundary = billingBoundary(year, month);
  if (now.getTime() >= thisMonthBoundary.getTime()) {
    const nm = nextMonth(year, month);
    return { start: thisMonthBoundary, end: billingBoundary(nm.year, nm.month1) };
  }
  const pm = prevMonth(year, month);
  return { start: billingBoundary(pm.year, pm.month1), end: thisMonthBoundary };
}

/** `true` se `sentDateIso` cai dentro de `[window.start, window.end)`. Datas inválidas → `false`. */
export function isInBillingWindow(sentDateIso: string | null | undefined, window: BillingCycleWindow): boolean {
  if (!sentDateIso) return false;
  const t = Date.parse(sentDateIso);
  if (!Number.isFinite(t)) return false;
  return t >= window.start.getTime() && t < window.end.getTime();
}

/** Rótulo legível (DD/MM/AAAA) do início/fim do ciclo, em BRT — pro display na seção Volume. */
export function formatBillingWindowLabel(window: BillingCycleWindow): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString("pt-BR", { timeZone: BRT_TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" });
  return `${fmt(window.start)} → ${fmt(window.end)}`;
}
