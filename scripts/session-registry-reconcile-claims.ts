#!/usr/bin/env node
/**
 * scripts/session-registry-reconcile-claims.ts (#6581)
 *
 * Reconciliação ONE-SHOT e idempotente do ESTOQUE de claims presos em
 * cópias de conflito do OneDrive (`data/sessions/*-safeBackup-*.json`). O
 * #6567 (PR #6571) consertou o WRITE-path de `unclaimIssue` — a remoção de
 * uma issue passou a propagar pra todos os `-safeBackup-*` do grupo — mas
 * isso só evita o problema de CRESCER dali pra frente. Uma claim que só
 * sobrevive num backup enquanto o arquivo REAL do MESMO grupo ainda existe
 * (uma escrita pré-#6567 que só tocou o real, ou um `unclaimIssue` cuja
 * propagação a um backup específico falhou transitoriamente) fica presa: o
 * read-path (`is-claimed`/`list-active`, via `mergeSessionRecords`) continua
 * reportando a issue como reivindicada por união fail-safe, sem que nenhuma
 * escrita pendente resolva isso — "buraco negro" descrito na #6443; o método
 * e a contagem exata medidos no momento da abertura da issue estão no corpo
 * do GitHub, não repetidos aqui (evita um número que rotaria em silêncio a
 * cada nova medição). **Distinto do caso "sessão encerrou e o real foi
 * removido"** (`endSession`/GC) — aí o backup fica ÓRFÃO, sem grupo, e este
 * script explicitamente não o toca (ver nota abaixo).
 *
 * Este script fecha o estoque: para cada grupo (arquivo real de
 * `data/sessions/` + seus `-safeBackup-*`), calcula a UNIÃO de
 * `claimed_issues` (`decideClaimReconciliation`/`planClaimReconciliation`/
 * `reconcileClaims` em `scripts/lib/session-registry.ts` — miolo
 * puro/testável, reusa `groupBackupsByRealStem` e `mergeSessionRecords` já
 * usados pelo read-path e por `unclaimIssue`) e grava a união de volta SÓ no
 * arquivo REAL — que passa a carregar a claim inteira por conta própria, sem
 * depender de nenhum backup sobreviver. **Isso não muda quando o GC pode
 * recolher os backups** — `planSessionGc`/`decideSessionGc` decidem por
 * liveness do GRUPO (heartbeat/pid), nunca por `claimed_issues`, e removem
 * real+backups sempre juntos, atomicamente.
 *
 * Direção fail-safe, igual ao read-path do #6130: **nunca remove claim**, só
 * adiciona ao real. **Nunca apaga backup nenhum** — quem remove é o GC, com
 * os critérios de liveness dele. **Nunca cria arquivo real do zero** para um
 * grupo cujo real não existe (só backups órfãos) — ver nota abaixo. Escrita
 * ATÔMICA (`writeFileAtomic`, via `writeJsonSafe` interno do módulo) — nunca
 * `Edit` sequencial, que colide com o sync do OneDrive (memória do projeto).
 * `reconcileClaims` RECOMPUTA a união contra o estado relido no momento da
 * escrita (não reaplica cegamente o `addedIssues` do plano) — fecha uma
 * corrida onde uma claim legitimamente removida entre o plano e a escrita
 * poderia ser resurrecta (ver docstring de `reconcileClaims`). Idempotente:
 * rodar 2× não muda nada na 2ª (a 2ª leitura já vê a união gravada na 1ª,
 * então `addedIssues` fica vazio pra todo grupo).
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
 *   npx tsx scripts/session-registry-reconcile-claims.ts --root <path> # aponta pra um `data/sessions/` alternativo (testes/CI)
 *
 * Exit code: 0 quando todo grupo terminou em `"reconciled"`/`"no-change"`/
 * `"orphan-backups-only"` (nenhum aponta um problema pra investigar); 1
 * quando pelo menos um grupo terminou `"skipped-unreadable-real"` ou
 * `"write-failed"` — sinal ESTRUTURAL de que algo precisa de atenção, sem
 * depender de reparsear o texto impresso.
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

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[session-registry-reconcile-claims]";

/** `--root <path>` override — só existe pra testes/CI apontarem pra um
 * `data/sessions/` isolado sem depender do checkout real (mesmo padrão de
 * `scripts/safe-delete-edition.ts`). Ausente em uso normal: usa o repo real. */
function resolveRoot(argv: string[]): string {
  const idx = argv.indexOf("--root");
  if (idx !== -1 && argv[idx + 1]) return resolve(argv[idx + 1]!);
  return DEFAULT_ROOT;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const root = resolveRoot(argv);
  loadProjectEnv(root);
  const isPush = hasFlag(argv, "push");
  const dataDir = resolve(root, "data");

  if (!existsSync(dataDir)) {
    console.log(`${LOG_PREFIX} data/ ausente nesta máquina (sessão cloud/clone fresco) — nada a fazer.`);
    return;
  }

  const plan = isPush ? reconcileClaims(root) : planClaimReconciliation(root);

  for (const entry of plan) {
    const verb = !isPush && entry.action === "reconciled" ? "would-reconcile" : entry.action;
    console.log(`${LOG_PREFIX} ${verb} ${entry.identity} (${entry.backupPaths.length} backup(s)) — ${entry.reason}`);
  }

  const reconciledEntries = plan.filter((e) => e.action === "reconciled");
  const orphanCount = plan.filter((e) => e.action === "orphan-backups-only").length;
  const unreadableRealCount = plan.filter((e) => e.action === "skipped-unreadable-real").length;
  const writeFailedCount = plan.filter((e) => e.action === "write-failed").length;
  const totalIssuesAdded = reconciledEntries.reduce((sum, e) => sum + e.addedIssues.length, 0);
  const groupsWithUnreadableBackups = plan.filter((e) => e.unreadableBackupCount > 0);
  const totalUnreadableBackups = groupsWithUnreadableBackups.reduce((sum, e) => sum + e.unreadableBackupCount, 0);

  console.log(
    `${LOG_PREFIX} ${isPush ? "" : "--dry-run: "}${reconciledEntries.length}/${plan.length} grupo(s) ` +
      `${isPush ? "reconciliados" : "seriam reconciliados"}, ${totalIssuesAdded} claim(s) ${isPush ? "adicionada(s)" : "seriam adicionada(s)"} ao total. ` +
      `${orphanCount} backup(s) órfão(s) (sem real — não tocados), ${unreadableRealCount} real(is) ilegível(is) (pulado(s))` +
      `${isPush ? `, ${writeFailedCount} escrita(s) falhada(s) (retenta na próxima execução)` : ""}.`,
  );
  if (totalUnreadableBackups > 0) {
    console.log(
      `${LOG_PREFIX} aviso: ${totalUnreadableBackups} backup(s) ilegível(is)/corrompido(s) através de ` +
        `${groupsWithUnreadableBackups.length} grupo(s) — claims deles (se houver) ficam irrecuperáveis por esta reconciliação.`,
    );
  }

  if (unreadableRealCount > 0 || writeFailedCount > 0) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
