/**
 * stale-edition-guard.ts (#11690) — detecta "data/ defasado, outra máquina à frente".
 *
 * Achado na 261030: gate 4 aprovado no Neo, sentinel ainda não sincronizado
 * (OneDrive) no 300; o Stage 4 re-rodou inteiro por cima e o sync devolveu o
 * clobber. Quando o sentinel do stage anterior/atual está AUSENTE, só vale
 * re-rodar se nada indicar que outro host está à frente.
 *
 * Fail-closed: qualquer sinal bloqueia. Sem sinal (mesma máquina, estado
 * consistente) → `ok`. Puro, sem I/O (o CLI coleta os fatos).
 */
import type { EditionLockRecord } from "./edition-lock.ts";

export interface StaleEditionFacts {
  /** Stage cujo sentinel está ausente e que o caller quer (re)rodar/pré-requisitar. */
  step: number;
  /** Steps (1..6) cujo `.step-N-done.json` existe localmente. */
  sentinelSteps: number[];
  lock: EditionLockRecord | null;
  localHost: string;
}

export type StaleSignal =
  | { kind: "later_sentinel"; step: number }
  | { kind: "remote_lock"; host: string; stage: number; heartbeat_at: string };

export interface StaleEditionVerdict {
  ok: boolean;
  signals: StaleSignal[];
}

export function assessStaleEdition(f: StaleEditionFacts): StaleEditionVerdict {
  const signals: StaleSignal[] = [];
  for (const s of [...f.sentinelSteps].sort((a, b) => a - b)) {
    if (s > f.step) signals.push({ kind: "later_sentinel", step: s });
  }
  // Trava de outro host (qualquer idade: heartbeat velho = data/ velho, não host morto).
  // `stage` ilegível (não numérico) conta como à frente: fail-closed.
  const lockStage = Number.isFinite(f.lock?.stage) ? f.lock!.stage : Number.POSITIVE_INFINITY;
  if (f.lock && typeof f.lock.host === "string" && f.lock.host && f.lock.host !== f.localHost && lockStage >= f.step) {
    signals.push({
      kind: "remote_lock",
      host: f.lock.host,
      stage: f.lock.stage,
      heartbeat_at: f.lock.heartbeat_at,
    });
  }
  return { ok: signals.length === 0, signals };
}

export function describeSignals(signals: StaleSignal[]): string {
  return signals
    .map((s) =>
      s.kind === "later_sentinel"
        ? `sentinel do Stage ${s.step} já existe`
        : `edition-lock de outro host (${s.host}, Stage ${s.stage}, heartbeat ${s.heartbeat_at})`,
    )
    .join("; ");
}
