/**
 * weekly-linkedin-cycle.ts (#4456)
 *
 * Resolução de ciclo/janela pra newsletter semanal do LinkedIn
 * (`/diaria-linkedin-semanal`). Espelha o padrão de
 * `scripts/lib/mensal/monthly-paths.ts` (ciclo → diretório) e de
 * `scripts/lib/select-weekly-d1.ts` (aritmética de calendário pura, sem
 * lógica manual de virada de mês/ano).
 *
 * **Convenção de ciclo (decisão do editor, comentário 260802 do #4456):**
 * `{YY}w{WW}` = ano ISO (2 dígitos) + semana ISO (2 dígitos), ex: `26w31`.
 * O `w` evita a leitura ambígua com `YYMM` (`2601` seria janeiro ou semana
 * 1?). O ciclo é derivado da semana de CONTEÚDO (segunda a sexta cobertas),
 * não da semana de publicação — mesma convenção do mensal, que batiza pelo
 * mês do conteúdo, não o mês do envio.
 *
 * **Janela de conteúdo:** a edição roda domingo, publica segunda de manhã,
 * cobrindo a semana (segunda a sexta) que ACABOU de terminar — ou seja, a
 * semana imediatamente ANTERIOR à segunda de publicação. Dado o AAMMDD da
 * segunda de publicação, a janela de conteúdo é publishMonday-7d (segunda)
 * até publishMonday-3d (sexta).
 */

import { isValidYymm } from "./mensal/monthly-paths.ts";

/** Resultado do cálculo de semana ISO 8601 (Thursday-based). */
export interface IsoWeekInfo {
  /** Ano ISO — pode diferir do ano de calendário perto da virada (ex: 29/dez pode ser semana 1 do ano seguinte). */
  isoYear: number;
  /** Número da semana ISO, 1-53. */
  week: number;
}

/**
 * Pure: calcula ano ISO + número da semana (ISO 8601, semana começa na
 * segunda, semana 1 é a que contém a 1ª quinta-feira do ano / 4 de janeiro).
 * Opera só nos componentes de calendário (ano/mês/dia) de `d` — hora do dia
 * é ignorada.
 */
export function isoWeekInfo(d: Date): IsoWeekInfo {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // segunda=0 .. domingo=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // quinta-feira desta semana
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const week = Math.round((date.getTime() - week1Monday.getTime()) / (7 * 24 * 3600 * 1000)) + 1;
  return { isoYear, week };
}

/** Pure: formata `IsoWeekInfo` no rótulo de ciclo `{YY}w{WW}` (ex: `26w31`). */
export function formatWeeklyCycle(info: IsoWeekInfo): string {
  const yy = String(info.isoYear % 100).padStart(2, "0");
  const ww = String(info.week).padStart(2, "0");
  return `${yy}w${ww}`;
}

/** Pure: atalho — ISO week label de uma data, já formatado (`26w31`). */
export function isoWeekLabel(d: Date): string {
  return formatWeeklyCycle(isoWeekInfo(d));
}

/** Pure: valida o formato do ciclo `{YY}w{WW}` (semana 01-53). */
export function isValidWeeklyCycle(s: string | undefined | null): s is string {
  if (!s) return false;
  const m = /^(\d{2})w(\d{2})$/i.exec(s.trim());
  if (!m) return false;
  const week = Number(m[2]);
  return week >= 1 && week <= 53;
}

