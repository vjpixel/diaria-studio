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
  fstatSync,
  statSync,
  readlinkSync,
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
 *   1. o lock é DESTE host+namespace de PID (`host` igual a `lockHostId()`)
 *      e o `pid` não existe mais (`process.kill(pid, 0)` → `ESRCH`). Nada de
 *      limite de idade pra lock com dono identificado: um dono vivo pode
 *      segurar o lock o tempo que precisar (há call sites que fazem rede
 *      dentro da seção crítica).
 *   2. o conteúdo não é um dono válido (lock legado vazio, criado antes deste
 *      formato, ou processo morto entre o `wx` e o `writeSync`) E o mtime
 *      passou de `LEGACY_STALE_MS`.
 *
 * `host` inclui o namespace de PID no Linux (`/proc/self/ns/pid`): mesmo
 * hostname não garante mesma visão de PIDs (sandbox bubblewrap, container com
 * `--uts=host`, WSL2) — sem isso, um PID vivo em outro namespace pareceria
 * morto. Lock de outro host/namespace nunca é roubado por PID (o lock já não
 * é exclusão entre máquinas; este mecanismo não pretende mudar isso). PID
 * reutilizado por outro processo vivo faz o lock parecer vivo — cai no
 * comportamento anterior (timeout), nunca num roubo indevido. Renomear a
 * máquina deixa locks do nome antigo sob a regra de outro host (timeout).
 *
 * Roubo serializado: o removedor toma um lock auxiliar `{lockPath}.steal`
 * (`wx`), RELÊ o `.lock` e só o apaga se for o MESMO arquivo julgado órfão
 * (mesmo inode + mesmo conteúdo). Como o dono de um órfão está morto e não
 * libera, e os removedores concorrentes estão serializados pelo `.steal`, o
 * `.lock` não pode ser trocado entre a releitura e o `unlink` — não existe
 * janela com o path vazio fora do fluxo normal. O `.steal` só é segurado por
 * microssegundos; um `.steal` abandonado (removedor morto no meio) é
 * descartado após `STEAL_STALE_MS`.
 */
export const LEGACY_STALE_MS = 10 * 60_000;
const STEAL_STALE_MS = 30_000;

interface LockOwner {
  pid: number;
  host: string;
  ts: number;
  token: string;
}

let cachedHostId: string | null = null;
/** Identidade host + namespace de PID gravada no lock. Exportado pra teste. */
export function lockHostId(): string {
  if (cachedHostId === null) {
    let ns = "";
    if (process.platform === "linux") {
      try { ns = readlinkSync("/proc/self/ns/pid"); } catch { /* sem /proc */ }
    }
    cachedHostId = ns ? `${hostname()}#${ns}` : hostname();
  }
  return cachedHostId;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const o = JSON.parse(raw) as Partial<LockOwner>;
    if (
      Number.isInteger(o?.pid) && (o.pid as number) > 0 &&
      typeof o.host === "string" && typeof o.token === "string"
    ) {
      return { pid: o.pid as number, host: o.host, ts: typeof o.ts === "number" ? o.ts : 0, token: o.token };
    }
  } catch { /* conteúdo legado/vazio */ }
  return null;
}

function pidAlive(pid: number): boolean {
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
  host = lockHostId(),
  alive: (pid: number) => boolean = pidAlive,
  legacyStaleMs: number = LEGACY_STALE_MS,
  foreignHostStaleMs: number | null = null,
): boolean {
  const owner = parseOwner(raw);
  if (owner) {
    if (owner.host === host) return !alive(owner.pid);
    // #9220: dono de OUTRO host — o PID não é verificável daqui. Por padrão
    // (null) nunca é órfão; um caller que conhece o pior caso da própria seção
    // crítica pode optar por um teto de idade (mtime) pra esse caso.
    return foreignHostStaleMs !== null && now - mtimeMs > foreignHostStaleMs;
  }
  return now - mtimeMs > legacyStaleMs;
}

/** Lê conteúdo + inode + mtime do MESMO arquivo aberto (null se sumiu). */
function readLockFile(lockPath: string): { raw: string; ino: number; mtimeMs: number } | null {
  let fd: number;
  try { fd = openSync(lockPath, "r"); } catch { return null; }
  try {
    const st = fstatSync(fd);
    return { raw: readFileSync(fd, "utf8"), ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Tenta remover um lock órfão (ver docstring do topo). Retorna true se
 * removeu — o caller deve tentar o `wx` de novo.
 *
 * Exportado (#9193) pra que quebradores externos (`breakStaleLock` do
 * session-registry) sigam a MESMA política: dono registrado vivo nunca é
 * quebrado, só conteúdo legado cai no critério de idade (`legacyStaleMs`), e
 * a remoção relê o arquivo sob `.steal` antes do `unlink`.
 *
 * `foreignHostStaleMs` (#9220, opt-in, default null = nunca): teto de idade
 * pra lock com dono de OUTRO host. `acquireLock`/`withFileLock` genéricos não
 * o passam — só quem conhece o pior caso da própria seção crítica.
 */
export function tryStealOrphan(
  lockPath: string,
  legacyStaleMs: number = LEGACY_STALE_MS,
  now: number = Date.now(),
  foreignHostStaleMs: number | null = null,
): boolean {
  const seen = readLockFile(lockPath);
  if (!seen || !isLockOrphan(seen.raw, seen.mtimeMs, now, lockHostId(), pidAlive, legacyStaleMs, foreignHostStaleMs)) return false;

  const stealPath = `${lockPath}.steal`;
  try {
    closeSync(openSync(stealPath, "wx"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      try {
        if (Date.now() - statSync(stealPath).mtimeMs > STEAL_STALE_MS) unlinkSync(stealPath);
      } catch { /* outro removedor já cuidou */ }
    }
    return false; // tenta de novo na próxima volta
  }
  try {
    const now = readLockFile(lockPath);
    if (!now || now.ino !== seen.ino || now.raw !== seen.raw) return false;
    unlinkSync(lockPath);
    process.stderr.write(`[file-lock] lock órfão removido (#9185): ${lockPath} — ${seen.raw.trim() || "(vazio, legado)"}\n`);
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(stealPath); } catch { /* ignore */ }
  }
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
      let written = false;
      try {
        const owner: LockOwner = {
          pid: process.pid,
          host: lockHostId(),
          ts: Date.now(),
          token: randomBytes(8).toString("hex"),
        };
        writeSync(fd, JSON.stringify(owner));
        written = true;
      } finally {
        closeSync(fd);
        // #9185: sem o registro do dono, um lock VIVO cairia na regra de lock
        // legado e poderia ser roubado após LEGACY_STALE_MS. Falha de escrita
        // (ENOSPC/EIO) desfaz a aquisição e propaga (não é EEXIST).
        if (!written) { try { unlinkSync(lockPath); } catch { /* ignore */ } }
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
