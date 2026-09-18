/**
 * scripts/lib/weekly-worker-dlq-alarm.ts (#8310)
 */

export function evaluateWeeklyWorkerDlqAlarm(dlq: number, prev: number) {
  const n = Math.max(0, dlq - prev);
  return n > 0 ? { verdict: "alarm-new-dlq-entry" as const, newEntries: n, note: `DLQ semanal: ${n} nova(s).` } : { verdict: "ok" as const, newEntries: 0, note: "DLQ ok." };
}
