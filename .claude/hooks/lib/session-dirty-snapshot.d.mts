export const SNAPSHOT_VERSION: number;
export const MAX_HASH_BYTES: number;
export const MAX_SNAPSHOT_ENTRIES: number;

export interface SnapshotEntry { code: string; hash: string | null }
export interface DirtySnapshot {
  version: number;
  capturedAt: string;
  checkout: string;
  entries: Record<string, SnapshotEntry>;
}
export interface StatusLike { code: string; path: string }

export function defaultSnapshotDir(): string;
export function normalizeCheckoutPath(path: string): string;
export function snapshotFilePath(sessionId: string, checkout: string, baseDir?: string): string | null;
export function parsePorcelainZ(out: string): StatusLike[];
export function hashPath(abs: string): string | null;
export function captureDirtySnapshot(
  cwd: string,
  deps?: {
    run?: (args: string[], cwd: string) => string;
    hash?: (abs: string) => string | null;
    now?: () => Date;
  },
): DirtySnapshot | null;
export function writeSnapshotOnce(path: string, snapshot: DirtySnapshot): boolean;
export function readSnapshot(path: string): DirtySnapshot | null;
export function isUnchangedSinceSnapshot(
  snapshot: DirtySnapshot | null | undefined,
  checkout: string,
  entry: StatusLike,
  hash?: (abs: string) => string | null,
): boolean;
