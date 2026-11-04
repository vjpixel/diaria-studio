/**
 * timer-lock.ts — lock O_EXCL dos timers do vertical no 300 (#10982), movido de
 * `scripts/shorts-linkedin-profile-timer.ts` no #12001 para o `publish-shorts.ts`
 * poder tomar o MESMO lock do timer do corte sem importar um script de timer
 * (que carrega alarme, e-mail e o resto em runtime). O timer do LinkedIn
 * re-exporta com o nome de sempre.
 *
 * #12005: o lock tem dono. O arquivo guarda um token (`pid` + nonce) e o
 * release só apaga o lock se o conteúdo ainda for o token de quem o tomou.
 * Antes o release era um `rm` cego: uma rodada manual com mais de 90 min tinha
 * o lock tomado como velho pelo timer e, ao terminar, apagava o lock do timer,
 * e um terceiro processo podia pegá-lo enquanto o filho do timer publicava. A
 * tomada de lock velho também confere que o arquivo é o mesmo que o `stat` viu
 * (inode, mtime e tamanho) antes de apagar. `heartbeatMs` renova o lock durante
 * uma rodada longa (a manual, sem teto): troca o arquivo por um novo com o mesmo
 * token (temporário + rename, #12157, para nenhum leitor ver o lock vazio), o que
 * atualiza a mtime, e ele não fica velho enquanto o processo vive. O inode muda a
 * cada renovação, e a tomada de lock velho lê isso como "renovado no meio".
 *
 * Limite que fica: entre o "conteúdo ainda é meu" e o `rm` há uma janela de
 * microssegundos; só importa se o lock estiver velho (90 min sem renovação)
 * justo nesse instante. Entre máquinas vale o que o OneDrive sincronizou.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { SHORTS_TIMER_LOCK_STALE_MS } from "./vertical-download-guard.ts";

/** Opções do lock. `heartbeatMs`: renova o lock a cada N ms enquanto o processo segura (rodada sem teto). */
export interface TimerLockOptions {
  heartbeatMs?: number;
}

/** #12005: renovação da rodada manual do corte (bem abaixo dos 90 min de lock velho). */
export const TIMER_LOCK_HEARTBEAT_MS = 10 * 60_000;

/** Conteúdo do lock (#12005). */
export interface TimerLockContent {
  token: string;
  pid: number;
  acquired_at: string;
  beat_at?: string;
}

/** Puro: o token gravado no lock, ou null (arquivo vazio, de antes do #12005, ou ilegível). */
export function timerLockToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.token === "string" && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

function lockBody(content: TimerLockContent): string {
  return JSON.stringify(content) + "\n";
}

/**
 * #12157: grava o corpo num temporário ao lado e renomeia por cima do lock. O
 * `writeFileSync` direto trunca o arquivo antes de escrever, e quem lia o lock
 * nessa janela (outro processo, ou o teste) via o arquivo vazio. O rename troca o
 * arquivo inteiro de uma vez: o leitor vê o corpo antigo ou o novo, nunca vazio.
 */
export function writeTimerLockAtomic(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Lock O_EXCL; devolve o release, ou null se outra execução está no meio (lock com até `SHORTS_TIMER_LOCK_STALE_MS`). */
export function acquireTimerLock(path: string, now: number = Date.now(), opts: TimerLockOptions = {}): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const content: TimerLockContent = { token: `${process.pid}:${randomUUID()}`, pid: process.pid, acquired_at: new Date(now).toISOString() };
  const tryOpen = () => {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    try {
      writeSync(fd, lockBody(content));
    } finally {
      closeSync(fd);
    }
    return true;
  };
  if (!tryOpen()) {
    let seen: { ino: number; mtimeMs: number; size: number } | null = null;
    try {
      const st = statSync(path);
      seen = { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      seen = null;
    }
    // Sumiu entre o open e o stat: o dono acabou de soltar; tenta uma vez.
    if (seen === null) return tryOpen() ? releaseFor(path, content, opts) : null;
    if (now - seen.mtimeMs <= SHORTS_TIMER_LOCK_STALE_MS) return null;
    // #12005: só apaga o lock velho que o stat viu; outro processo pode ter tomado (ou renovado) no meio.
    try {
      const again = statSync(path);
      if (again.ino !== seen.ino || again.mtimeMs !== seen.mtimeMs || again.size !== seen.size) return null;
    } catch {
      // Sumiu: segue para o open exclusivo, que decide.
    }
    rmSync(path, { force: true });
    if (!tryOpen()) return null;
  }
  return releaseFor(path, content, opts);
}

function releaseFor(path: string, content: TimerLockContent, opts: TimerLockOptions): () => void {
  const mine = (): boolean => {
    try {
      return timerLockToken(readFileSync(path, "utf8")) === content.token;
    } catch {
      return false;
    }
  };
  let beat: NodeJS.Timeout | null = null;
  if (opts.heartbeatMs && opts.heartbeatMs > 0) {
    beat = setInterval(() => {
      try {
        // Troca o arquivo por um novo (temporário + rename, #12157): a mtime anda e o lock não fica velho.
        if (mine()) writeTimerLockAtomic(path, lockBody({ ...content, beat_at: new Date().toISOString() }));
      } catch (e) {
        console.error(`[timer-lock] renovação de ${path} falhou: ${(e as Error).message}`);
      }
    }, opts.heartbeatMs);
    beat.unref();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (beat) clearInterval(beat);
    // #12005: lock de outro dono (tomado como velho enquanto esta execução seguia) fica de pé.
    if (!mine()) return;
    rmSync(path, { force: true });
  };
}
