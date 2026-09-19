/**
 * scripts/lib/overnight-waves.ts (#8486)
 *
 * Registro da ONDA do `/diaria-overnight` (#6299) em `plan.json`. Até esta
 * issue o teto de concorrência era só prosa no SKILL.md ("ajustável com
 * medição, não com palpite") e nada gravava o tamanho da onda: a única
 * medição possível era reconstruir concorrência por coincidência de
 * timestamps do `timeline` (lote de N issues divide o mesmo timeline, então
 * "2 issues de 1 lote" e "2 unidades concorrentes" se confundiam), e
 * `active_worktrees` no session-registry é estado corrente, sobrescrito.
 *
 * `plan.waves[]` é o dado que faltava: uma entrada por onda composta, com
 * as unidades de fato despachadas e `cap_hit` — a pergunta que nada
 * respondia: quantas vezes a onda foi TRUNCADA pelo teto. `cap_hit`
 * quase sempre `false` significa que a fila nunca tinha unidades
 * independentes suficientes e o teto não era o limite real.
 *
 * O teto sobe de 3 para 6 (decisão do editor, 19/09/2026) junto com este
 * registro, de modo que a leitura A/B (rondas com pico ≤3 unidades vs. as
 * seguintes) tenha os dois lados medidos com o mesmo instrumento.
 *
 * Puro (sem I/O). CLI: `scripts/record-overnight-wave.ts`.
 */

/** Teto de unidades concorrentes numa onda do overnight (era 3 até #8486). */
export const OVERNIGHT_WAVE_CAP = 6;

export interface OvernightWaveUnit {
  issues: number[];
}

export interface OvernightWaveRecord {
  composed_at: string;
  units: OvernightWaveUnit[];
  unit_count: number;
  /** Unidades compostas mas seguradas por causa do teto (0 = fila coube inteira). */
  deferred_count: number;
  cap: number;
  cap_hit: boolean;
}

export interface BuildWaveInput {
  /** Unidades a despachar, já ordenadas por prioridade. */
  units: number[][];
  /** Unidades prontas que ficaram de fora só por causa do teto. */
  deferred?: number;
  cap?: number;
  now?: Date;
}

/**
 * Pure: monta o registro. Lança se `units` estourar o teto — é o único
 * enforcement MECÂNICO do teto (antes era prosa).
 */
export function buildWaveRecord(input: BuildWaveInput): OvernightWaveRecord {
  const cap = input.cap ?? OVERNIGHT_WAVE_CAP;
  const deferred = input.deferred ?? 0;
  if (!Number.isInteger(deferred) || deferred < 0) {
    throw new Error(`deferred inválido: ${deferred}`);
  }
  if (input.units.length === 0) {
    throw new Error("onda sem unidades — nada a registrar");
  }
  if (input.units.length > cap) {
    throw new Error(`onda com ${input.units.length} unidades estoura o teto ${cap} (#6299/#8486)`);
  }
  for (const u of input.units) {
    if (u.length === 0 || u.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(`unidade inválida: ${JSON.stringify(u)}`);
    }
  }
  return {
    composed_at: (input.now ?? new Date()).toISOString(),
    units: input.units.map((issues) => ({ issues })),
    unit_count: input.units.length,
    deferred_count: deferred,
    cap,
    cap_hit: deferred > 0,
  };
}

/** Pure: devolve cópia do plano com a onda anexada a `waves`. */
export function appendWave<T extends { waves?: unknown }>(
  plan: T,
  record: OvernightWaveRecord,
): T & { waves: OvernightWaveRecord[] } {
  const prev = Array.isArray(plan.waves) ? (plan.waves as OvernightWaveRecord[]) : [];
  return { ...plan, waves: [...prev, record] };
}

export type OvernightWavesCheckResult =
  | { status: "ok"; present: boolean }
  | { status: "invalid"; problems: string[] };

/** Pure: valida `plan.waves`. Ausente → ok (plano legado, fail-open). Nunca lança. */
export function checkOvernightWaves(plan: { waves?: unknown }): OvernightWavesCheckResult {
  if (plan.waves === undefined || plan.waves === null) return { status: "ok", present: false };
  if (!Array.isArray(plan.waves)) return { status: "invalid", problems: ["waves não é array"] };
  const problems: string[] = [];
  plan.waves.forEach((w: unknown, i: number) => {
    const r = w as Partial<OvernightWaveRecord> | null;
    if (!r || typeof r !== "object") {
      problems.push(`waves[${i}] não é objeto`);
      return;
    }
    if (!Array.isArray(r.units) || r.units.length === 0) {
      problems.push(`waves[${i}].units vazio/ausente`);
    } else if (r.unit_count !== r.units.length) {
      problems.push(`waves[${i}].unit_count (${r.unit_count}) ≠ units.length (${r.units.length})`);
    }
    if (typeof r.cap_hit !== "boolean") {
      problems.push(`waves[${i}].cap_hit não é boolean`);
    } else if (r.cap_hit !== ((r.deferred_count ?? 0) > 0)) {
      problems.push(`waves[${i}].cap_hit inconsistente com deferred_count`);
    }
    if (typeof r.composed_at !== "string" || Number.isNaN(Date.parse(r.composed_at))) {
      problems.push(`waves[${i}].composed_at inválido`);
    }
  });
  return problems.length ? { status: "invalid", problems } : { status: "ok", present: true };
}
