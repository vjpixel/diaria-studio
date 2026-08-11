/**
 * clarice-envio-lock.ts (#5026)
 *
 * Trava de concorrência do envio Clarice — impede que a task diária das
 * 19:00, o guard das 05:00, e uma invocação MANUAL da skill (que passou a
 * delegar pro mesmo `clarice-envio-run.ts`, ver #5027) montem a MESMA onda ao
 * mesmo tempo. O risco real: `appendSentOrQueuedEmails`
 * (`scripts/clarice-build-segment.ts`) faz read-modify-write sem lock nem
 * escrita atômica — duas invocações concorrentes sobre o mesmo ciclo já
 * deixaram 52 de 1.963 contatos escaparem do dedup num incidente real
 * (#4765). Numa automação diária isso vira risco permanente, não um acidente
 * pontual — daí a trava dedicada.
 *
 * NÃO reusa `scripts/lib/file-lock.ts` (`acquireLock`/`releaseLock`) direto:
 * aquele helper é pra seções críticas CURTAS (read-modify-write de um
 * arquivo, timeout default 10s com spin-wait). Uma rodada de
 * `clarice-envio-run.ts` faz VÁRIAS chamadas de rede (dashboard, Brevo) ao
 * longo de minutos — segurar esse lock por toda a rodada com spin-wait de
 * 50ms seria queimar CPU à toa, e um timeout curto abortaria retries
 * legítimos de rate-limit da Brevo (SKILL.md documenta esperas de até
 * ~32min). Este módulo é uma trava de ESCOPO LARGO com detecção de
 * abandono (lock "stale" — processo morreu sem liberar), não uma seção
 * crítica.
 *
 * Formato do lock: `data/clarice-subscribers/{cycle}/.envio-run.lock`, JSON
 * `{ pid, host, startedAt, label }`. Criação exclusiva (`wx`, mesmo primitivo
 * atômico de `file-lock.ts`) garante que só 1 caller cria o arquivo — os
 * demais recebem `LockHeldError` (mensagem já pronta pro relatório da
 * rodada, nunca uma exceção genérica).
 */
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly label: string;
}

/** Rodada normal (rede + montagem de onda) não deveria passar disso. Acima => provável processo morto sem liberar. */
export const STALE_LOCK_MS = 30 * 60 * 1000;

export class LockHeldError extends Error {
  constructor(readonly info: LockInfo, readonly lockPath: string) {
    super(
      `[clarice-envio-lock] ${lockPath} já está travado por "${info.label}" ` +
        `(pid ${info.pid} em ${info.host}, desde ${info.startedAt}) — ` +
        `provável sessão manual ou rodada concorrente em curso. Abortando sem tocar Brevo.`,
    );
    this.name = "LockHeldError";
  }
}

export function lockPathForCycle(rootDir: string, cycle: string): string {
  return resolve(rootDir, "data", "clarice-subscribers", cycle, ".envio-run.lock");
}

/** Lê o lock existente (ou `null` se ausente/ilegível — ilegível é tratado como "sem lock", nunca lança). */
function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      raw && typeof raw === "object" &&
      typeof raw.pid === "number" && typeof raw.host === "string" &&
      typeof raw.startedAt === "string" && typeof raw.label === "string"
    ) {
      return raw as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** `true` quando o lock existente é mais velho que `STALE_LOCK_MS` (ou ilegível — trata como abandonado). */
export function isLockStale(lockPath: string, now: Date, staleMs: number = STALE_LOCK_MS): boolean {
  const info = readLockInfo(lockPath);
  if (!info) return true; // ilegível/corrompido — melhor tratar como abandonado que travar pra sempre.
  const startedMs = Date.parse(info.startedAt);
  if (!Number.isFinite(startedMs)) return true;
  return now.getTime() - startedMs > staleMs;
}

/**
 * Adquire o lock desta invocação — cria o arquivo atomicamente (`wx`).
 * Se já existir e estiver STALE (`isLockStale`), remove e tenta de novo (o
 * dono anterior morreu sem liberar). Se existir e estiver FRESCO, lança
 * `LockHeldError` — nunca espera, nunca faz spin-wait (a rodada inteira dura
 * minutos; esperar aqui só atrasaria o relatório de "já está rodando").
 *
 * Devolve o `lockPath` — o caller é responsável por `releaseEnvioLock` no
 * `finally`, sempre, inclusive nos caminhos de erro.
 */
export function acquireEnvioLock(rootDir: string, cycle: string, label: string, now: Date): string {
  const lockPath = lockPathForCycle(rootDir, cycle);
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    if (isLockStale(lockPath, now)) {
      try { unlinkSync(lockPath); } catch { /* corrida com outro processo removendo — segue tentando criar abaixo */ }
    } else {
      const info = readLockInfo(lockPath);
      throw new LockHeldError(
        info ?? { pid: -1, host: "?", startedAt: "?", label: "(lock ilegível)" },
        lockPath,
      );
    }
  }

  const payload: LockInfo = { pid: process.pid, host: hostname(), startedAt: now.toISOString(), label };
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify(payload, null, 2) + "\n");
    closeSync(fd);
  } catch (e) {
    // Corrida genuína: outro processo criou o lock entre o existsSync acima e
    // este openSync. Não tenta de novo (evita loop infinito de corrida) —
    // trata como held, mesma mensagem que o caso "detectado antes".
    const info = readLockInfo(lockPath);
    throw new LockHeldError(
      info ?? { pid: -1, host: "?", startedAt: now.toISOString(), label: "(corrida na criação do lock)" },
      lockPath,
    );
  }
  return lockPath;
}

/** Libera o lock — fail-soft (arquivo já sumido não é erro, ver `file-lock.ts` pro mesmo padrão). */
export function releaseEnvioLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}
