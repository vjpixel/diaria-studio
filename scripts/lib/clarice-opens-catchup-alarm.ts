/**
 * lib/clarice-opens-catchup-alarm.ts (#4740, #4722 item 4)
 *
 * Lógica PURA (sem I/O) do alarme de falha sustentada no catch-up de opens
 * do `clarice-sync-brevo.ts --incremental` (#4688) — mesmo molde de
 * `scripts/lib/apoios-diff-alarm.ts` / `scripts/lib/cursos-error-alarm.ts`.
 *
 * Contexto: `opens_catchup.error` aparece no summary JSON quando o catch-up
 * falha totalmente, mas é fail-soft por design (nunca reprova o sync
 * principal) — então uma falha RECORRENTE passaria despercebida
 * indefinidamente, mesma classe de gap que o #4688 original resolveu pra
 * `opens_count` (que degradava silenciosamente ~32% antes de ser percebido),
 * só que um nível acima: agora é o próprio mecanismo de correção que pode
 * parar de funcionar sem ninguém notar.
 *
 * ─── Por que N consecutivas, não a 1ª falha isolada ────────────────────────
 *
 * 1 falha isolada é normal (rede, rate-limit transitório da Brevo) — a task
 * roda diariamente, e um blip não é sinal de nada quebrado. N falhas
 * CONSECUTIVAS é sinal real de algo sistemicamente quebrado (credencial
 * expirada, endpoint mudou, etc). `CONSECUTIVE_FAILURE_THRESHOLD` decide o N.
 *
 * ─── Idempotência: streak, não fingerprint de conteúdo ─────────────────────
 *
 * Diferente de `apoios-diff-alarm.ts` (fingerprint do diff), aqui o sinal é
 * binário por run (ok/error/not_run) — o estado é um CONTADOR de falhas
 * consecutivas. `not_run` (catch-up não executou neste ciclo — modo full,
 * `--no-catch-opens`) é NEUTRO: não soma nem zera o streak, porque não é
 * nem sucesso nem falha do mecanismo. Um `ok` zera o streak (recuperou) E
 * re-arma o alarme (`lastAlarmedAt: null`) — a próxima vez que a falha
 * sustentada reaparecer, alarma de novo. Enquanto o streak ficar acima do
 * threshold sem nenhum `ok` no meio, `lastAlarmedAt` não-null evita reenviar
 * o MESMO e-mail a cada checagem subsequente.
 */

import type { OpensCatchupStatus } from "./extract-opens-catchup-status.ts";

/** N falhas consecutivas do catch-up antes de alarmar. */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

export interface OpensCatchupAlarmState {
  consecutiveFailures: number;
  /** ISO do último e-mail de alarme enviado pra este streak, ou `null` se
   * ainda não alarmamos (streak resetado, ou ainda abaixo do threshold). */
  lastAlarmedAt: string | null;
  /** ISO da última checagem — só informativo ("desde X"), fora da idempotência. */
  lastCheckedAt: string | null;
}

export function emptyOpensCatchupAlarmState(): OpensCatchupAlarmState {
  return { consecutiveFailures: 0, lastAlarmedAt: null, lastCheckedAt: null };
}

/**
 * Pure: computa o próximo estado dado o status mais recente extraído do log.
 * `not_run` não altera o streak (nem soma nem zera) — só atualiza
 * `lastCheckedAt`.
 */
export function advanceState(
  state: OpensCatchupAlarmState,
  status: OpensCatchupStatus,
  now: Date,
): OpensCatchupAlarmState {
  const lastCheckedAt = now.toISOString();
  if (status.status === "not_run") {
    return { ...state, lastCheckedAt };
  }
  if (status.status === "ok") {
    // Recuperou — zera o streak e re-arma o alarme pra próxima ocorrência.
    return { consecutiveFailures: 0, lastAlarmedAt: null, lastCheckedAt };
  }
  return { ...state, consecutiveFailures: state.consecutiveFailures + 1, lastCheckedAt };
}

/**
 * Pure: `true` quando o streak atingiu o threshold E ainda não alarmamos
 * pra ESTE streak (evita reenviar e-mail a cada checagem enquanto o streak
 * continua crescendo além do threshold).
 */
export function shouldAlarm(state: OpensCatchupAlarmState): boolean {
  return state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD && state.lastAlarmedAt === null;
}

/** Pure: marca este streak como já alarmado. */
export function markAlarmed(state: OpensCatchupAlarmState, now: Date): OpensCatchupAlarmState {
  return { ...state, lastAlarmedAt: now.toISOString() };
}

/** Pure: monta assunto + corpo do e-mail de alarme — texto puro, mesmo
 * padrão de `apoios-diff-alarm.ts`. */
export function buildOpensCatchupAlarmEmail(
  state: OpensCatchupAlarmState,
  latestError: string | undefined,
): { subject: string; body: string } {
  const subject = `[diar.ia.br] catch-up de opens da Clarice falhando há ${state.consecutiveFailures} execuções seguidas`;

  const lines: string[] = [
    `O catch-up de opens (#4688) do clarice-sync-brevo.ts --incremental falhou`,
    `${state.consecutiveFailures} vezes CONSECUTIVAS na task diária "Diaria-Clarice-Sync".`,
    "",
    "O catch-up é fail-soft por design — o sync principal (store SQLite) segue",
    "atualizando normalmente. Mas sem o catch-up, opens_count volta a degradar",
    "silenciosamente (a subcontagem ~32% que o #4688 original corrigiu).",
    "",
  ];

  if (latestError) {
    lines.push(`Último erro: ${latestError}`, "");
  }

  lines.push(
    "Verifique data/clarice-subscribers/.brevo-sync-daily.log (últimas execuções)",
    "e confirme BREVO_CLARICE_API_KEY / conectividade com a Brevo.",
    "",
    "Este alarme não requer nenhuma ação automática — é só um aviso; o sync",
    "principal continua rodando normalmente enquanto isso é investigado.",
  );

  return { subject, body: lines.join("\n") };
}
