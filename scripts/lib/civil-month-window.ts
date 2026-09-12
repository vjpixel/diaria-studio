/**
 * civil-month-window.ts (#8024)
 *
 * Fronteira do MÊS CIVIL BRT (dia 1, 00:00 → dia 1 do mês seguinte, 00:00) —
 * usado por `clarice-db-summary.ts` pra decidir se um contato já recebeu
 * ALGUM envio NESTE mês (coluna "Falta 1º envio no mês" da tabela Cohorts).
 *
 * ⚠️ Conceito DIFERENTE do ciclo de cobrança Brevo (`billing-cycle.ts`, dia 4
 * 15:45 BRT — aniversário da subscription) e do ciclo de conteúdo/envio da
 * mensal Clarice (`{conteúdo}-{envio}`, ex. "2605-06" — removido do sumário
 * de contatos no #4406, ver `billing-cycle.ts` para o histórico). Este é o
 * mês do CALENDÁRIO, sem relação com nenhum dos dois — escolhido por ser a
 * leitura mais direta de "mês atual" pra quem olha o painel (#8024).
 *
 * Pura (sem I/O, sem `Env`) — mesmo padrão de `billing-cycle.ts`, reusa
 * `datePartsInTz`/`zonedTimeToUtc` de `next-edition-date.ts`.
 */
import { datePartsInTz, zonedTimeToUtc, BRT_TIMEZONE } from "./next-edition-date.ts";

export interface CivilMonthWindow {
  /** Início do mês corrente (inclusivo) — instante UTC. */
  start: Date;
  /** Fim do mês corrente (exclusivo) — instante UTC; é o `start` do mês seguinte. */
  end: Date;
}

function monthBoundary(year: number, month1: number): Date {
  return zonedTimeToUtc(year, month1, 1, 0, 0, 0, BRT_TIMEZONE);
}

function nextMonth(year: number, month1: number): { year: number; month1: number } {
  return month1 === 12 ? { year: year + 1, month1: 1 } : { year, month1: month1 + 1 };
}

/** Janela [start, end) do mês civil BRT corrente pra o instante `now`. */
export function civilMonthWindow(now: Date = new Date()): CivilMonthWindow {
  const { year, month } = datePartsInTz(now, BRT_TIMEZONE);
  const start = monthBoundary(year, month);
  const nm = nextMonth(year, month);
  return { start, end: monthBoundary(nm.year, nm.month1) };
}

/** `true` se `dateIso` cai dentro de `[window.start, window.end)`. Datas ausentes/inválidas → `false`. */
export function isInCivilMonthWindow(
  dateIso: string | null | undefined,
  window: CivilMonthWindow,
): boolean {
  if (!dateIso) return false;
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return false;
  return t >= window.start.getTime() && t < window.end.getTime();
}
