#!/usr/bin/env node
/**
 * sync-code.ts (#2686)
 *
 * CLI wrapper para `scripts/lib/git-sync.ts`.
 *
 * Sincroniza o checkout local com origin/master antes de iniciar uma edição
 * diar.ia.br. Invocado pelo Passo 0 de `.claude/skills/diaria-edicao/SKILL.md`.
 *
 * Sempre sai com código 0 (fail-soft) — falhas de sync são warn, nunca
 * bloqueiam a edição. O status é impresso em JSON para o orchestrator logar.
 *
 * Uso:
 *   npx tsx scripts/sync-code.ts
 *
 * Saída (stdout):
 *   JSON com campos outcome, message, branch_before, warnings, proceed,
 *   up_to_date, commits_behind (#6090).
 *
 * #6090: quando `commits_behind > 0`, imprime um BANNER visível no stderr —
 * a edição continua (fail-soft), mas o defasamento deixa de ser uma linha
 * invisível no meio do JSON e vira sinalização explícita pro orchestrator/
 * editor (incidente 260825: pipeline inteiro rodou com código antigo sob 3×
 * "sucesso" porque o warning era prosa ignorable).
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

// #6090: banner de código defasado — NÃO bloqueia (fail-soft preservado),
// só para de ser invisível.
if (result.commits_behind > 0) {
  const n = result.commits_behind;
  process.stderr.write(
    `\n⚠  CÓDIGO DEFASADO — ${n} commit${n > 1 ? "s" : ""} atrás de origin/master.\n` +
      `   A edição vai continuar (fail-soft), mas scripts podem rodar\n` +
      `   com comportamento antigo — incluindo os guards que deveriam\n` +
      `   detectar isso (guard defasado concorda com sujeito defasado).\n` +
      `   Para sincronizar: git fetch origin && git merge --ff-only origin/master\n\n`,
  );
}

// Sempre exit 0 — fail-soft (#2686: falha de sync nunca bloqueia a edição)
process.exit(0);
