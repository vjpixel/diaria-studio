/**
 * lib/clarice-novos-abort-alarm.ts (#5405 item 1)
 *
 * Lógica PURA (sem I/O) do alarme de abort recorrente do `novos`
 * (`clarice-novos-run.ts`) — mesmo molde de
 * `scripts/lib/clarice-opens-catchup-alarm.ts` (#4740), streak persistido +
 * dedup por `lastAlarmedAt`.
 *
 * Diferente do catch-up de opens (sinal binário ok/error por run), aqui só
 * o motivo `semaphore-red` (abort no guard `clarice-check-semaphore`, D4,
 * #4347) conta pro streak — é ESSE o modo de falha silencioso que a issue
 * pede pra alarmar (D4 continua sendo o comportamento CORRETO; o que faltava
 * era visibilidade quando ele persiste). `sent`/`empty`/`uncertain` (rodada
 * real, sem abort) zeram o streak — recuperou. `other-error` (abort por
 * outro motivo — guard de custo MV, teto D13) NÃO zera nem soma: é um sinal
 * genuinamente diferente, misturar os dois faria o alarme disparar por um
 * motivo e o e-mail descrever outro.
 */
import type { NovosRunStatusValue } from "./clarice-novos-run-status.ts";

/** N aborts consecutivos por semáforo vermelho antes de alarmar. */
export const NOVOS_ABORT_STREAK_THRESHOLD = 3;

export interface NovosAbortAlarmState {
  consecutiveSemaphoreAborts: number;
  /** ISO do último e-mail enviado pra ESTE streak, ou `null` se ainda não alarmamos. */
  lastAlarmedAt: string | null;
  lastCheckedAt: string | null;
}

export function emptyNovosAbortAlarmState(): NovosAbortAlarmState {
  return { consecutiveSemaphoreAborts: 0, lastAlarmedAt: null, lastCheckedAt: null };
}

/**
 * Pure: computa o próximo estado a partir do status mais recente de
 * `clarice-novos-run.ts`. `other-error` é NEUTRO (não soma nem zera) — só
 * atualiza `lastCheckedAt`, mesma disciplina do `not_run` em
 * `clarice-opens-catchup-alarm.ts`.
 */
export function advanceNovosAbortState(
  state: NovosAbortAlarmState,
  status: NovosRunStatusValue,
  now: Date,
): NovosAbortAlarmState {
  const lastCheckedAt = now.toISOString();
  if (status === "other-error") {
    return { ...state, lastCheckedAt };
  }
  if (status === "semaphore-red") {
    return { ...state, consecutiveSemaphoreAborts: state.consecutiveSemaphoreAborts + 1, lastCheckedAt };
  }
  // sent | empty | uncertain — rodada real sem abort, recuperou.
  return { consecutiveSemaphoreAborts: 0, lastAlarmedAt: null, lastCheckedAt };
}

/** Pure: `true` quando o streak atingiu o threshold E ainda não alarmamos pra ESTE streak. */
export function shouldAlarmNovosAbort(state: NovosAbortAlarmState): boolean {
  return state.consecutiveSemaphoreAborts >= NOVOS_ABORT_STREAK_THRESHOLD && state.lastAlarmedAt === null;
}

/** Pure: marca este streak como já alarmado. */
export function markNovosAbortAlarmed(state: NovosAbortAlarmState, now: Date): NovosAbortAlarmState {
  return { ...state, lastAlarmedAt: now.toISOString() };
}

/** Pure: assunto + corpo do e-mail de alarme. `pending` (#5405 item 3,
 * opcional) — quantos cadastros estão represados na janela `novos` e desde
 * quando (mesmo dado que o aviso do plan-wave mostra); omitido quando
 * indisponível (fail-soft — o alarme nunca deixa de disparar por falta
 * desse dado auxiliar). */
export function buildNovosAbortAlarmEmail(
  state: NovosAbortAlarmState,
  latestDetail: string | undefined,
  pending?: { count: number; earliestCreatedIso: string | null } | null,
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const subject = `[diar.ia.br] /diaria-clarice-novos abortando há ${state.consecutiveSemaphoreAborts} execuções seguidas (semáforo vermelho)`;

  const lines: string[] = [
    `A rodada do grupo 'novos' (#4347) abortou por semáforo VERMELHO (D4) em`,
    `${state.consecutiveSemaphoreAborts} execuções CONSECUTIVAS da task diária "Diaria-Clarice-Novos".`,
    "",
    "D4 continua sendo o comportamento CORRETO (não enviar com entregabilidade",
    "comprometida) — este alarme não pede pra revertê-lo. É só o aviso de que o",
    "represamento persiste e precisa de atenção (destravar o semáforo, ou",
    "aceitar o represamento por decisão explícita).",
    "",
  ];

  if (pending && pending.count > 0) {
    lines.push(
      `Fila represada: ${pending.count} cadastro(s)` +
        (pending.earliestCreatedIso ? ` desde ${pending.earliestCreatedIso}.` : "."),
      "",
    );
  }

  if (latestDetail) {
    lines.push(`Último detalhe do abort: ${latestDetail}`, "");
  }

  lines.push(
    "Verifique o dashboard Clarice (circuit breakers de entregabilidade) e o",
    "relatório mais recente em data/clarice-subscribers/novos-reports/*-abort.md.",
  );

  if (issueRef) {
    lines.push(
      "",
      issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`,
    );
  }

  return { subject, body: lines.join("\n") };
}
