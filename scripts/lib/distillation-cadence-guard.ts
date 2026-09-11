/**
 * scripts/lib/distillation-cadence-guard.ts (#7981, Camada 3 da #7972 — Fase 7)
 *
 * Teto de disparos automáticos de `distill-prompt-corrections.ts` por
 * semana, somando TODOS os tipos de pedido (issue #7981: "Teto de disparos
 * automáticos por semana somando todos os tipos de pedido"). Mesmo padrão
 * de `calibration-cadence-guard.ts` (#7979) — janela rolante estrita de 7
 * dias, lança em `nowIso` malformado (fail-hard, não fail-permissivo —
 * achado de review do #7979 que este módulo já nasce corrigido).
 */

export const MAX_DISTILLATION_TRIGGERS_PER_WEEK = 1;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DistillationCadenceState {
  /** Timestamps ISO de cada disparo anterior (bem-sucedido ou não — um disparo que rodou já conta, mesmo que o resultado tenha sido "sem padrão suficiente"). */
  triggeredAt: readonly string[];
}

export interface DistillationCadenceDecision {
  canTrigger: boolean;
  triggersThisWeek: number;
  reason: string | null;
}

function countInLastWeek(timestamps: readonly string[], nowMs: number): number {
  return timestamps.filter((t) => {
    const ts = new Date(t).getTime();
    return !Number.isNaN(ts) && nowMs - ts < WEEK_MS && nowMs - ts >= 0;
  }).length;
}

/** Lança se `nowIso` não parsear — mesma disciplina de `calibration-cadence-guard.ts::evaluateCadence` (nunca degrada pra "tudo permitido" com input malformado). */
export function evaluateDistillationCadence(state: DistillationCadenceState, nowIso: string): DistillationCadenceDecision {
  const nowMs = new Date(nowIso).getTime();
  if (Number.isNaN(nowMs)) {
    throw new Error(`evaluateDistillationCadence: nowIso "${nowIso}" não é uma data ISO válida.`);
  }
  const triggersThisWeek = countInLastWeek(state.triggeredAt, nowMs);
  const canTrigger = triggersThisWeek < MAX_DISTILLATION_TRIGGERS_PER_WEEK;
  return {
    canTrigger,
    triggersThisWeek,
    reason: canTrigger ? null : `teto semanal: ${triggersThisWeek}/${MAX_DISTILLATION_TRIGGERS_PER_WEEK} disparo(s) já nos últimos 7 dias.`,
  };
}
