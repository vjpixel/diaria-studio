#!/usr/bin/env tsx
/**
 * memory-sync.ts (#7533 item 5)
 *
 * CLI fino: roda add → commit → pull --rebase → push no repo git dedicado
 * de `memory/` (lógica pura em `scripts/lib/memory-sync.ts`). Não cria nem
 * conecta o repo remoto sozinho — isso é um passo manual de 1x por conta do
 * editor (`MANUAL_SETUP_INSTRUCTIONS`), fora do alcance de um worktree
 * isolado sem credenciais/contexto para provisionar um repo GitHub novo.
 *
 * Uso:
 *   npx tsx scripts/memory-sync.ts --memory-dir <dir>
 *   # ou
 *   MEMORY_DIR=<dir> npx tsx scripts/memory-sync.ts
 *
 * Combine com `regenerate-memory-index.ts` — sync primeiro traz o que
 * outras máquinas escreveram, depois regenerar reflete isso no MEMORY.md
 * local:
 *   npx tsx scripts/memory-sync.ts --memory-dir <dir> && \
 *   npx tsx scripts/extract-memory-index.ts --memory-dir <dir> && \
 *   npx tsx scripts/regenerate-memory-index.ts --memory-dir <dir>
 *
 * Exit codes:
 *   0 — sincronizado (ou nada a sincronizar)
 *   1 — etapa falhou (rebase, push) — repo git deixado no estado da falha,
 *       resolver manualmente
 *   2 — argumento inválido ou repo git não inicializado ainda
 */

import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runMemorySync, MANUAL_SETUP_INSTRUCTIONS, type GitCommandResult, type Spawner } from "./lib/memory-sync.ts";

const realSpawner: Spawner = (cmd, args, cwd): GitCommandResult => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function runCli(argv: string[]): number {
  const { values } = parseArgs(argv);
  const memoryDir = values["memory-dir"] ?? process.env.MEMORY_DIR;
  if (!memoryDir) {
    console.error("Uso: memory-sync.ts --memory-dir <dir> (ou env MEMORY_DIR)");
    return 2;
  }

  const outcomes = runMemorySync(memoryDir, realSpawner);
  for (const outcome of outcomes) {
    console.log(`[memory-sync] ${outcome.step}${outcome.detail ? `: ${outcome.detail}` : ""}`);
  }

  const last = outcomes[outcomes.length - 1];
  if (last?.step === "not-a-git-repo") {
    console.error("\nO diretório de memória ainda não é um repo git. Setup manual (1x por máquina, ver #7533):");
    for (const line of MANUAL_SETUP_INSTRUCTIONS) console.error(`  ${line}`);
    return 2;
  }
  if (last?.step === "commit-failed" || last?.step === "pull-rebase-failed" || last?.step === "push-failed") {
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)));
}
