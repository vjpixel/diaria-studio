/**
 * scripts/lib/weekly-worker-dlq-alarm.ts (#8310)
 *
 * (1) Função pura de avaliação (já existente) — usada por callers.
 * (2) Caller REAL que passa pelo portão notifyEditor (#7960) — nunca
 *     função pura sem consumidor; a entrada nova no DLQ avisa o editor.
 */

import { notifyEditor } from "./editor-notify.ts";

export function evaluateWeeklyWorkerDlqAlarm(dlq: number, prev: number) {
  const n = Math.max(0, dlq - prev);
  return n > 0 ? { verdict: "alarm-new-dlq-entry" as const, newEntries: n, note: `DLQ semanal: ${n} nova(s).` } : { verdict: "ok" as const, newEntries: 0, note: "DLQ ok." };
}

export async function notifyWeeklyDlqAlarm(newEntries: number, prevDlq: number) {
  const finding = {
    check: "weekly-worker-dlq-alarm",
    severity: (newEntries > 0 ? "acao" : "silencio") as "acao" | "silencio",
    fingerprint: `weekly-dlq-${newEntries}-${prevDlq}`,
    subject: `DLQ semanal: ${newEntries} nova(s) entrada(s)`,
    body: `Reconciliação semanal detectou ${newEntries} entrada(s) nova(s) no DLQ do Worker (anterior=${prevDlq}). Ver verify-weekly-worker-dispatch.ts.`,
  };
  return notifyEditor(finding);
}
