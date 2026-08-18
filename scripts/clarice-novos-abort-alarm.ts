#!/usr/bin/env node
/**
 * scripts/clarice-novos-abort-alarm.ts (#5405 item 1)
 *
 * DESATIVADO desde #5660: o guard D4 foi removido do caminho `clarice-novos`,
 * portanto `semaphore-red` deixou de ser um status produzido por
 * `clarice-novos-run.ts`. O entrypoint permanece como no-op explícito para
 * evitar que uma unit/manual invocation antiga leia estado histórico e envie
 * um alarme baseado em um status que nunca mais será escrito.
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-abort-alarm.ts [--dry-run] [--to email@x]
 *
 *   --dry-run  também permanece dormente; nenhum estado é lido ou gravado.
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Estado (idempotência): `data/clarice-subscribers/novos-abort-alarm-state.json`.
 *
 * @see scripts/lib/clarice-novos-abort-alarm.ts (lógica pura)
 * @see scripts/lib/clarice-novos-run-status.ts (fonte do status por rodada)
 */
import { isMainModule } from "./lib/cli-args.ts";
import { NOVOS_ABORT_STREAK_THRESHOLD, type NovosAbortAlarmState } from "./lib/clarice-novos-abort-alarm.ts";
import type { AlarmFinding } from "./lib/alarm-issues.ts";

const LOG_PREFIX = "[clarice-novos-abort-alarm]";
export const NOVOS_ABORT_ALARM_DORMANT = true;

/** Legacy pure formatter retained for historical report/test consumers. */
export function toAlarmFinding(state: NovosAbortAlarmState, latestDetail: string | undefined): AlarmFinding {
  return {
    check: "clarice-novos-abort",
    fingerprint: "semaphore-streak",
    family: "estado",
    title: `[diar.ia.br] /diaria-clarice-novos abortando (streak ${state.consecutiveSemaphoreAborts})`,
    body: [
      "Achado histórico do alarme `Diaria-Clarice-Novos-Abort-Alarm`.",
      `Aborts consecutivos por semáforo vermelho (D4): ${state.consecutiveSemaphoreAborts} (threshold: ${NOVOS_ABORT_STREAK_THRESHOLD}).`,
      latestDetail ? `Último detalhe: ${latestDetail}` : "Sem detalhe adicional no status mais recente.",
      "Este formatter não é chamado pelo entrypoint dormente desde #5660.",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

async function main(): Promise<void> {
  console.log(`${LOG_PREFIX} dormente desde #5660 — o guard D4 não é mais executado por clarice-novos; nenhum alarme será enviado.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
