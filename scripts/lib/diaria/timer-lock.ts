/**
 * timer-lock.ts — lock O_EXCL dos timers do vertical no 300 (#10982), movido de
 * `scripts/shorts-linkedin-profile-timer.ts` no #12001 para o `publish-shorts.ts`
 * poder tomar o MESMO lock do timer do corte sem importar um script de timer
 * (que carrega alarme, e-mail e o resto em runtime). O timer do LinkedIn
 * re-exporta com o nome de sempre.
 */

import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SHORTS_TIMER_LOCK_STALE_MS } from "./vertical-download-guard.ts";

/** Lock O_EXCL; devolve o release, ou null se outra execução está no meio (lock com até `SHORTS_TIMER_LOCK_STALE_MS`). */
export function acquireTimerLock(path: string, now: number = Date.now()): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const tryOpen = () => {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  if (!tryOpen()) {
    let age = 0;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      age = 0;
    }
    if (age <= SHORTS_TIMER_LOCK_STALE_MS) return null;
    rmSync(path, { force: true });
    if (!tryOpen()) return null;
  }
  return () => rmSync(path, { force: true });
}
