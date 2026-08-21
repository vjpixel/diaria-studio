/**
 * scripts/lib/ads-test-schedule.ts (#5845)
 *
 * Derivação PURA das datas do ciclo de vida do teste de 3 canais pagos
 * ("teste 2608", #5524, R$ 4.500) a partir do D0 (1º dia de veiculação,
 * comum aos 3 braços — Google Ads, Microsoft Ads, Meta Ads). Ver
 * `data/aquisicao/campanhas-260816/00-PROTOCOLO.md` §7.1 pro racional de
 * cada marco; este módulo só implementa a aritmética, sem I/O.
 *
 * ## Marcos
 *
 * - **D+14** = fim da janela de veiculação (15 dias, D0..D+14 inclusive).
 * - **D+21** = religar `Diaria-Brevo-Diaria-Evaluate` (15 dias de janela +
 *   7 de cauda — ver #5838).
 * - **D+41** = a coorte inteira do teste cruza o piso de 20 edições
 *   recebidas que `leitor-v1` exige (5 edições/semana × 28 dias corridos a
 *   partir do ÚLTIMO cadastro do teste, aproximado aqui pelo D+14 + 28
 *   como o pior caso da janela — ver §7.1).
 * - **Apuração** = 1º snapshot semanal em D+42 ou depois. `Diaria-Beehiiv-Backup`
 *   roda semanalmente aos domingos 03:00 BRT — D+42 puro pode cair num dia
 *   sem snapshot, então a data de apuração é sempre o **1º DOMINGO ≥ D+42**,
 *   nunca D+42 em si.
 *
 * Todas as datas são strings `YYYY-MM-DD` (sem componente de hora/fuso) —
 * a aritmética usa `Date.UTC` só como calculadora de calendário, nunca lida
 * com `Date.now()`/fuso local. Isso torna a derivação determinística e
 * testável com datas injetadas (nunca o relógio real).
 */

/** Formato canônico de data usado neste módulo — validado por
 *  {@link parseDateOnly}, nunca aceito cru sem checagem. */
export type DateOnlyString = string;

/** Parseia `YYYY-MM-DD` como um instante UTC (meia-noite). Lança em
 *  qualquer formato fora do padrão — nunca degrada pra `Invalid Date`
 *  silencioso (mesma disciplina do resto do repo: falhar alto em vez de
 *  produzir uma data errada sem aviso). */
export function parseDateOnly(dateStr: DateOnlyString): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    throw new Error(`ads-test-schedule: data inválida "${dateStr}" — esperado formato YYYY-MM-DD.`);
  }
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC normaliza mês/dia fora de faixa (ex: mês 13, dia 32) em vez de
  // lançar — checar o round-trip pega esse caso (ex: "2026-13-01" viraria
  // 2027-01-01 silenciosamente sem esta checagem).
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`ads-test-schedule: data inválida "${dateStr}" — componente fora de faixa.`);
  }
  return date;
}

/** Formata um `Date` (assumido meia-noite UTC) de volta pra `YYYY-MM-DD`. */
export function formatDateOnly(date: Date): DateOnlyString {
  return date.toISOString().slice(0, 10);
}

/** Soma `days` dias corridos a `dateStr` (pode ser negativo). Pura —
 *  aritmética de calendário UTC, sem depender de fuso local. */
export function addDays(dateStr: DateOnlyString, days: number): DateOnlyString {
  const date = parseDateOnly(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

/** `true` se `dateStr` cai num domingo (UTC). */
export function isSunday(dateStr: DateOnlyString): boolean {
  return parseDateOnly(dateStr).getUTCDay() === 0;
}

/** Dias corridos entre `fromStr` e `toStr` (`toStr - fromStr`, pode ser
 *  negativo se `toStr` for anterior). Pura — usa a mesma calculadora UTC de
 *  {@link addDays}, nunca fuso local. */
export function daysBetween(fromStr: DateOnlyString, toStr: DateOnlyString): number {
  const from = parseDateOnly(fromStr).getTime();
  const to = parseDateOnly(toStr).getTime();
  return Math.round((to - from) / 86_400_000);
}

/**
 * 1º domingo ≥ `dateStr` — pura aritmética de calendário, nunca depende do
 * relógio real. Usada pra ancorar a data de apuração num dia em que
 * `Diaria-Beehiiv-Backup` (semanal, domingo 03:00 BRT) de fato gera um
 * snapshot novo.
 */
export function firstSundayOnOrAfter(dateStr: DateOnlyString): DateOnlyString {
  const date = parseDateOnly(dateStr);
  const dayOfWeek = date.getUTCDay(); // 0 = domingo
  const daysToAdd = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  return addDays(dateStr, daysToAdd);
}

/** Ver docstring do módulo — dias corridos desde D0 pra cada marco. */
export const ADS_TEST_WINDOW_DAYS = 14;
export const ADS_TEST_RELIGAR_BREVO_DAYS = 21;
export const ADS_TEST_COORTE_MADURA_DAYS = 41;
export const ADS_TEST_APURACAO_MIN_DAYS = 42;

export interface AdsTestSchedule {
  d0: DateOnlyString;
  /** Último dia de veiculação (D+14 — §7.1, D0..D+14 inclusive = 15 dias). */
  fim_janela: DateOnlyString;
  /** Data em que `Diaria-Brevo-Diaria-Evaluate` deve ser religada (D+21, #5838). */
  religar_brevo: DateOnlyString;
  /** Data em que a coorte inteira cruza o piso de 20 edições recebidas (D+41). */
  coorte_madura: DateOnlyString;
  /** 1º domingo ≥ D+42 — a única data de apuração válida (§7.1/§7.2). */
  apuracao_snapshot: DateOnlyString;
}

/**
 * Deriva o cronograma inteiro do teste a partir do D0. Pura — nenhuma
 * chamada a `Date.now()`/relógio real, nenhum I/O.
 *
 * @pure
 */
export function deriveAdsTestSchedule(d0: DateOnlyString): AdsTestSchedule {
  // Valida o formato cedo — qualquer marco derivado herda o erro de
  // `parseDateOnly` se `d0` estiver malformado.
  parseDateOnly(d0);
  const fimJanela = addDays(d0, ADS_TEST_WINDOW_DAYS);
  const religarBrevo = addDays(d0, ADS_TEST_RELIGAR_BREVO_DAYS);
  const coorteMadura = addDays(d0, ADS_TEST_COORTE_MADURA_DAYS);
  const apuracaoMin = addDays(d0, ADS_TEST_APURACAO_MIN_DAYS);
  const apuracaoSnapshot = firstSundayOnOrAfter(apuracaoMin);
  return {
    d0,
    fim_janela: fimJanela,
    religar_brevo: religarBrevo,
    coorte_madura: coorteMadura,
    apuracao_snapshot: apuracaoSnapshot,
  };
}
