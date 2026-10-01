export const STALE_LOCK_MS: number;
export const FOREIGN_HOST_STALE_LOCK_MS: number;
export function lockHostId(): string;
export function isLockOrphan(
  raw: string, mtimeMs: number, now?: number, host?: string,
  alive?: (pid: number) => boolean, legacyStaleMs?: number, foreignHostStaleMs?: number | null,
): boolean;
export function breakStaleLock(lockPath: string, now?: number): boolean;
export const DELETE_PENDING_MAX_STREAK: number;
export function isDeletePendingWxError(code: string | undefined, platform?: NodeJS.Platform): boolean;
export interface AcquireDeps {
  platform: NodeJS.Platform;
  openWx: (lockPath: string) => number;
}
export function tryAcquireOwnedLock(lockPath: string, deps?: AcquireDeps): boolean;
