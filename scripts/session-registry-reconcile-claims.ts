#!/usr/bin/env node
/**
 * scripts/session-registry-reconcile-claims.ts (#6581)
 *
 * Reconciliação ONE-SHOT e idempotente do ESTOQUE de claims presos em
 * cópias de conflito do OneDrive (`data/sessions/*-safeBackup-*.json`). O
 * #6567 (PR #6571) consertou o WRITE-path de `unclaimIssue` — a remoção de
 * uma issue passou a propagar pra todos os `-safeBackup-*` do grupo — mas
 * isso só evita o problema de CRESCER dali pra frente. Uma claim que só
 * sobrevive num backup porque a sessão que a reivindicou já encerrou (sem
 * jamais chamar `unclaimIssue` depois de bifurcar em `-safeBackup-`) fica
 * presa indefinidamente: o read-path (`is-claimed`/`list-active`, via
 * `mergeSessionRecords`) continua reportando a issue como reivindicada por
 * união fail-safe, e o GC não pode apagar o backup sem perder essa claim —
 * "buraco negro" descrito na #6443, medido em 50 issues na #6581.
 *
 * Este script fecha o estoque: para cada grupo (arquivo real de
 * `data/sessions/` + seus `-safeBackup-*`), calcula a UNIÃO de
 * `claimed_issues` (`decideClaimReconciliation`/`planClaimReconciliation` em
 * `scripts/lib/session-registry.ts` — miolo puro/testável, reusa
 * `groupBackupsByRealStem` e `mergeSessionRecords` já usados pelo read-path e
 * por `unclaimIssue`) e grava a união de volta SÓ no arquivo REAL. Depois
 * disso os backups ficam redundantes (o real já carrega tudo) e o GC
 * (`session-registry-gc.ts`) pode recolhê-los sem perda.
 *
 * Direção fail-safe, igual ao read-path do #6130: **nunca remove claim**, só
 * adiciona ao real. **Nunca apaga backup nenhum** — quem remove é o GC, com
 * os critérios de liveness dele. **Nunca cria arquivo real do zero** para um
 * grupo cujo real não existe (só backups órfãos) — ver nota abaixo. Escrita
 * ATÔMICA (`writeFileAtomic`, via `writeJsonSafe` interno do módulo) — nunca
 * `Edit` sequencial, que colide com o sync do OneDrive (memória do projeto).
 * Idempotente: rodar 2× não muda nada na 2ª (a 2ª leitura já vê a união
 * gravada na 1ª, então `addedIssues` fica vazio pra todo grupo).
 *
 * **Por que backup órfão (sem arquivo real) nunca vira arquivo real novo:**
 * um backup sem real correspondente não tem como este script saber se a
 * sessão foi genuinamente encerrada (real removido de propósito, ex: GC
 * anterior ou `endSession`) ou se é uma bifurcação tão extrema do OneDrive
 * que nem o real sobreviveu — as duas leituras exigem contexto que este
 * script não tem. "Recriar o real com o conteúdo do backup" seria uma
 * decisão de RESSUSCITAR sessão morta, categoricamente diferente de
 * "reconciliar claim de sessão viva" — fora do escopo desta issue (#6581) e
 * do mesmo princípio que `readMergedSessionGroups` já aplica no read-path:
 * backup órfão nunca ressuscita como ativo. Só é REPORTADO aqui; o GC decide
 * o destino dele com os critérios de liveness dele.
 *
 * Uso:
 *   npx tsx scripts/session-registry-reconcile-claims.ts              # dry-run (default) — avalia + imprime, NÃO grava
 *   npx tsx scripts/session-registry-reconcile-claims.ts --push        # grava de verdade no(s) arquivo(s) real(is)
 *
 * Guard de máquina sem `data/` (sessão cloud, clone fresco): pulado
 * inteiramente — `planClaimReconciliation`/`reconcileClaims` já são
 * fail-soft (diretório ausente → plano vazio), mas o guard evita até a
 * tentativa.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { planClaimReconciliation, reconcileClaims } from "./lib/session-registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const LOG_PREFIX = "[session-registry-reconcile-claims]";

function main(): void {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isPush = hasFlag(argv, "push");

  if (!existsSync(DATA_DIR)) {
    console.log(`${LOG_PREFIX} data/ ausente nesta máquina (sessão cloud/clone fresco) — nada a fazer.`);
    return;
  }

  const plan = isPush ? reconcileClaims(ROOT) : planClaimReconciliation(ROOT);

  for (const entry of plan) {
    const verb = !isPush && entry.action === "reconciled" ? "would-reconcile" : entry.action;
    console.log(`${LOG_PREFIX} ${verb} ${entry.identity} (${entry.backupPaths.length} backup(s)) — ${entry.reason}`);
  }

  const reconciledEntries = plan.filter((e) => e.action === "reconciled");
  const orphanCount = plan.filter((e) => e.action === "orphan-backups-only").length;
  const unreadableCount = plan.filter((e) => e.action === "skipped-unreadable-real").length;
  const totalIssuesAdded = reconciledEntries.reduce((sum, e) => sum + e.addedIssues.length, 0);

  console.log(
    `${LOG_PREFIX} ${isPush ? "" : "--dry-run: "}${reconciledEntries.length}/${plan.length} grupo(s) ` +
      `${isPush ? "reconciliados" : "seriam reconciliados"}, ${totalIssuesAdded} claim(s) ${isPush ? "adicionada(s)" : "seriam adicionada(s)"} ao total. ` +
      `${orphanCount} backup(s) órfão(s) (sem real — não tocados), ${unreadableCount} real(is) ilegível(is) (pulado(s)).`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
