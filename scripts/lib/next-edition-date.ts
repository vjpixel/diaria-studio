/**
 * next-edition-date.ts (#2068)
 *
 * Calcula a data da próxima edição da Diar.ia: D+1 em fuso America/Sao_Paulo.
 *
 * Regra editorial (CLAUDE.md): a edição é sempre o dia seguinte à pesquisa.
 * Ex.: pesquisa roda em 2026-04-26 (BRT) → edição é 260427.
 *
 * Usado pelo runner agendado `scripts/overnight/run-scheduled-edicao.ps1`.
 * Extraído como lib para permitir testes determinísticos (#633 / #2068).
 */

/** Fuso horário canônico do Brasil (Brasília). */
export const BRT_TIMEZONE = "America/Sao_Paulo";

/**
 * Retorna a data de amanhã no fuso America/Sao_Paulo no formato AAMMDD
 * (ex: "260427" para 27 de abril de 2026).
 *
 * Estratégia: avança exatamente 24 h a partir de `now` e consulta o Intl
 * para saber qual dia é em BRT. Correto em viradas de mês/ano e robusto
 * a mudanças futuras de DST (BRT = UTC-3 fixo desde 2019, mas Intl garante
 * mesmo que isso mude).
 *
 * @param now - Ponto de referência para "hoje" (default: Date.now()).
 *              Injetar em testes para determinismo.
 */
export function nextEditionDate(now: Date = new Date()): string {
  const tomorrowParts = datePartsInTz(
    new Date(now.getTime() + 24 * 60 * 60 * 1000),
    BRT_TIMEZONE,
  );
  return toAammdd(tomorrowParts);
}

// ---------------------------------------------------------------------------
// Helpers (exportados para teste)
// ---------------------------------------------------------------------------

export interface DateParts {
  year: number;
  /** 1-based month */
  month: number;
  day: number;
}

/**
 * Extrai ano, mês (1-based) e dia de um Date no fuso especificado usando Intl.
 * Funciona corretamente em DST e viradas de mês/ano.
 */
export function datePartsInTz(date: Date, timeZone: string): DateParts {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl: campo '${type}' não encontrado`);
    return parseInt(p.value, 10);
  };
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * Converte DateParts para o formato AAMMDD (ex: { year: 2026, month: 4, day: 27 } → "260427").
 */
export function toAammdd(parts: DateParts): string {
  const yy = String(parts.year).slice(-2);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Offset (em minutos) do fuso `timeZone` no instante `date` — negativo a
 * oeste de UTC (ex: BRT = -180). Lê os dígitos locais do instante via Intl e
 * compara contra o próprio instante — não assume offset fixo (robusto a
 * mudanças futuras de DST em qualquer fuso). Extraído pra uso por
 * `zonedTimeToUtc` (#2910: fronteira do ciclo de cobrança Brevo, precisão de
 * minuto — `datePartsInTz`/`nextEditionDate` só operam em dia).
 */
function offsetMinutesInTz(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Alguns runtimes formatam meia-noite como hour="24" mesmo com hour12:false — normaliza.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * Converte um instante "wall-clock" (ano/mês/dia/hora/min/seg, 1-based month)
 * no fuso `timeZone` para o `Date` UTC correspondente. Generaliza
 * `nextEditionDate`/`datePartsInTz` (que só operam em granularidade de dia)
 * pra consumidores que precisam de precisão de minuto — ex: fronteira do
 * ciclo de cobrança Brevo (dia 4, 15:45 BRT, #2910) ou início do mês
 * corrente em BRT (#2923).
 *
 * Duas passadas: 1ª aproximação trata os dígitos como se já fossem UTC pra
 * descobrir o offset real do fuso perto desse instante; a 2ª aplica o offset.
 * Suficiente pra fusos sem "double DST transition" no mesmo dia (BRT é fixo
 * desde 2019; mesmo com DST futuro, a imprecisão fica no pior caso limitada
 * à janela de transição, não usada aqui).
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-based
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const approxMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMin = offsetMinutesInTz(new Date(approxMs), timeZone);
  return new Date(approxMs - offsetMin * 60_000);
}
