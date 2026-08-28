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
 *
 * ─── Modo de estreia (#6562) ─────────────────────────────────────────────
 *
 * O design "1 finding por arquivo" acima é deliberado e continua valendo em
 * regime estacionário — mas na 1ª execução DESTE alarme numa máquina (state
 * local ainda vazio), um backlog de conflitos acumulado ao longo de semanas
 * pode detonar dezenas de issues de uma vez só (achado ao vivo: 33 issues
 * em ~1min, estreia do #6130 no `helios` em 28/08/2026). `resolveSafeBackupFindings`
 * é o ponto de decisão: quando o state está vazio E o volume de backups
 * excede `SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD`, agrega tudo numa única
 * issue (`buildAggregatedSafeBackupFinding`) em vez de 1 por arquivo. Como o
 * gatilho é "state vazio" (não "acima do teto"), a agregação só acontece
 * nessa 1ª execução — a partir da 2ª (state já tem a entry do achado
 * agregado), o modo volta a ser 1-por-arquivo incondicionalmente, mesmo que
 * o volume continue alto; a issue agregada se auto-fecha então (fingerprint
 * fixo, nunca reaparece nos findings per-file) depois de
 * `CLOSE_ALARM_ISSUE_AFTER_RUNS` execuções sem reaparecer.
 */
import type { AlarmFinding } from "./alarm-issues.ts";

/** Teto (#6562): acima disto, na 1ª execução (state vazio), agrega numa
 * issue só em vez de 1 por arquivo. A issue #6562 sugeriu 5-10; 10 escolhido
 * porque é o teto mais alto sugerido — menos agressivo em agregar, mais
 * fiel ao granular-por-arquivo que o #6130 pediu. */
export const SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD = 10;

/** Fingerprint fixo do achado agregado de estreia — nunca colide com um
 * nome de arquivo real (`*-safeBackup-*`), e é estável entre execuções pra
 * `alarm-issues.ts` conseguir rastrear/fechar a MESMA issue. */
const ESTREIA_AGGREGATE_FINGERPRINT = "estreia-aggregate";

export function buildAggregatedSafeBackupFinding(backupFiles: readonly string[]): AlarmFinding {
  const sorted = [...backupFiles].sort();
  return {
    check: "session-registry-safebackup",
    fingerprint: ESTREIA_AGGREGATE_FINGERPRINT,
    title: `[diar.ia.br] session-registry: ${sorted.length} cópias de conflito do OneDrive na estreia do alarme`,
    body: [
      "Achado automático do alarme `Diaria-Session-Registry-SafeBackup-Alarm`",
      "(`scripts/session-registry-safebackup-alarm.ts`, #6130), agregado por ser a 1ª execução (modo de estreia, #6562).",
      "",
      `${sorted.length} arquivos de backup de conflito encontrados em \`data/sessions/\` na 1ª execução deste ` +
        `alarme nesta máquina — acima do teto de ${SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD}, agregados nesta ` +
        "issue única em vez de 1 issue por arquivo:",
      "",
      ...sorted.map((file) => `- \`data/sessions/${file}\``),
      "",
      "A presença de cópias de conflito `*-safeBackup-*` em `data/sessions/` significa que o OneDrive bifurcou " +
        "o arquivo de registro de uma sessão durante o sync (`data/` é uma junction compartilhada entre máquinas) " +
        "— o arquivo \"real\" e o(s) backup(s) podem divergir em `claimed_issues` se o conflito ocorreu enquanto " +
        "um claim estava sendo gravado.",
      "",
      "**Não é um bloqueio imediato** — `is-claimed`/`listActiveSessions` (`scripts/lib/session-registry.ts`) já " +
        "consideram a UNIÃO dos claims do arquivo real com todo backup do MESMO sessionId (fail-safe: preferir " +
        "\"está reivindicada\" a \"não está\", #6130). GC de sessão encerrada " +
        "(`npx tsx scripts/lib/session-registry.ts gc`) remove backups órfãos automaticamente quando é seguro.",
      "",
      "Esta issue agregada é exclusiva da 1ª execução do alarme — a partir da execução seguinte o alarme volta " +
        "ao modo normal (1 issue por arquivo, ver #6130) e esta issue se fecha sozinha, independente de os " +
        "arquivos ainda existirem ou não.",
    ].join("\n"),
    labels: ["bug"],
    priority: "P3",
    family: "estado",
  };
}

/**
 * Ponto de decisão do alarme (#6562): 1 finding por arquivo em regime
 * normal; 1 finding agregado só na 1ª execução (`stateIsEmpty`) quando o
 * volume excede `SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD`. Ver docstring do
 * módulo, seção "Modo de estreia".
 */
export function resolveSafeBackupFindings(
  backupFiles: readonly string[],
  stateIsEmpty: boolean,
): AlarmFinding[] {
  if (backupFiles.length === 0) return [];
  if (stateIsEmpty && backupFiles.length > SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD) {
    return [buildAggregatedSafeBackupFinding(backupFiles)];
  }
  return buildSafeBackupFindings(backupFiles);
}

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
