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

/**
 * #13994: `fmtTimeBRT`/`fmtClockBRT` vieram de
 * `workers/brevo-dashboard/src/render-links.ts` (que agora reexporta daqui),
 * para o Studio (`scripts/studio-ui/dashboard-clarice.ts`) parar de importar
 * código do Worker. Corpo inalterado.
 *
 * Data curta com dia da semana em BRT (ex: "qua., 11/06 06:00"); `—` para
 * `null`/vazio e a própria string quando o ISO é inválido.
 */
export function fmtTimeBRT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // #2085: weekday:"short" acrescenta dia da semana (ex: "qua., 11/06 06:00")
  // pra facilitar leitura de padrões de engajamento por dia.
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * #5218: irmã ENXUTA de `fmtTimeBRT` — só HH:MM, sem data/dia da semana.
 * Usada no banner de rate-limit ("volta a atualizar sozinho às 14:37 BRT"),
 * onde o horário-alvo é sempre HOJE (a janela de retry da Brevo é de
 * segundos/minutos, nunca cruza pro dia seguinte) — a data completa de
 * `fmtTimeBRT` seria ruído. Aceita epoch ms (não ISO) porque o caller sempre
 * tem um `Date.now() + retryAfterSecs*1000` calculado, não uma string.
 */
export function fmtClockBRT(epochMs: number): string {
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}
