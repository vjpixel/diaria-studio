/**
 * scripts/lib/file-lock.ts (#4125 item 7)
 *
 * Lock de arquivo genérico via criação exclusiva (`wx` — atômico nos
 * principais filesystems: cria o arquivo só se ele NÃO existir, falha se já
 * existir). Extraído de `scripts/lib/social-published-store.ts` (#758/#918,
 * a implementação original — usada por `publish-facebook.ts`/
 * `publish-linkedin.ts` gravando `06-social-published.json` em paralelo) pra
 * virar um helper reusável — não reinventar o mecanismo em cada novo caso de
 * read-modify-write concorrente sobre um arquivo JSON compartilhado.
 *
 * Uso típico (read-modify-write atômico):
 *
 *   const lockPath = filePath + ".lock";
 *   acquireLock(lockPath);
 *   try {
 *     const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : fallback;
 *     // ...mutar `current`...
 *     const tmpPath = filePath + ".tmp";
 *     writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf8");
 *     renameSync(tmpPath, filePath); // rename é atômico — nunca deixa o arquivo real pela metade
 *   } finally {
 *     releaseLock(lockPath);
 *   }
 */

import {
  openSync,
  closeSync,
  unlinkSync,
  writeSync,
  readFileSync,
  statSync,
  renameSync,
  linkSync,
} from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * #9185 — detecção de lock ÓRFÃO.
 *
 * Antes, um processo que morresse segurando o lock (SIGKILL, OOM, queda de
 * energia) deixava o `.lock` no disco pra sempre, e toda chamada seguinte
 * girava até o timeout e lançava `lock timeout` — no onboarding, isso parava
 * as duas escadas (Brevo e Kit) até alguém apagar o arquivo à mão.
 *
 * Agora o dono grava `{pid, host, ts, token}` no `.lock` ao adquiri-lo, e um
 * caller que encontra o lock tomado o trata como órfão SÓ em dois casos:
 *
 *   1. o lock é DESTA máquina (`host` igual) e o `pid` não existe mais
 *      (`process.kill(pid, 0)` → `ESRCH`). Nada de limite de idade pra lock
 *      com dono identificado: um dono vivo pode segurar o lock o tempo que
 *      precisar (há call sites que fazem rede dentro da seção crítica).
 *   2. o conteúdo não é parseável (lock legado vazio, criado antes deste
 *      formato, ou processo morto entre o `wx` e o `writeSync`) E o mtime
 *      passou de `LEGACY_STALE_MS`.
 *
 * Lock de OUTRA máquina nunca é roubado por PID — não dá pra saber se o
 * processo remoto vive (o lock já não é exclusão entre máquinas; este
 * mecanismo não pretende mudar isso). PID reutilizado por outro processo
 * vivo faz o lock parecer vivo — cai no comportamento anterior (timeout),
 * nunca num roubo indevido.
 *
 * O roubo é por `rename` atômico pra um nome único, seguido de conferência
 * do `token`: se entre a leitura e o rename outro caller já roubou e criou
 * um lock NOVO, o que movemos não é o órfão — ele volta ao lugar via
 * `linkSync` (que falha em vez de sobrescrever se o path já foi ocupado).
 */
export const LEGACY_STALE_MS = 10 * 60_000;

interface LockOwner {
  pid: number;
  host: string;
  ts: number;
  token: string;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const o = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof o?.pid === "number" && typeof o.host === "string" && typeof o.token === "string") {
      return { pid: o.pid, host: o.host, ts: typeof o.ts === "number" ? o.ts : 0, token: o.token };
    }
  } catch { /* conteúdo legado/vazio */ }
  return null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe, mas é de outro usuário → vivo.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Decide se o conteúdo/mtime de um lock existente indica dono morto.
 * Exportado pra teste.
 */
