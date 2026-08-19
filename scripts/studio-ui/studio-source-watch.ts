/**
 * Watches the server-rendered Studio source trees (#5674).
 *
 * The server imports these modules once at boot, so a git pull can otherwise
 * leave the long-lived process serving old markup. Polling mtimes keeps this
 * reliable across local filesystems and synced worktrees; the caller decides
 * whether a detected change should trigger a restart.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const WATCHED_DIRS = ["scripts/studio-ui", "workers/brevo-dashboard/src"] as const;

export interface StudioSourceChange {
  path: string;
  previousMtimeMs: number | null;
  mtimeMs: number | null;
}

export interface StudioSourceWatchHandle {
  close: () => void;
}

type SourceSnapshot = Map<string, number>;

function snapshotTree(rootDir: string): SourceSnapshot {
  const snapshot: SourceSnapshot = new Map();
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      try {
        snapshot.set(path, statSync(path).mtimeMs);
      } catch {
        // A file can disappear between readdir and stat; the next poll sees it.
      }
    }
  };

  for (const directory of WATCHED_DIRS) {
    const path = resolve(rootDir, directory);
    if (existsSync(path)) visit(path);
  }
  return snapshot;
}

function relativePath(rootDir: string, path: string): string {
  return relative(rootDir, path).split("\\").join("/");
}

export function watchStudioSource(
  rootDir: string,
  onChange: (change: StudioSourceChange) => void,
  opts: { pollIntervalMs?: number } = {},
): StudioSourceWatchHandle {
  const resolvedRoot = resolve(rootDir);
  let previous = snapshotTree(resolvedRoot);
  let closed = false;

  const poll = (): void => {
    if (closed) return;
    const current = snapshotTree(resolvedRoot);
    const paths = new Set([...previous.keys(), ...current.keys()]);
    for (const path of paths) {
      const before = previous.get(path) ?? null;
      const after = current.get(path) ?? null;
      if (before === after) continue;
      onChange({ path: relativePath(resolvedRoot, path), previousMtimeMs: before, mtimeMs: after });
      break;
    }
    previous = current;
  };

  const interval = setInterval(poll, opts.pollIntervalMs ?? 1000);
  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
    },
  };
}
