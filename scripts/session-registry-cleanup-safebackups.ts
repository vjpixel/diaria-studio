#!/usr/bin/env node
/**
 * scripts/session-registry-cleanup-safebackups.ts (#6970)
 *
 * Recolhe (`rmSync`) as cópias de conflito `-safeBackup-*` de
 * `data/sessions/` cujo conteúdo JÁ está totalmente refletido no arquivo
 * REAL do grupo — ou seja, grupos onde `session-registry-reconcile-claims.ts`
 * (irmão deste script, #6581) já não teria nada a fazer. Nada disso
 * acontece sozinho hoje: `reconcileClaims` funde `claimed_issues` no real mas
 * NUNCA remove backup ("quem remove é o GC"), e `planSessionGc` só recolhe
 * backup ÓRFÃO (sessão já ENCERRADA, arquivo real ausente) — uma sessão VIVA
 * com backups já reconciliados acumula esses arquivos pra sempre. Medido ao
 * vivo (#6970): 15 arquivos `-safeBackup-` em `data/sessions/` do helios, um
 * criado no mesmo dia da medição — o mecanismo que os produz (conflito de
 * escrita concorrente do OneDrive entre `Neo`/`helios`) está ativo, não é
 * resíduo histórico.
 *
 * **Restrição deliberada (ver docstring de `planSafeBackupCleanup` em
 * `scripts/lib/session-registry.ts` pro racional completo):** `mergeSessionRecords`
 * ainda não une `merge_grant` entre arquivos do grupo (isso é o objeto do
 * #6952, PR #6969, ainda ABERTA) — então qualquer backup que carregue
 * `merge_grant` (mesmo consumido/expirado) NUNCA é removido por este script,
 * mesmo com claims já reconciliadas. Reavaliar esse limite quando o #6952
 * mergear e `merge_grant` passar a ser unido como `claimed_issues` já é.
 *
 * Uso:
 *   npx tsx scripts/session-registry-cleanup-safebackups.ts              # dry-run (default) — avalia + imprime, NÃO remove
 *   npx tsx scripts/session-registry-cleanup-safebackups.ts --push        # remove de verdade os backups já reconciliados
 *   npx tsx scripts/session-registry-cleanup-safebackups.ts --root <path> # aponta pra um `data/sessions/` alternativo (testes/CI)
 *
 * Exit code: 0 quando nenhum grupo terminou `"skipped-unreadable-real"`; 1
 * caso contrário — sinal ESTRUTURAL de que algo precisa de atenção manual.
 * `"pending-reconciliation"`/`"has-merge-grant"` não são erro — são estados
 * esperados (rode `session-registry-reconcile-claims.ts --push` primeiro
 * pro 1º; o 2º se resolve sozinho quando o #6952 mergear).
 *
 * Guard de máquina sem `data/` (sessão cloud, clone fresco): pulado
 * inteiramente — `planSafeBackupCleanup`/`cleanupReconciledSafeBackups` já
 * são fail-soft (diretório ausente → plano vazio), mas o guard evita até a
 * tentativa.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { planSafeBackupCleanup, cleanupReconciledSafeBackups } from "./lib/session-registry.ts";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[session-registry-cleanup-safebackups]";

/** `--root <path>` override — mesmo padrão de `session-registry-reconcile-claims.ts`. */
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

  const plan = isPush ? cleanupReconciledSafeBackups(root) : planSafeBackupCleanup(root);

  for (const entry of plan) {
    const verb = !isPush && entry.action === "removable" ? "would-remove" : entry.action;
    console.log(`${LOG_PREFIX} ${verb} ${entry.identity} (${entry.backupPaths.length} backup(s)) — ${entry.reason}`);
  }

  const removableEntries = plan.filter((e) => e.action === "removable");
  const pendingCount = plan.filter((e) => e.action === "pending-reconciliation").length;
  const hasGrantCount = plan.filter((e) => e.action === "has-merge-grant").length;
  const unreadableRealCount = plan.filter((e) => e.action === "skipped-unreadable-real").length;
  const totalBackupsRemoved = removableEntries.reduce((sum, e) => sum + e.backupPaths.length, 0);

  console.log(
    `${LOG_PREFIX} ${isPush ? "" : "--dry-run: "}${removableEntries.length}/${plan.length} grupo(s) ` +
      `${isPush ? "recolhidos" : "seriam recolhidos"}, ${totalBackupsRemoved} backup(s) ${isPush ? "removido(s)" : "seriam removido(s)"}. ` +
      `${pendingCount} grupo(s) aguardando reconciliação de claims, ${hasGrantCount} preservado(s) por carregar merge_grant, ` +
      `${unreadableRealCount} real(is) ilegível(is) (pulado(s)).`,
  );

  if (unreadableRealCount > 0) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
