/**
 * scripts/lib/diaria/corte-timer-heartbeat.ts (#11986)
 *
 * Sinal de vida do timer do corte (`Diaria-Shorts-Cortes`, de hora em hora no
 * 300). Com `publishing.shorts.corte_via_timer` ligado, a rodada manual do
 * corte entrega `linkedin_profile`, `threads_profile` e `instagram` ao timer
 * de 10 min antes até 3 h depois do horário (#11964, #11996). Se o timer está
 * desarmado, falhando antes de chegar ao corte ou o 300 está fora do ar, nada
 * publica esses destinos e o próprio timer, que é quem alarma `late`, não
 * avisa ninguém.
 *
 * O timer grava `data/cortes/.shorts-corte-timer-heartbeat.json` no início e
 * no fim de toda execução que não seja dry-run (`ran_at`). Dois leitores:
 *   - a vigia dos cortes (`corte-owner-watch.ts`), que roda nos três timers da
 *     edição no 300: corte com destino autorizado e pendente depois do horário
 *     e heartbeat velho vira alarme por e-mail (timer desarmado ou quebrado);
 *   - o `publish-shorts.ts --corte` (rodada manual, em geral no Neo): ao
 *     delegar ao timer com heartbeat velho, avisa em `warnings` (cobre o 300
 *     fora do ar, quando nenhum timer do 300 roda para alarmar).
 *
 * Velho = mais de duas cadências do timer (`CORTE_TIMER_HEARTBEAT_STALE_MS`):
 * com a gravação no início e no fim, o intervalo entre duas gravações de um
 * timer vivo fica perto de uma cadência, mesmo com o filho no teto de 75 min.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { CORTE_TIMER_INTERVAL_MS } from "./short-corte.ts";

/** Arquivo do heartbeat, dentro de `data/cortes/` (fora das pastas de corte). */
export const CORTE_TIMER_HEARTBEAT_FILE = ".shorts-corte-timer-heartbeat.json";

/** Heartbeat mais velho que isto: o timer do corte não está rodando. */
export const CORTE_TIMER_HEARTBEAT_STALE_MS = 2 * CORTE_TIMER_INTERVAL_MS;

export interface CorteTimerHeartbeat {
  /** ISO da última gravação, ou null (arquivo ausente ou ilegível). */
  ranAt: string | null;
  /** Por que `ranAt` é null quando o arquivo existe e não lê. */
  error?: string;
}

export function corteTimerHeartbeatPath(cortesDir: string): string {
  return join(cortesDir, CORTE_TIMER_HEARTBEAT_FILE);
}

/** Lê o heartbeat. Nunca lança: ausente ou ilegível vira `ranAt: null` (conta como velho). */
export function readCorteTimerHeartbeat(cortesDir: string): CorteTimerHeartbeat {
  const path = corteTimerHeartbeatPath(cortesDir);
  if (!existsSync(path)) return { ranAt: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const ranAt = parsed?.ran_at;
    if (typeof ranAt !== "string" || Number.isNaN(Date.parse(ranAt))) return { ranAt: null, error: `${path}: sem ran_at válido` };
    return { ranAt };
  } catch (e) {
    return { ranAt: null, error: `${path}: ${(e as Error).message}` };
  }
}

/** Grava o heartbeat (o timer do corte, em toda execução que não seja dry-run). */
export function writeCorteTimerHeartbeat(cortesDir: string, now: Date, phase: "start" | "end"): void {
  const path = corteTimerHeartbeatPath(cortesDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ ran_at: now.toISOString(), phase, pid: process.pid }, null, 2) + "\n");
}

/** Puro: o heartbeat está velho (ou ausente) em `now`? */
export function corteTimerHeartbeatStale(hb: CorteTimerHeartbeat, now: Date): boolean {
  if (hb.ranAt === null) return true;
  return now.getTime() - Date.parse(hb.ranAt) > CORTE_TIMER_HEARTBEAT_STALE_MS;
}

/** Puro: frase de quando o timer rodou pela última vez (vai no alarme e no aviso). */
export function describeCorteTimerHeartbeat(hb: CorteTimerHeartbeat, now: Date): string {
  if (hb.ranAt === null) return hb.error ? `heartbeat ilegível (${hb.error})` : `nenhuma execução registrada (${CORTE_TIMER_HEARTBEAT_FILE} ausente)`;
  const min = Math.round((now.getTime() - Date.parse(hb.ranAt)) / 60_000);
  return `última execução registrada em ${hb.ranAt} (há ${min} min)`;
}
