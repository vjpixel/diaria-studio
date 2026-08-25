/**
 * scripts/lib/session-registry-safebackup-alarm.ts (#6130)
 *
 * Lógica PURA (sem I/O) do alarme "cópia de conflito do OneDrive presente em
 * data/sessions/" — decide os `AlarmFinding[]` a partir da lista de arquivos
 * `*-safeBackup-*` (`listSafeBackupFiles`, `scripts/lib/session-registry.ts`).
 * Runnable em `scripts/session-registry-safebackup-alarm.ts`, mesmo padrão
 * dos demais alarmes agendados do repo (`scripts/onedrive-sync-alarm.ts`
 * consumindo `scripts/lib/alarm-issues.ts`).
 *
 * Um `AlarmFinding` POR ARQUIVO (fingerprint = nome do arquivo) — não um
 * único achado agregado — pra que `alarm-issues.ts` feche/comente cada
 * issue individualmente conforme cada backup específico for resolvido (por
 * `session-registry.ts gc` ou por conciliação manual), em vez de exigir que
 * TODOS os backups pendentes sumam de uma vez pra fechar uma issue só.
 *
 * `family: "estado"` — a condição é RE-CHECÁVEL a cada execução (o arquivo
 * ainda existe em `data/sessions/`?); quando some, o achado se auto-resolve
 * (ver `AlarmFamily` em `alarm-issues.ts`).
 */
import type { AlarmFinding } from "./alarm-issues.ts";

export function buildSafeBackupFindings(backupFiles: readonly string[]): AlarmFinding[] {
  return backupFiles.map((file) => ({
    check: "session-registry-safebackup",
    fingerprint: file,
    title: `[diar.ia.br] session-registry: cópia de conflito do OneDrive presente (${file})`,
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