/** Pure: formata `Date` local pra `AAMMDD`. */
export function formatAAMMDD(d: Date): string {
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Pure: AAMMDD da próxima segunda-feira a partir de `from` — se `from` já
 * for segunda, retorna a própria data (inclusivo, não "a segunda seguinte").
 * Default de `--publish-monday` quando omitido (#5321, "Perguntar é
 * exceção") — a skill roda tipicamente aos domingos, então o caso comum
 * resolve pra amanhã.
 */
export function nextMondayAAMMDD(from: Date = new Date()): string {
  const dayNum = (from.getDay() + 6) % 7; // segunda=0 .. domingo=6
  const daysUntilMonday = dayNum === 0 ? 0 : 7 - dayNum;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + daysUntilMonday);
  return formatAAMMDD(d);
}

/** Pure: parseia `AAMMDD` pra `Date` local (meia-noite). `null` se inválido. */
export function parseAAMMDD(s: string): Date | null {
  if (!isValidYymm(s.slice(0, 4)) || !/^\d{6}$/.test(s)) return null;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  const year = 2000 + yy;
  const d = new Date(year, mm - 1, dd);
  // Reconfirma componentes — rejeita datas inválidas tipo 260231 (31/fev)
  // que o construtor de Date rola silenciosamente pro mês seguinte.
  if (d.getFullYear() !== year || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}

/**
 * Pure: dado o AAMMDD da SEGUNDA de publicação, retorna as 5 datas AAMMDD
 * (segunda a sexta, ordem cronológica) da semana de CONTEÚDO — a semana que
 * ACABOU imediatamente antes dessa segunda (publishMonday - 7d até
 * publishMonday - 3d). Mesma técnica de `computeWeekdayEditionDates` em
 * `select-weekly-d1.ts` — aritmética pura de `Date`, sem lógica manual de
 * calendário (vírgula de mês/ano resolvida automaticamente).
 *
 * Não valida que `publishMonday` seja de fato uma segunda-feira — quem monta
 * a data (CLI/skill) é responsável por isso.
 */
export function contentWindowFromPublishMonday(publishMonday: Date): string[] {
  const dates: string[] = [];
  for (let offset = 7; offset >= 3; offset--) {
    const d = new Date(
      publishMonday.getFullYear(),
      publishMonday.getMonth(),
      publishMonday.getDate() - offset,
    );
    dates.push(formatAAMMDD(d));
  }
  return dates;
}

/**
 * Pure: ciclo `{YY}w{WW}` derivado da semana de CONTEÚDO (a partir do AAMMDD
 * da segunda de conteúdo — primeiro elemento de `contentWindowFromPublishMonday`).
 */
export function cycleFromContentMonday(contentMonday: Date): string {
  return isoWeekLabel(contentMonday);
}

export interface WeeklyLinkedinResolution {
  /** Ciclo `{YY}w{WW}`, derivado da semana de CONTEÚDO. */
  cycle: string;
  /** AAMMDD da segunda de publicação (a data passada pelo editor/skill). */
  publishMonday: string;
  /** 5 AAMMDD (segunda a sexta) da semana de conteúdo coberta. */
  contentWindow: string[];
}

/**
 * Pure: resolve ciclo + janela de conteúdo a partir do AAMMDD da segunda de
 * PUBLICAÇÃO — o argumento explícito que a skill exige do editor (nunca
 * inferido de `today()`, mesmo invariante do resto do pipeline). `null` se
 * `publishMondayAAMMDD` não for um AAMMDD válido.
 */
export function resolveWeeklyLinkedinCycle(publishMondayAAMMDD: string): WeeklyLinkedinResolution | null {
  const publishMonday = parseAAMMDD(publishMondayAAMMDD);
  if (!publishMonday) return null;
  const contentWindow = contentWindowFromPublishMonday(publishMonday);
  const contentMonday = parseAAMMDD(contentWindow[0]);
  if (!contentMonday) return null;
  return {
    cycle: cycleFromContentMonday(contentMonday),
    publishMonday: publishMondayAAMMDD,
    contentWindow,
  };
}

/** Diretório-base de um ciclo (`data/weekly/{cycle}`). Path relativo — caller resolve contra a raiz do repo. */
export function weeklyLinkedinRelDir(cycle: string): string {
  return `data/weekly/${cycle}`;
}

/**
 * Extrai `--publish-monday AAMMDD` (ou `--publish-monday=AAMMDD`) do argv.
 * Retorna `""` se ausente — caller decide se aborta/pergunta (mesmo padrão de
 * `parseMonthlyCycleArg`, que nunca lança).
 */
export function parsePublishMondayArg(argv: string[]): string {
  const eq = argv.find((a) => a.startsWith("--publish-monday="));
  if (eq) return eq.split("=")[1] ?? "";
  const i = argv.indexOf("--publish-monday");
  return i !== -1 ? (argv[i + 1] ?? "") : "";
}
