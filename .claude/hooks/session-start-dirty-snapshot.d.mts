import type { DirtySnapshot } from "./lib/session-dirty-snapshot.mjs";

export interface DirtySnapshotHookResult {
  written: boolean;
  reason?: "source-not-startup" | "too-many-entries" | "invalid-session-id" | "already-exists";
  path?: string;
}
export function runDirtySnapshotHook(
  payload: { session_id?: string; cwd?: string; source?: string } | null | undefined,
  deps?: {
    capture?: (cwd: string) => DirtySnapshot | null;
    write?: (path: string, snapshot: DirtySnapshot) => boolean;
    baseDir?: string;
  },
): DirtySnapshotHookResult;
