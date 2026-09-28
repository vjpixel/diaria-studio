#!/usr/bin/env npx tsx
/**
 * scripts/check-master-direct-commit.ts (#8878)
 *
 * CLI fininho chamado pelo git hook `scripts/hooks/pre-commit`. Lê a
 * branch atual do checkout onde está rodando e recusa (exit 1) se for
 * master/main — a lógica pura vive em `scripts/lib/master-commit-guard.ts`
 * (ver docstring de lá pro racional completo e o que isto NÃO cobre).
 *
 * Uso: `npx tsx scripts/check-master-direct-commit.ts` (sem args — lê a
 * branch via `git symbolic-ref` no cwd atual, que é onde o hook roda).
 */
import { execFileSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import { blockMessage, shouldBlockCommit } from "./lib/master-commit-guard.ts";

export function getCurrentBranch(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function main(): number {
  const branch = getCurrentBranch();
  if (shouldBlockCommit(branch)) {
    console.error(blockMessage(branch as string));
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
