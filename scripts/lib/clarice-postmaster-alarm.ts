/**
 * lib/clarice-postmaster-alarm.ts (#5399 achado 2)
 *
 * Lógica PURA (sem I/O) do alarme de sinal de spam do Postmaster degradado
 * pra `indeterminate` por staleness — mesmo molde de
 * `scripts/lib/clarice-opens-catchup-alarm.ts`.
 *
 * Contexto: o freio de ISP (`decideBrake`, `scripts/lib/clarice-envio-policy.ts`)
 * já é fail-safe por desenho quando `spamSignal.source === "indeterminate"`
 * (assume 70% de utilização — `INDETERMINATE_SPAM_UTIL` —, nunca acelera,
 * nunca para sozinho). O problema NÃO é o freio decidir errado; é que
 * `clarice-envio-alarm.ts`, `clarice-envio-guard-alarm.ts`,
 * `clarice-guardrail-alarm.ts` e `clarice-opens-catchup-alarm.ts` — os 4
 * alarmes já wired do domínio Clarice — não têm NENHUMA referência a
 * postmaster (grep limpo, achado ao vivo 16/08/2026): o operador pode decidir
 * volume MANUALMENTE sem saber que o sinal primário de spam está cego.
 *
 * `isPostmasterEntryStale` reimplementa só o eixo `date`/`POSTMASTER_DATA_STALE_MS`
 * de `resolveSpamSignal` (`workers/brevo-dashboard/src/thresholds.ts`, branch
 * `"date-stale"`) — de propósito, pra este alarme não precisar do shape
 * completo de `PostmasterSpamEntry`/`SpamSignal`, só da `date`. Cobre também
 * `entry === null` (nenhuma leitura chegou ainda) como stale — mesmo
 * fail-safe de `resolveSpamSignal(null, now)`.
 *
 * ─── Por que N ciclos consecutivos, não a 1ª leitura stale isolada ─────────
 *
 * O sync roda a cada 12h (`Diaria-Postmaster-Spam-Sync`). Uma checagem
 * isolada pegando o meio de uma janela de atraso normal (ex: o sync ainda
 * não rodou hoje, mas roda em instantes) não é sinal de nada quebrado — 2
 * ciclos CONSECUTIVOS sem uma leitura fresca é. `CONSECUTIVE_STALE_THRESHOLD`
 * decide o N ("por mais de um ciclo", #5399).
 */

import { POSTMASTER_DATA_STALE_MS } from "../../workers/brevo-dashboard/src/thresholds.ts";

export { POSTMASTER_DATA_STALE_MS };

/** N checagens consecutivas com leitura stale antes de alarmar. */
export const CONSECUTIVE_STALE_THRESHOLD = 2;

export interface PostmasterStaleAlarmState {
  consecutiveStale: number;
  /** ISO do último e-mail de alarme enviado pra este streak, ou `null` se
   * ainda não alarmamos (streak resetado, ou ainda abaixo do threshold). */
  lastAlarmedAt: string | null;
  /** ISO da última checagem — só informativo, fora da idempotência. */
  lastCheckedAt: string | null;
}

export function emptyPostmasterStaleAlarmState(): PostmasterStaleAlarmState {
  return { consecutiveStale: 0, lastAlarmedAt: null, lastCheckedAt: null };
}

/**
 * Pure: a leitura está STALE — `entry` ausente, `date` ausente/inválida, ou
 * `date` mais velha que `POSTMASTER_DATA_STALE_MS` em relação a `now`? Mesma
 * regra do branch `"date-stale"` de `resolveSpamSignal` (thresholds.ts),
 * reimplementada aqui contra só o campo `date` — não decide sobre cobertura
 * (`daysWithData`/`daysProbed`, branch `"low-coverage"`) nem sobre gravação
 * stale (`recordedAt`, `POSTMASTER_STALE_MS`) de propósito: aqueles cobrem
 * outras formas de "indeterminate" que não são o achado desta issue (o
 * achado real de 16/08 foi especificamente uma `date` velha).
 */
export function isPostmasterEntryStale(entry: { date: string } | null, now: Date): boolean {
  if (!entry) return true;
  const dateMs = Date.parse(entry.date);
  if (!Number.isFinite(dateMs)) return true;
  return now.getTime() - dateMs > POSTMASTER_DATA_STALE_MS;
}

/**
 * Pure: computa o próximo estado dado a entry mais recente lida do
 * dashboard. Uma leitura FRESCA zera o streak e re-arma o alarme pra próxima
 * ocorrência (mesmo padrão de `clarice-opens-catchup-alarm.ts`).
 */
export function advanceState(
  state: PostmasterStaleAlarmState,
  entry: { date: string } | null,
  now: Date,
): PostmasterStaleAlarmState {
  const lastCheckedAt = now.toISOString();
  if (!isPostmasterEntryStale(entry, now)) {
    return { consecutiveStale: 0, lastAlarmedAt: null, lastCheckedAt };
  }
  return { ...state, consecutiveStale: state.consecutiveStale + 1, lastCheckedAt };
}

/**
 * Pure: `true` quando o streak atingiu o threshold E ainda não alarmamos pra
 * ESTE streak (evita reenviar e-mail a cada checagem enquanto o streak
 * continua crescendo além do threshold).
 */
export function shouldAlarm(state: PostmasterStaleAlarmState): boolean {
  return state.consecutiveStale >= CONSECUTIVE_STALE_THRESHOLD && state.lastAlarmedAt === null;
}

/** Pure: marca este streak como já alarmado. */
export function markAlarmed(state: PostmasterStaleAlarmState, now: Date): PostmasterStaleAlarmState {
  return { ...state, lastAlarmedAt: now.toISOString() };
}

/** Pure: monta assunto + corpo do e-mail de alarme — texto puro, mesmo
 * padrão dos outros alarmes já wired. `issueRef` (#5339-like, opcional) —
 * outcome de `applyAlarmReconciliation` (`scripts/lib/alarm-issues.ts`) pro
 * streak atual. `undefined` (dry-run, ou wiring ainda não chamado) omite a
 * citação sem quebrar nada. */
export function buildPostmasterStaleAlarmEmail(
  state: PostmasterStaleAlarmState,
  entry: { date: string } | null,
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const subject = `[diar.ia.br] sinal de spam do Postmaster está CEGO há ${state.consecutiveStale} checagens seguidas`;

  const lines: string[] = [
    `O sinal de spam do Postmaster (\`spamSignal.source\`) degradou pra`,
    `"indeterminate" por staleness (\`date-stale\`) em ${state.consecutiveStale}`,
    `checagens CONSECUTIVAS da task "Diaria-Postmaster-Spam-Alarm".`,
    "",
    `Última data de leitura conhecida: ${entry?.date ?? "(nenhuma leitura registrada ainda)"}.`,
    "",
    "O freio de ISP (clarice-envio-risk.ts / decideBrake) já é fail-safe por",
    "desenho — assume 70% de utilização quando indeterminate, nunca acelera",
    "sozinho. O risco real é outro: o OPERADOR decidir volume manualmente sem",
    "saber que o sinal primário de spam está cego.",
    "",
    "Verifique a task 'Diaria-Postmaster-Spam-Sync' (docs/postmaster-spam-sync-setup.md",
    "e docs/scheduled-tasks-registry.md) — o sync roda a cada 12h; se parou de",
    "rodar ou está falhando, é isso que precisa de atenção.",
    "",
    "Este alarme não requer nenhuma ação automática — é só um aviso; o freio",
    "de ISP continua operando fail-safe enquanto isso é investigado.",
  ];

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
