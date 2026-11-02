/**
 * raffle-month-preflight.ts (#11896)
 *
 * Avisa ANTES da virada de mês que `platform.config.json` →
 * `raffle.sorteio_do_mes` precisa do dia do sorteio do mês seguinte.
 *
 * Contexto: o dia do sorteio do erro intencional muda todo mês e quem escolhe
 * é o editor (não existe "dia fixo", #4583). Por isso o dia NÃO é derivável da
 * data da edição — a 1ª opção sugerida na #11896 não tem regra pra seguir. O
 * que dá pra fazer é antecipar o aviso: `inject-champions-callout.ts` (Stage 3)
 * aborta na 1ª edição do mês quando `sorteio_do_mes.mes` ainda aponta pro mês
 * anterior (guard correto, #4583 — publicar a data velha seria pior), e esse
 * abort no meio da edição é o que travou a 261103. Este módulo, chamado no
 * Stage 0 via `scripts/check-raffle-month.ts`, transforma a mesma condição em:
 *
 *  - `upcoming-month-stale`: a edição cai nos últimos `leadDays` dias do mês e
 *    `sorteio_do_mes.mes` ainda não é o mês seguinte → aviso (nunca bloqueia),
 *    dias antes da 1ª edição do mês seguinte;
 *  - `current-month-stale`: a edição É a 1ª do mês e `sorteio_do_mes.mes`
 *    diverge → o Stage 3 vai parar; o Stage 0 pede o dia já no início da
 *    edição, em vez de a pergunta aparecer só no meio do Stage 3.
 *
 * Puro: o caller resolve `isFirstEditionOfMonth` (que depende de
 * `past-editions-raw.json`) e passa o booleano.
 */

export interface RaffleMonthInput {
  /** Edição AAMMDD. */
  edition: string;
  /** `platform.config.json` → `raffle` (ou undefined se ausente). */
  raffle: { sorteio_do_mes?: { mes?: unknown; dia?: unknown } } | undefined | null;
  /** A edição é a 1ª publicada do mês (`isFirstEditionOfMonth`). */
  isFirstOfMonth: boolean;
  /** Janela do aviso antecipado, em dias até a virada. Default 5: cobre um
   * fim de semana sem edição entre o último dia útil e a virada. */
  leadDays?: number;
}

export type RaffleMonthVerdict =
  | { kind: "no-raffle-config" }
  | { kind: "invalid-edition" }
  | { kind: "ok"; configuredMes: string | null; editionMes: string }
  | { kind: "current-month-stale"; configuredMes: string | null; editionMes: string }
  | {
      kind: "upcoming-month-stale";
      configuredMes: string | null;
      editionMes: string;
      nextMes: string;
      daysUntilNextMonth: number;
    };

export const DEFAULT_RAFFLE_LEAD_DAYS = 5;

/** AAMMDD → { y, m (1-12), d } ou null. */
function parseEdition(edition: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(edition);
  if (!match) return null;
  const y = 2000 + Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
}

function slug(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function assessRaffleMonth(input: RaffleMonthInput): RaffleMonthVerdict {
  if (!input.raffle) return { kind: "no-raffle-config" };
  const parsed = parseEdition(input.edition);
  if (!parsed) return { kind: "invalid-edition" };

  const rawMes = input.raffle.sorteio_do_mes?.mes;
  const configuredMes = typeof rawMes === "string" ? rawMes : null;
  const editionMes = slug(parsed.y, parsed.m);

  // 1ª edição do mês com o mês errado: é exatamente a condição em que o
  // Stage 3 (`inject-champions-callout.ts`) aborta. Vence o aviso antecipado.
  if (input.isFirstOfMonth && configuredMes !== editionMes) {
    return { kind: "current-month-stale", configuredMes, editionMes };
  }

  const nextY = parsed.m === 12 ? parsed.y + 1 : parsed.y;
  const nextM = parsed.m === 12 ? 1 : parsed.m + 1;
  const nextMes = slug(nextY, nextM);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilNextMonth = Math.round(
    (Date.UTC(nextY, nextM - 1, 1) - Date.UTC(parsed.y, parsed.m - 1, parsed.d)) / msPerDay,
  );
  const leadDays = input.leadDays ?? DEFAULT_RAFFLE_LEAD_DAYS;
  if (daysUntilNextMonth <= leadDays && configuredMes !== nextMes) {
    return { kind: "upcoming-month-stale", configuredMes, editionMes, nextMes, daysUntilNextMonth };
  }

  return { kind: "ok", configuredMes, editionMes };
}

/** Texto humano do veredito (null quando não há nada a avisar). */
export function describeRaffleMonthVerdict(v: RaffleMonthVerdict): string | null {
  switch (v.kind) {
    case "current-month-stale":
      return (
        `raffle.sorteio_do_mes.mes = ${v.configuredMes ?? "ausente"}, mas esta é a 1ª edição de ${v.editionMes}: ` +
        `o Stage 3 (inject-champions-callout.ts) vai parar. Atualize platform.config.json → raffle.sorteio_do_mes ` +
        `para { "mes": "${v.editionMes}", "dia": N } com o dia do sorteio deste mês.`
      );
    case "upcoming-month-stale":
      return (
        `virada de mês em ${v.daysUntilNextMonth} dia(s): raffle.sorteio_do_mes.mes = ${v.configuredMes ?? "ausente"}. ` +
        `Antes da 1ª edição de ${v.nextMes}, atualize platform.config.json → raffle.sorteio_do_mes para ` +
        `{ "mes": "${v.nextMes}", "dia": N } com o dia do sorteio; sem isso o Stage 3 daquela edição para.`
      );
    default:
      return null;
  }
}
