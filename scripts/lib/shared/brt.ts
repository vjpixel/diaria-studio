/**
 * shared/brt.ts (#14055)
 *
 * Fonte única dos helpers de fuso BRT (America/Sao_Paulo) que estavam
 * copiados, com corpo idêntico, em vários scripts, e das constantes de offset
 * fixo, agora com nomes que dizem o sentido da subtração.
 *
 * Por que os nomes: até o #14055 havia DUAS constantes exportadas chamadas
 * `BRT_UTC_OFFSET_HOURS`, uma valendo -3 (`ads-rolling-window.ts`) e outra +3
 * (`edition-scheduled-at.ts`). Importar do arquivo errado invertia a conta em
 * 6 horas sem erro de tipo. Os nomes abaixo leem como a subtração que fazem:
 *
 *   - `UTC_MINUS_BRT_HOURS = 3`: UTC − BRT. Some ao horário BRT para obter UTC
 *     (06:00 BRT + 3 = 09:00 UTC).
 *   - `BRT_MINUS_UTC_HOURS = -3`: BRT − UTC. Some ao instante UTC para obter o
 *     relógio BRT (09:00 UTC + (−3) = 06:00 BRT).
 *
 * BRT não tem horário de verão desde 2019, por isso o offset fixo funciona;
 * quem precisa sobreviver a uma mudança de política usa `Intl` com
 * `BRT_TIMEZONE` (como `hhmmBrt`/`brtDayKey` abaixo e `next-edition-date.ts`).
 *
 * Sem imports: é seguro para Workers e para qualquer domínio de `scripts/lib`.
 */

/** Fuso horário canônico do Brasil (Brasília). */
export const BRT_TIMEZONE = "America/Sao_Paulo";

/** UTC − BRT, em horas: some ao relógio BRT para chegar ao UTC. */
export const UTC_MINUS_BRT_HOURS = 3;

/** BRT − UTC, em horas: some ao instante UTC para chegar ao relógio BRT. */
export const BRT_MINUS_UTC_HOURS = -UTC_MINUS_BRT_HOURS;

/** `HH:MM` (24h) em BRT de um instante em epoch ms. */
export function hhmmBrt(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

/**
 * Dia civil em BRT no formato `YYYY-MM-DD`. `en-CA` porque é o locale cujo
 * formato de data curta já é ISO. Não reimplementar com `toISOString()`, que
 * devolve o dia em UTC.
 */
export function brtDayKey(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: BRT_TIMEZONE });
}
