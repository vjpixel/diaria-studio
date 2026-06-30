#!/usr/bin/env node
/**
 * sync-code.ts (#2686)
 *
 * CLI wrapper para `scripts/lib/git-sync.ts`.
 *
 * Sincroniza o checkout local com origin/master antes de iniciar uma edição
 * Diar.ia. Invocado pelo Passo 0 de `.claude/skills/diaria-edicao/SKILL.md`.
 *
 * Sempre sai com código 0 (fail-soft) — falhas de sync são warn, nunca
 * bloqueiam a edição. O status é impresso em JSON para o orchestrator logar.
 *
 * Uso:
 *   npx tsx scripts/sync-code.ts
 *
 * Saída (stdout):
 *   JSON com campos outcome, message, branch_before, warnings, proceed.
 */

import { syncCode } from "./lib/git-sync.ts";

const result = syncCode();

// Sempre imprime JSON do resultado para o orchestrator logar
console.log(JSON.stringify(result, null, 2));

// Warnings humanos no stderr (sem duplicar o JSON)
if (result.warnings.length > 0) {
  for (const w of result.warnings) {
    process.stderr.write(w + "\n");
  }
}

// Sempre exit 0 — fail-soft (#2686: falha de sync nunca bloqueia a edição)
process.exit(0);
