export const STALE_LOCK_MS: number;
export const FOREIGN_HOST_STALE_LOCK_MS: number;
export function lockHostId(): string;
export function isLockOrphan(
  raw: string, mtimeMs: number, now?: number, host?: string,
  alive?: (pid: number) => boolean, legacyStaleMs?: number, foreignHostStaleMs?: number | null,
): boolean;
export function breakStaleLock(lockPath: string, now?: number): boolean;
/** #9317: espelho de `STEAL_STALE_MS`/`isStealAbandoned` de file-lock.ts. */
export const STEAL_STALE_MS: number;
export function isStealAbandoned(
  raw: string, mtimeMs: number, now?: number, host?: string, alive?: (pid: number) => boolean,
): boolean;
export const DELETE_PENDING_MAX_STREAK: number;
export const DELETE_PENDING_WAIT_MS: number;
export function isDeletePendingWxError(code: string | undefined, platform?: NodeJS.Platform): boolean;
export function isDeletePendingExhausted(e: unknown): boolean;
/** @internal Seam de teste de `tryAcquireOwnedLock` (#9280); produção omite. */
export interface AcquireDeps {
  platform: NodeJS.Platform;
  openWx: (lockPath: string) => number;
}
/** @param deps @internal seam de teste; produção omite. */
export function tryAcquireOwnedLock(lockPath: string, deps?: AcquireDeps): boolean;
