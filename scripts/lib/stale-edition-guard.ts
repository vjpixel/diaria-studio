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
  /**
   * O sentinel existe mas os outputs dele não (Stage 5 exit 2): o sentinel
   * chegou antes dos arquivos no sync. Aí um registro de OUTRO host que cobre
   * o stage vale como sinal mesmo com o sentinel local presente.
   */
  outputsMissing?: boolean;
  /** Arquivo `edition-lock` existe mas está corrompido/ilegível (sync em trânsito): fail-closed. */
  lockUnreadable?: boolean;
  /** Relógio (ms) para a janela do tombstone de interrupção (#11713). Default `Date.now()`. */
  now?: number;
}

/**
 * Por quanto tempo um tombstone de interrupção (release simples, #11713) de
 * OUTRO host conta como sinal. Diferente do de conclusão, que se resolve
 * sozinho quando o sentinel sincroniza, o de interrupção não tem condição de
 * saída: sem janela, todo `abortar` num host exigiria `--force` no outro para
 * sempre. 6 h cobre com folga o atraso normal do OneDrive (minutos); queda
 * de sync mais longa é a classe dos alarmes de sync (#5548), não deste guard.
 */
export const INTERRUPTED_TOMBSTONE_WINDOW_MS = 6 * 3_600_000;

export type StaleSignal =
  | { kind: "unreadable_lock" }
  | { kind: "later_sentinel"; step: number }
  | { kind: "remote_lock"; host: string; stage: number; heartbeat_at: string }
  /** Tombstone de release (aprovação normal) de outro host, sentinel do stage não chegou. */
  | { kind: "remote_completed"; host: string; stage: number; released_at: string }
  /** Tombstone de release simples (`editar`/`abortar`/halt) de outro host, recente (#11713). */
  | { kind: "remote_interrupted"; host: string; stage: number; released_at: string };

export interface StaleEditionVerdict {
  ok: boolean;
  signals: StaleSignal[];
}

/**
 * Sinais (qualquer um bloqueia; sem nenhum → ok). Só bloqueia com evidência:
 *  - sentinel de stage SEGUINTE local;
 *  - trava viva/vencida de OUTRO host (ou de host ilegível) cobrindo `step`;
 *  - tombstone de conclusão (`completed_stage`, ver edition-lock) de OUTRO host
 *    cobrindo `step`, com o sentinel desse stage ausente (ou `outputsMissing`).
 *    Cobre o caso em que a remoção da trava sincroniza antes do sentinel.
 *  - tombstone de interrupção (`interrupted_stage`, #11713) de OUTRO host
 *    cobrindo `step`, solto há menos de `INTERRUPTED_TOMBSTONE_WINDOW_MS`
 *    (`released_at` ilegível conta como recente). Independe do sentinel: o
 *    stage não concluiu lá, mas um arquivo editado lá pode estar em trânsito.
 * Mesma máquina com estado consistente nunca bloqueia. `stage` ilegível conta
 * como à frente (fail-closed).
 */
export function assessStaleEdition(f: StaleEditionFacts): StaleEditionVerdict {
  const signals: StaleSignal[] = [];
  for (const s of [...f.sentinelSteps].sort((a, b) => a - b)) {
    if (s > f.step) signals.push({ kind: "later_sentinel", step: s });
  }
  if (f.lockUnreadable) signals.push({ kind: "unreadable_lock" });
  const l = f.lock;
  const otherHost = !!l && (typeof l.host !== "string" || l.host === "" || l.host !== f.localHost);
  if (l && otherHost) {
    const hostLabel = typeof l.host === "string" && l.host ? l.host : "(host ilegível)";
    if (l.released_at && l.interrupted_stage !== undefined) {
      const stage = Number.isFinite(l.interrupted_stage) ? l.interrupted_stage : Number.POSITIVE_INFINITY;
      const rel = Date.parse(l.released_at);
      const age = Number.isFinite(rel) ? (f.now ?? Date.now()) - rel : 0;
      if (stage >= f.step && age <= INTERRUPTED_TOMBSTONE_WINDOW_MS) {
        signals.push({ kind: "remote_interrupted", host: hostLabel, stage: l.interrupted_stage, released_at: l.released_at });
      }
    } else if (l.released_at) {
      // Tombstone: só vale com o stage concluído lá e o sentinel dele não chegado aqui.
      const done = Number.isFinite(l.completed_stage) ? (l.completed_stage as number) : Number.POSITIVE_INFINITY;
      if (done >= f.step && (f.outputsMissing || !f.sentinelSteps.includes(f.step))) {
        signals.push({ kind: "remote_completed", host: hostLabel, stage: l.completed_stage ?? Number.NaN, released_at: l.released_at });
      }
    } else {
      const lockStage = Number.isFinite(l.stage) ? l.stage : Number.POSITIVE_INFINITY;
      if (lockStage >= f.step) {
        signals.push({ kind: "remote_lock", host: hostLabel, stage: l.stage, heartbeat_at: l.heartbeat_at });
      }
    }
  }
  return { ok: signals.length === 0, signals };
}

export function describeSignals(signals: StaleSignal[]): string {
  return signals
    .map((s) =>
      s.kind === "later_sentinel"
        ? `sentinel do Stage ${s.step} já existe`
        : s.kind === "unreadable_lock"
          ? "edition-lock corrompido/ilegível (sync em trânsito?)"
          : s.kind === "remote_interrupted"
          ? `outro host (${s.host}) soltou o Stage ${Number.isFinite(s.stage) ? s.stage : "?"} sem concluir em ${s.released_at} (editar/abortar/halt), arquivos editados lá podem não ter sincronizado`
          : s.kind === "remote_completed"
          ? `outro host (${s.host}) concluiu o Stage ${Number.isFinite(s.stage) ? s.stage : "?"} em ${s.released_at}, sentinel/outputs ainda não sincronizados`
          : `edition-lock de outro host (${s.host}, Stage ${Number.isFinite(s.stage) ? s.stage : "?"}, heartbeat ${s.heartbeat_at})`,
    )
    .join("; ");
}
