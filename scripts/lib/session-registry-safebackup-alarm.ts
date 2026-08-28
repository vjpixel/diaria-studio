/**
 * scripts/lib/session-registry-safebackup-alarm.ts (#6130, agrupamento #6562)
 *
 * Lógica PURA (sem I/O) do alarme "cópia de conflito do OneDrive presente em
 * data/sessions/" — decide os `AlarmFinding[]` a partir da lista de arquivos
 * `*-safeBackup-*` (`listSafeBackupFiles`, `scripts/lib/session-registry.ts`).
 * Runnable em `scripts/session-registry-safebackup-alarm.ts`, mesmo padrão
 * dos demais alarmes agendados do repo (`scripts/onedrive-sync-alarm.ts`
 * consumindo `scripts/lib/alarm-issues.ts`).
 *
 * Um `AlarmFinding` POR ARQUIVO (fingerprint = nome do arquivo), mas todos
 * compartilhando o mesmo `group` GLOBAL do check (#6562) — `alarm-issues.ts`
 * (`collapseGroupedFindings`) funde toda a lista num único finding efetivo
 * antes de criar/reusar issue, então o resultado é **1 issue pro check
 * inteiro**, com o corpo listando cada arquivo/instância ativa — em vez de 1
 * issue por arquivo (que produziu 37 issues abertas de uma vez, #6518–#6550,
 * antes desta mudança). O fingerprint POR ARQUIVO é preservado em cada
 * `AlarmFinding` (não removido) — é o que faz cada arquivo aparecer
 * individualmente listado no corpo da issue de grupo, e o que faz as
 * entries de estado ANTIGAS (uma por fingerprint, de antes do #6562) pararem
 * de bater com o `pending` desta execução (que agora só produz a chave do
 * grupo) — avançando o `missingStreak` delas até o auto-close natural
 * (`CLOSE_ALARM_ISSUE_AFTER_RUNS`), sem exigir nenhuma migração manual das
 * 33 issues já abertas.
 *
 * `family: "estado"` — a condição é RE-CHECÁVEL a cada execução (o arquivo
 * ainda existe em `data/sessions/`?); quando some, o achado se auto-resolve
 * (ver `AlarmFamily` em `alarm-issues.ts`). O GRUPO só fecha quando TODOS os
 * arquivos tiverem sumido — `collapseGroupedFindings` marca o grupo como
 * `"evento"` só se alguma instância for `"evento"` (nunca o caso aqui, todas
 * são `"estado"`).
 */
import type { AlarmFinding } from "./alarm-issues.ts";

/** Grupo GLOBAL do check (#6562) — toda cópia de conflito detectada nesta
 * execução cai no mesmo grupo, então o resultado é 1 issue pro check
 * inteiro (não 1 por sessionId nem 1 por arquivo). */
const SAFEBACKUP_GROUP = "session-registry-safebackup";

export function buildSafeBackupFindings(backupFiles: readonly string[]): AlarmFinding[] {
  return backupFiles.map((file) => ({
    check: "session-registry-safebackup",
    fingerprint: file,
    group: SAFEBACKUP_GROUP,
    title: `[diar.ia.br] session-registry: cópia(s) de conflito do OneDrive presente(s)`,
    body: [
      "Achado automático do alarme `Diaria-Session-Registry-SafeBackup-Alarm`",
      "(`scripts/session-registry-safebackup-alarm.ts`, #6130).",
      "",
      `Arquivo: \`data/sessions/${file}\`.`,
      "",
      "A presença de uma cópia de conflito `*-safeBackup-*` em `data/sessions/` significa que o OneDrive " +
        "bifurcou o arquivo de registro de uma sessão durante o sync (`data/` é uma junction compartilhada entre " +
        "máquinas) — o arquivo \"real\" e o(s) backup(s) podem divergir em `claimed_issues` se o conflito ocorreu " +
        "enquanto um claim estava sendo gravado.",
      "",
      "**Não é um bloqueio imediato** — `is-claimed`/`listActiveSessions` (`scripts/lib/session-registry.ts`) já " +
        "consideram a UNIÃO dos claims do arquivo real com todo backup do MESMO sessionId (fail-safe: preferir " +
        "\"está reivindicada\" a \"não está\", #6130). Este alarme é só o sinal de que o sync teve um conflito de " +
        "escrita concorrente que vale limpar — GC de sessão encerrada (`npx tsx scripts/lib/session-registry.ts gc`) " +
        "remove backups órfãos automaticamente quando é seguro (ver docstring de `planSessionGc`); um backup " +
        "ancorado a uma sessão AINDA ATIVA fica esperando a sessão encerrar antes do GC agir.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando este arquivo " +
        "deixar de existir por execuções consecutivas (mesmo padrão dos outros alarmes agendados do repo).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P3",
    family: "estado",
  }));
}
