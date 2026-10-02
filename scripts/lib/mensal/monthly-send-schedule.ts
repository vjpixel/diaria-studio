/**
 * scripts/lib/mensal/monthly-send-schedule.ts (#9473)
 *
 * Fonte ÚNICA da regra de horário de envio da edição mensal: **1º sábado do
 * mês de ENVIO, 06:00 BRT** (pedido do editor, 02/10/2026). A regra vive
 * parametrizada em `platform.config.json` → `monthly_send_schedule`; este
 * módulo resolve a config (com defaults iguais à regra) e calcula o instante.
 *
 * Decisões que não são detalhe:
 *
 * - **Mês de ENVIO, não de conteúdo.** O ciclo `{YYMM}-{MM}` carrega os dois;
 *   o 2º MM é o envio (`2610-11` sai no 1º sábado de NOVEMBRO). Virada de ano
 *   (`2612-01`) avança o ano de envio.
 * - **BRT = UTC-3 fixo, aritmética explícita.** O Brasil não tem horário de
 *   verão desde 2019, então o offset é constante. Nada aqui depende do TZ do
 *   host (`getUTCDay`/`Date.UTC` só) — o servidor `300` roda em UTC e a
 *   máquina do editor em BRT, e os dois precisam chegar ao mesmo instante.
 * - **Antecedência mínima (#8205: agendamento 24h+ à frente).**
 *   `decideMonthlySendAt` devolve `too_late` quando o sábado calculado está a
 *   menos de `min_lead_hours` (ou já passou). Quem chama decide o que fazer —
 *   o publisher dos apoiadores cai pra RASCUNHO (opção segura: nunca agenda
 *   algo que dispararia antes de haver tempo de conferir).
 */
import { isValidCycle } from "../clarice-paths.ts";

/** Offset fixo de Brasília (sem DST desde 2019). */
export const BRT_OFFSET_HOURS = -3;

export interface MonthlySendScheduleRule {
  /** 0 = domingo … 6 = sábado (convenção de `Date#getUTCDay`). */
  weekday: number;
  /** N-ésima ocorrência do `weekday` no mês (1 = primeira). */
  occurrence: number;
  /** Hora local BRT, 0-23. */
  hourBrt: number;
  /** Minuto local BRT, 0-59. */
  minuteBrt: number;
  /** Antecedência mínima em horas para agendar (#8205). */
  minLeadHours: number;
}

/** Default = a regra pedida pelo editor (#9473). */
export const DEFAULT_MONTHLY_SEND_SCHEDULE: MonthlySendScheduleRule = Object.freeze({
  weekday: 6,
  occurrence: 1,
  hourBrt: 6,
  minuteBrt: 0,
  minLeadHours: 24,
});

/** Shape cru de `platform.config.json` → `monthly_send_schedule`. */
export interface MonthlySendScheduleConfig {
  weekday?: number;
  occurrence?: number;
  time_brt?: string;
  min_lead_hours?: number;
}

/**
 * Pura: resolve a config crua contra os defaults. Valor inválido LANÇA — uma
 * regra de envio mal configurada não pode virar, em silêncio, um horário
 * diferente do que o editor escreveu.
 */
