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
