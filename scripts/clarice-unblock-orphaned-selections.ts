#!/usr/bin/env node
/**
 * scripts/clarice-unblock-orphaned-selections.ts (#8038)
 *
 * Acha e desbloqueia contatos presos em `sent-or-queued.json` (guard
 * cycle-wide anti-duplo-envio, `clarice-build-segment.ts` #3227) que foram
 * SELECIONADOS pra alguma onda mas nunca aparecem em nenhum CSV de onda
 * vivo do ciclo — indício de que a seleção original nunca virou onda real
 * (build abandonado, superseded pela fila `daily` do #7406, ou perda por
 * concorrência do #4765). Ver `findOrphanedSentOrQueuedEmails` em
 * `clarice-build-segment.ts` pra semântica completa da detecção.
 *
 * Uso:
 *   npx tsx scripts/clarice-unblock-orphaned-selections.ts --cycle 2608-09 [--apply]
 *   (default: dry-run — lista os órfãos encontrados, não escreve)
 *
 * Stdout: JSON com `{ orphansFound, apply, emails }`. Stderr: progresso.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { clariceSegmentsDir, CLARICE_BASE } from "./lib/clarice-paths.ts";
import {
  loadSentOrQueuedEmails,
  findOrphanedSentOrQueuedEmails,
  unblockOrphanedSentOrQueuedEmails,
} from "./clarice-build-segment.ts";

/** Lê o 1º campo (coluna `email`) de todo `*.csv` em `segmentsDir` — inclui
 *  `daily.csv`/`novos.csv`/`engajados.csv`/`ramp-warm.csv` e os
 *  `d{N}-*-{A,B,C}.csv` das ondas diárias. Todo artefato de seleção vivo do
 *  ciclo, sem exceção — é este universo que decide "ainda em alguma onda". */
export function collectCurrentlyReferencedEmails(segmentsDir: string): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(segmentsDir).filter((f) => f.endsWith(".csv"));
  } catch {
    return out; // diretório ausente (ciclo sem builds ainda) — universo vazio.
  }
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(resolve(segmentsDir, f), "utf8");
    } catch {
      continue; // arquivo ilegível não derruba o resto da varredura.
    }
    for (const line of content.split("\n").slice(1)) {
      const email = line.split(",")[0]?.trim();
      if (email) out.add(email.toLowerCase());
    }
  }
  return out;
}

async function main(argv: string[] = process.argv.slice(2)) {
  const cycle = getArg(argv, "cycle");
  if (!cycle) {
    console.error("[clarice-unblock-orphaned-selections] --cycle {conteúdo}-{envio} é obrigatório.");
    process.exit(1);
  }
  const apply = hasFlag(argv, "apply");
  const baseDir = getArg(argv, "base-dir") || CLARICE_BASE;
  const segDir = clariceSegmentsDir(cycle, baseDir);

  const sentOrQueued = loadSentOrQueuedEmails(segDir);
  const currentlyReferenced = collectCurrentlyReferencedEmails(segDir);
  const orphans = findOrphanedSentOrQueuedEmails(sentOrQueued, currentlyReferenced);

  console.log(JSON.stringify({ cycle, orphansFound: orphans.length, apply, emails: orphans }, null, 2));

  if (orphans.length === 0) {
    console.error("[clarice-unblock-orphaned-selections] nenhum órfão encontrado.");
    return;
  }
  if (!apply) {
    console.error(`[clarice-unblock-orphaned-selections] --dry-run: ${orphans.length} órfão(s) encontrado(s), nada escrito. Rode com --apply pra desbloquear.`);
    return;
  }
  const removed = unblockOrphanedSentOrQueuedEmails(segDir, cycle, orphans);
  console.error(`[clarice-unblock-orphaned-selections] ${removed} email(s) desbloqueado(s) — voltam a ser elegíveis na próxima montagem de fila.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
