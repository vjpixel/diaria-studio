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
  opts: { pollIntervalMs?: number; debounceMs?: number } = {},
): StudioSourceWatchHandle {
  const resolvedRoot = resolve(rootDir);
  let previous = snapshotTree(resolvedRoot);
  let closed = false;
  const debounceMs = opts.debounceMs ?? 0;

  // #6452: um `git pull`/checkout toca vários arquivos em sequência rápida
  // (às vezes espalhado por vários polls, não um único ciclo) — sem
  // debounce, cada poll que pega uma mtime nova dispara `onChange` de
  // imediato, e o caller (main() abaixo) mata o processo a cada chamada.
  // Isso produziu 5 restarts em ~4min citando a MESMA mudança (#6452).
  // Em vez de disparar na primeira detecção, guardamos a última mudança
  // vista e só a repassamos depois de `debounceMs` sem NENHUMA mudança nova
  // — um burst inteiro de writes vira 1 única notificação. `debounceMs: 0`
  // (default) preserva o comportamento síncrono anterior, usado pelos
  // testes existentes e por qualquer chamador que prefira reagir na hora.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChange: StudioSourceChange | null = null;

  const flushPending = (): void => {
    debounceTimer = null;
    if (closed || !pendingChange) return;
    const change = pendingChange;
    pendingChange = null;
    onChange(change);
  };

  const poll = (): void => {
    if (closed) return;
    const current = snapshotTree(resolvedRoot);
    const paths = new Set([...previous.keys(), ...current.keys()]);
    for (const path of paths) {
      const before = previous.get(path) ?? null;
      const after = current.get(path) ?? null;
      if (before === after) continue;
      const change: StudioSourceChange = { path: relativePath(resolvedRoot, path), previousMtimeMs: before, mtimeMs: after };
      if (debounceMs <= 0) {
        onChange(change);
      } else {
        pendingChange = change;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flushPending, debounceMs);
        debounceTimer.unref?.();
      }
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
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      pendingChange = null;
    },
  };
}
