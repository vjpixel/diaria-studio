/**
 * scripts/lib/aquisicao-reconcile-alarm.ts (#8591 item 3)
 *
 * Decide, de forma pura, quando o fator de superestimação
 * (`aquisicao-reconcile.ts::computeFactor`, `reported_conversions /
 * coorte_real`) de um canal saiu de uma FAIXA aceitável — sinal de que o
 * pixel/tag de conversão do painel descolou da coorte real que nós medimos
 * (o caso concreto que motivou esta issue: #8572, Meta contando 2,4×).
 *
 * ## Por que FAIXA, não um valor fixo (ex: "tem que dar 1,0")
 *
 * A Meta atribui por janela de clique de 7 dias, independente de UTM — quem
 * clicou no anúncio e se cadastrou por outro caminho conta pra ela e não
 * pro `utm_source`. Um fator de 1,0 nunca é esperado; a faixa abaixo cobre
 * o ruído normal de janela de atribuição sem deixar passar o caso patológico
 * (#8572 foi 2,4×, bem fora de qualquer leitura de ruído).
 *
 * ## Limiares (documentados aqui, #8591 pede "escolher e documentar")
 *
 *   - `RECONCILE_DRIFT_HIGH_FACTOR = 1.5` — painel reportando 50%+ mais
 *     conversões do que a coorte real mede.
 *   - `RECONCILE_DRIFT_LOW_FACTOR = 1 / 1.5 ≈ 0.667` — simétrico em log: um
 *     painel subcontando na mesma proporção é igualmente um sinal de tag
 *     quebrada (dedup capturando de mais, evento não disparando), não só a
 *     superestimação que deu nome ao mecanismo.
 *   - `RECONCILE_MIN_VOLUME_REAL = 20` — piso de coorte real (soma da
 *     janela) abaixo do qual o fator é ruído estatístico, não sinal: com
 *     poucos cadastros um único evento perdido/duplicado move o fator em
 *     dezenas de %. Mesmo piso que `leitor-v1` já usa como "volume mínimo
 *     confiável" (`scripts/lib/leitor.ts`, CLAUDE.md) — não é coincidência,
 *     é a mesma disciplina de não decidir nada sobre uma amostra pequena
 *     demais pra ter poder estatístico.
 *   - `RECONCILE_WINDOW_DAYS = 7` — agrega a soma de `reported_conversions`
 *     e `coorte_real` dos últimos 7 dias por canal (nunca a MÉDIA dos
 *     fatores diários — que pesaria igual um dia de 2 cadastros e um dia de
 *     40) antes de calcular o fator da janela. Isso também é o motivo pelo
 *     qual este alarme naturalmente não dispara nos primeiros dias depois
 *     de `Diaria-Aquisicao-Reconcile-Daily` entrar no ar: a soma de 7 dias
 *     só atinge o piso de volume depois de a série ter volume — sem
 *     precisar de um cutover manual de "log-only" pra "alarme de verdade".
 *
 * Alterar qualquer um destes 4 números é uma decisão editorial (muda o que
 * dispara alarme) — mudar aqui, não em duplicata no chamador.
 */
import type { FactorResult, FactorRow } from "../aquisicao-reconcile.ts";

export const RECONCILE_DRIFT_HIGH_FACTOR = 1.5;
export const RECONCILE_DRIFT_LOW_FACTOR = 1 / RECONCILE_DRIFT_HIGH_FACTOR;
export const RECONCILE_MIN_VOLUME_REAL = 20;
export const RECONCILE_WINDOW_DAYS = 7;

/** Uma linha de fator já calculada (`FactorRow`) com o dia BRT a que pertence. */
export interface DatedFactorRow extends FactorRow {
  day: string;
}

export type ReconcileDriftStatus = "alto" | "baixo" | "ok" | "volume-insuficiente";

export interface ReconcileDriftEvaluation {
  channel: string;
  cohort_key: string;
  /** Soma de `reported_conversions` na janela. */
  reported_sum: number;
  /** Soma de `coorte_real` na janela. */
  real_sum: number;
  /** `reported_sum / real_sum` — `null` quando `real_sum` é 0 (sem dado, nunca fabricado). */
  factor: number | null;
  status: ReconcileDriftStatus;
  /** Quantos dias distintos da janela contribuíram alguma linha para este canal. */
  days_with_data: number;
}

/**
 * Agrega `rows` (histórico de `FactorResult.rows` de vários dias, já
 * filtrado pra dentro da janela de `windowDays` pelo chamador — esta função
 * não olha data "hoje", só soma o que recebe) por `cohort_key` e classifica
 * cada canal contra a faixa/piso de volume.
 *
 * @pure
 */
export function evaluateReconcileDrift(
  rows: readonly DatedFactorRow[],
  opts: {
    highFactor?: number;
    lowFactor?: number;
    minVolumeReal?: number;
  } = {},
): ReconcileDriftEvaluation[] {
  const highFactor = opts.highFactor ?? RECONCILE_DRIFT_HIGH_FACTOR;
  const lowFactor = opts.lowFactor ?? RECONCILE_DRIFT_LOW_FACTOR;
  const minVolumeReal = opts.minVolumeReal ?? RECONCILE_MIN_VOLUME_REAL;

  const byChannel = new Map<string, { cohortKey: string; reported: number; real: number; days: Set<string> }>();
  for (const row of rows) {
    if (!Number.isFinite(row.reported_conversions) || !Number.isFinite(row.coorte_real)) continue;
    const entry = byChannel.get(row.channel) ?? {
      cohortKey: row.cohort_key,
      reported: 0,
      real: 0,
      days: new Set<string>(),
    };
    entry.reported += row.reported_conversions;
    entry.real += row.coorte_real;
    entry.days.add(row.day);
    byChannel.set(row.channel, entry);
  }

  const out: ReconcileDriftEvaluation[] = [];
  for (const [channel, entry] of byChannel) {
    const factor = entry.real > 0 ? entry.reported / entry.real : null;
    let status: ReconcileDriftStatus;
    if (entry.real < minVolumeReal || factor === null) {
      status = "volume-insuficiente";
    } else if (factor > highFactor) {
      status = "alto";
    } else if (factor < lowFactor) {
      status = "baixo";
    } else {
      status = "ok";
    }
    out.push({
      channel,
      cohort_key: entry.cohortKey,
      reported_sum: entry.reported,
      real_sum: entry.real,
      factor,
      status,
      days_with_data: entry.days.size,
    });
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel));
}

/** Achata `FactorResult`s indexados por dia BRT em `DatedFactorRow[]` — helper
 *  de conveniência pro chamador que lê vários `{day}.fator.json` do disco.
 *
 *  @pure
 */
export function flattenFactorResultsByDay(byDay: ReadonlyMap<string, FactorResult>): DatedFactorRow[] {
  const out: DatedFactorRow[] = [];
  for (const [day, result] of byDay) {
    for (const row of result.rows) out.push({ ...row, day });
  }
  return out;
}