export function resolveMonthlySendSchedule(raw: MonthlySendScheduleConfig | undefined | null): MonthlySendScheduleRule {
  const d = DEFAULT_MONTHLY_SEND_SCHEDULE;
  if (raw == null) return { ...d };
  const weekday = raw.weekday ?? d.weekday;
  const occurrence = raw.occurrence ?? d.occurrence;
  const minLeadHours = raw.min_lead_hours ?? d.minLeadHours;
  let hourBrt = d.hourBrt;
  let minuteBrt = d.minuteBrt;
  if (raw.time_brt !== undefined) {
    const m = /^(\d{2}):(\d{2})$/.exec(raw.time_brt);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      throw new Error(`monthly_send_schedule.time_brt inválido: "${raw.time_brt}" (esperado "HH:MM", ex: "06:00")`);
    }
    hourBrt = Number(m[1]);
    minuteBrt = Number(m[2]);
  }
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new Error(`monthly_send_schedule.weekday inválido: ${weekday} (esperado 0-6, 6 = sábado)`);
  }
  // Ocorrência 5 não existe em todo mês — limitar a 1-4 evita um "mês sem envio".
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > 4) {
    throw new Error(`monthly_send_schedule.occurrence inválido: ${occurrence} (esperado 1-4)`);
  }
  if (typeof minLeadHours !== "number" || !Number.isFinite(minLeadHours) || minLeadHours < 0) {
    throw new Error(`monthly_send_schedule.min_lead_hours inválido: ${minLeadHours}`);
  }
  return { weekday, occurrence, hourBrt, minuteBrt, minLeadHours };
}

/** Pura: ano/mês (1-12) de ENVIO de um ciclo `{YYMM}-{MM}`. */
export function cycleSendYearMonth(cycle: string): { year: number; month: number } {
  if (!isValidCycle(cycle)) {
    throw new Error(`ciclo inválido: "${cycle}" (esperado {conteúdo}-{envio}, ex: 2610-11)`);
  }
  const contentYear = 2000 + Number(cycle.slice(0, 2));
  const contentMonth = Number(cycle.slice(2, 4));
  const sendMonth = Number(cycle.slice(5, 7));
  return { year: sendMonth < contentMonth ? contentYear + 1 : contentYear, month: sendMonth };
}

/** Pura: dia do mês da N-ésima ocorrência de `weekday` em (year, month 1-12). */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, occurrence: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + 7 * (occurrence - 1);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export interface MonthlySendAt {
  /** ISO 8601 com offset BRT explícito, ex: `2026-11-07T06:00:00-03:00`. */
  iso: string;
  /** Epoch ms do mesmo instante. */
  epochMs: number;
}

/** Pura: instante de envio do ciclo segundo a regra. */
export function computeMonthlySendAt(
  cycle: string,
  rule: MonthlySendScheduleRule = DEFAULT_MONTHLY_SEND_SCHEDULE,
): MonthlySendAt {
  const { year, month } = cycleSendYearMonth(cycle);
  const day = nthWeekdayOfMonth(year, month, rule.weekday, rule.occurrence);
  const epochMs = Date.UTC(year, month - 1, day, rule.hourBrt - BRT_OFFSET_HOURS, rule.minuteBrt);
  const iso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(rule.hourBrt)}:${pad2(rule.minuteBrt)}:00-03:00`;
  return { iso, epochMs };
}

export type MonthlySendDecision =
  | { kind: "schedule"; sendAt: string; hoursAhead: number }
  | { kind: "too_late"; sendAt: string; hoursAhead: number; reason: string };

/**
 * Pura: aplica a antecedência mínima (#8205). `too_late` cobre tanto "faltam
 * menos de N horas" quanto "o sábado já passou" — nos dois casos agendar seria
 * disparar sem janela de conferência (ou o Kit dispararia na hora).
 */
export function decideMonthlySendAt(
  cycle: string,
  now: Date,
  rule: MonthlySendScheduleRule = DEFAULT_MONTHLY_SEND_SCHEDULE,
): MonthlySendDecision {
  const { iso, epochMs } = computeMonthlySendAt(cycle, rule);
  const hoursAhead = (epochMs - now.getTime()) / 3_600_000;
  if (hoursAhead < rule.minLeadHours) {
    const reason =
      hoursAhead <= 0
        ? `o envio pela regra (${iso}) já passou`
        : `o envio pela regra (${iso}) está a ${hoursAhead.toFixed(1)}h — abaixo do mínimo de ${rule.minLeadHours}h (#8205)`;
    return { kind: "too_late", sendAt: iso, hoursAhead, reason };
  }
  return { kind: "schedule", sendAt: iso, hoursAhead };
}