export function isLockOrphan(
  raw: string,
  mtimeMs: number,
  now = Date.now(),
  host = hostname(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const owner = parseOwner(raw);
  if (owner) return owner.host === host && !alive(owner.pid);
  return now - mtimeMs > LEGACY_STALE_MS;
}

/**
 * Tenta remover um lock órfão de forma segura contra roubo concorrente.
 * Retorna true se removeu (o caller deve tentar o `wx` de novo).
 */
function tryStealOrphan(lockPath: string): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lockPath, "utf8");
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return false; // sumiu entre o EEXIST e a leitura — o próximo `wx` decide
  }
  if (!isLockOrphan(raw, mtimeMs)) return false;

  const aside = `${lockPath}.orphan-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return false; // outro caller já moveu/liberou
  }
  let movedRaw = "";
  try { movedRaw = readFileSync(aside, "utf8"); } catch { /* ignore */ }
  if (movedRaw === raw) {
    try { unlinkSync(aside); } catch { /* ignore */ }
    process.stderr.write(`[file-lock] lock órfão removido (#9185): ${lockPath} — ${raw.trim() || "(vazio, legado)"}\n`);
    return true;
  }
  // Movemos um lock que NÃO é o órfão lido (alguém roubou e recriou no meio):
  // devolve sem sobrescrever.
  try { linkSync(aside, lockPath); } catch { /* path já reocupado — o novo dono segue */ }
  try { unlinkSync(aside); } catch { /* ignore */ }
  return false;
}

/**
 * Adquire o lock — spin-wait com timeout. `wx` (O_WRONLY | O_CREAT | O_EXCL)
 * falha se o arquivo já existe, então só um caller por vez consegue criar o
 * `.lock` — os demais tentam de novo a cada 50ms até o dono liberar
 * (`releaseLock`) ou o timeout estourar.
 */
export function acquireLock(lockPath: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        const owner: LockOwner = {
          pid: process.pid,
          host: hostname(),
          ts: Date.now(),
          token: randomBytes(8).toString("hex"),
        };
        writeSync(fd, JSON.stringify(owner));
      } catch {
        // Best-effort: o lock JÁ é nosso (o `wx` passou). Sem conteúdo, ele cai
        // na regra de lock legado (órfão só após LEGACY_STALE_MS).
      } finally {
        closeSync(fd);
      }
      return; // Lock adquirido
    } catch (e) {
      // #6952: só `EEXIST` é CONTENÇÃO — o resto propaga imediatamente.
      //
      // O catch era vazio e engolia qualquer erro como "alguém tem o lock,
      // gira mais": `EACCES` (diretório sem permissão de escrita), `ENOENT`
      // (diretório ausente), `ENOSPC` (disco cheio) giravam o timeout INTEIRO
      // e depois lançavam "lock timeout", escondendo a causa real.
      //
      // Medido ao vivo: um teste que faz `chmod 0555` no diretório de sessões
      // pra forçar falha de escrita passou a girar 690 vezes em `EACCES`.
      // Combinado com o retry do `writeJsonSafeWithCas` (que chama isto até 50
      // vezes), o custo virou ~500s de CPU ocupada por chamada — mais que o
      // orçamento de 300s do batch do runner paralelo, derrubando o worker
      // inteiro e levando junto testes que nada tinham a ver.
      //
      // `acquireBeaconLock` (`.claude/hooks/session-beacon.mjs`) já fazia essa
      // distinção; os docstrings diziam que os dois mecanismos eram espelhados
      // e não eram — este era o lado errado.
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      // #9185: dono morto → remove o órfão e tenta de novo sem esperar.
      if (tryStealOrphan(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`[file-lock] lock timeout after ${timeoutMs}ms: ${lockPath}`);
      }
      // Espera 50ms DORMINDO, não em busy wait. O spin anterior queimava CPU
      // justamente enquanto o dono do lock precisava de CPU pra terminar e
      // soltá-lo — com vários processos concorrendo (o runner paralelo roda
      // 150 arquivos por batch), a espera competia com a liberação.
      // `Atomics.wait` é a única espera síncrona real disponível aqui.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Libera o lock. Fail-soft — se o arquivo já sumiu (ex: limpeza manual concorrente), ignora. */
export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/**
 * Executa `fn` sob o lock de `lockPath`, garantindo `releaseLock` mesmo se
 * `fn` lançar. Açúcar sintático pro padrão acquire→try→finally-release usado
 * em todo call site — reduz a chance de esquecer o `finally`.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 10_000): T {
  acquireLock(lockPath, timeoutMs);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
