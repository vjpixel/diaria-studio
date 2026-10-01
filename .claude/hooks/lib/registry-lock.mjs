// .claude/hooks/lib/registry-lock.mjs (#9203)
//
// Política de lock do session-registry para os hooks .mjs (que não carregam
// TypeScript): espelho de `isLockOrphan`/`tryStealOrphan` de
// `scripts/lib/file-lock.ts` e de `breakStaleLock` de
// `scripts/lib/session-registry.ts` (#9185/#9193/#9220). Antes os hooks
// `session-beacon.mjs` e `consume-merge-grant-on-merge.mjs` tinham cópias
// próprias que apagavam o `.lock` só por mtime (>60s), ignorando o dono
// registrado — um dono vivo numa seção crítica lenta perdia o lock.
//
// Paridade com o lado TS travada por test/hook-registry-lock-9203.test.ts.
// Mudou a política lá? Mude aqui também.

import { closeSync, fstatSync, openSync, readFileSync, readlinkSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/** Espelha `STALE_LOCK_MS` de session-registry.ts (só conteúdo legado/vazio). */
export const STALE_LOCK_MS = 60_000;
/** Espelha `FOREIGN_HOST_STALE_LOCK_MS` de session-registry.ts (#9220). */
export const FOREIGN_HOST_STALE_LOCK_MS = 30 * 60_000;
const STEAL_STALE_MS = 30_000;

let cachedHostId = null;
/** Mesmo formato de `lockHostId()` de file-lock.ts (host + namespace de PID). */
export function lockHostId() {
  if (cachedHostId === null) {
    let ns = "";
    if (process.platform === "linux") {
      try { ns = readlinkSync("/proc/self/ns/pid"); } catch { /* sem /proc */ }
    }
    cachedHostId = ns ? `${hostname()}#${ns}` : hostname();
  }
  return cachedHostId;
}

function parseOwner(raw) {
  try {
    const o = JSON.parse(raw);
    if (Number.isInteger(o?.pid) && o.pid > 0 && typeof o.host === "string" && typeof o.token === "string") {
      return { pid: o.pid, host: o.host };
    }
  } catch { /* legado/vazio */ }
  return null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/** Espelho de `isLockOrphan` (file-lock.ts). */
export function isLockOrphan(
  raw, mtimeMs, now = Date.now(), host = lockHostId(), alive = pidAlive,
  legacyStaleMs = STALE_LOCK_MS, foreignHostStaleMs = FOREIGN_HOST_STALE_LOCK_MS,
) {
  const owner = parseOwner(raw);
  if (owner) {
    if (owner.host === host) return !alive(owner.pid);
    return foreignHostStaleMs !== null && now - mtimeMs > foreignHostStaleMs;
  }
  return now - mtimeMs > legacyStaleMs;
}

function readLockFile(lockPath) {
  let fd;
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
 * Espelho de `breakStaleLock` de session-registry.ts: remove o `.lock` só se
 * órfão, relendo-o sob `{lockPath}.steal` antes do unlink. Nunca lança.
 */
export function breakStaleLock(lockPath, now = Date.now()) {
  try {
    const seen = readLockFile(lockPath);
    if (!seen || !isLockOrphan(seen.raw, seen.mtimeMs, now)) return false;
    const stealPath = `${lockPath}.steal`;
    try {
      closeSync(openSync(stealPath, "wx"));
    } catch (e) {
      if (e?.code === "EEXIST") {
        try { if (Date.now() - statSync(stealPath).mtimeMs > STEAL_STALE_MS) unlinkSync(stealPath); } catch { /* ignore */ }
      }
      return false;
    }
    try {
      const cur = readLockFile(lockPath);
      if (!cur || cur.ino !== seen.ino || cur.raw !== seen.raw) return false;
      unlinkSync(lockPath);
      // Paridade com tryStealOrphan (file-lock.ts): remoção deixa rastro.
      try { process.stderr.write(`[registry-lock] lock órfão removido (#9203): ${lockPath} — ${seen.raw.trim() || "(vazio, legado)"}\n`); } catch { /* ignore */ }
      return true;
    } finally {
      try { unlinkSync(stealPath); } catch { /* ignore */ }
    }
  } catch {
    return false;
  }
}

/**
 * #9280 — espelho de `DELETE_PENDING_MAX_STREAK`/`DELETE_PENDING_WAIT_MS`/
 * `isDeletePendingWxError` de `scripts/lib/file-lock.ts` (#9194, fonte
 * canônica). No Windows, o unlink do dono enquanto outro processo segura o
 * `.lock` aberto (o `readLockFile` dos waiters, #9194) deixa o nome em
 * DELETE-PENDING, e o `wx` falha com EPERM/EACCES em vez de EEXIST. É
 * contenção transitória: até DELETE_PENDING_MAX_STREAK retentativas seguidas
 * (21 tentativas no total) a cada ~5ms; esgotada a sequência, provavelmente é
 * permissão real e propaga rápido (#6952), com `code`, `cause` e
 * `deletePendingExhausted: true`.
 *
 * Diferença DELIBERADA do lado TS: aqui não há deadline — o hook não conhece
 * o do caller. O único teto é o streak: ~20×5ms nominal, ~300ms na prática
 * (resolução de timer ~15,6ms do Windows), além do deadline do caller.
 * Paridade travada por test/hook-registry-lock-delete-pending-9280.test.ts.
 */
export const DELETE_PENDING_MAX_STREAK = 20;
export const DELETE_PENDING_WAIT_MS = 5;

/** `true` se o erro do `wx` é o sintoma de delete-pending do Windows (#9194/#9280). */
export function isDeletePendingWxError(code, platform = process.platform) {
  return platform === "win32" && (code === "EPERM" || code === "EACCES");
}

/** `true` se `e` é o erro de sequência de delete-pending esgotada de `tryAcquireOwnedLock`. */
export function isDeletePendingExhausted(e) {
  return e?.deletePendingExhausted === true;
}

const DEFAULT_ACQUIRE_DEPS = { platform: process.platform, openWx: (p) => openSync(p, "wx") };

/**
 * Tenta criar o `.lock` (`wx`) gravando o dono `{pid, host, ts, token}` — sem
 * isso o lock do hook pareceria legado e seria roubável após 60s pelo lado TS.
 * Retorna true se adquiriu, false em contenção (EEXIST). No win32, EPERM/EACCES
 * (delete-pending, #9280) é retentado aqui dentro numa sequência curta — que
 * termina em true, em false (apareceu EEXIST: o próximo dono já criou) ou,
 * esgotada, lança. Qualquer outro erro propaga imediatamente.
 * @internal `deps` é seam de teste (plataforma + `open(wx)`); produção omite.
 */
export function tryAcquireOwnedLock(lockPath, deps = DEFAULT_ACQUIRE_DEPS) {
  let fd;
  let pendingStreak = 0;
  for (;;) {
    try {
      fd = deps.openWx(lockPath);
      break;
    } catch (e) {
      const code = e?.code;
      if (code === "EEXIST") return false;
      if (!isDeletePendingWxError(code, deps.platform)) throw e;
      if (++pendingStreak <= DELETE_PENDING_MAX_STREAK) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELETE_PENDING_WAIT_MS);
        continue;
      }
      // Sequência esgotada: provavelmente não é delete-pending, e sim permissão real.
      throw Object.assign(
        new Error(
          `[registry-lock] ${code} persistiu por ${pendingStreak} tentativas seguidas em ${lockPath} — provável permissão real, não delete-pending (#9194)`,
          { cause: e },
        ),
        { code, deletePendingExhausted: true },
      );
    }
  }
  let written = false;
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: Date.now(), token: randomBytes(8).toString("hex") }));
    written = true;
  } finally {
    closeSync(fd);
    if (!written) { try { unlinkSync(lockPath); } catch { /* ignore */ } }
  }
  return true;
}
