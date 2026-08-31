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
 * ─── Modo de estreia (#6562) — e depois, SEMPRE acima do teto (#6798) ────
 *
 * O design "1 finding por arquivo" acima é deliberado e continua valendo
 * pra volume BAIXO — mas na 1ª execução DESTE alarme numa máquina (state
 * local ainda vazio), um backlog de conflitos acumulado ao longo de semanas
 * podia detonar dezenas de issues de uma vez só (achado ao vivo: 33 issues
 * em ~1min, estreia do #6130 no `helios` em 28/08/2026, e de novo — sem
 * estreia, um lote por vez — 15 issues abertas simultâneas medidas pela
 * auditoria do #6798, 3 dias depois, sem NENHUMA correção). Até o #6798 a
 * agregação só disparava na 1ª execução (`aggregateFindingsOnDebut`),
 * porque o gatilho era "state vazio", não "acima do teto" — a partir da 2ª
 * execução o modo voltava a ser 1-por-arquivo pra sempre, mesmo com o
 * volume continuando alto. `resolveSafeBackupFindings` agora usa
 * `aggregateNoisyFindings` (#6798): agrega SEMPRE que o volume passa de
 * `SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD`, não só na estreia. O
 * fingerprint agregado é fixo (`ESTREIA_AGGREGATE_FINGERPRINT`, nome mantido
 * apesar de não ser mais exclusivo de estreia — reusar a MESMA issue entre
 * execuções, inclusive reabrindo a issue de estreia #6573 se ela já tiver
 * fechado, é o comportamento certo); o que evita silenciar recorrência é
 * `contentSignature` (lista de arquivos ordenada) — quando o conjunto muda
 * entre execuções, `ensureAlarmIssue` comenta a issue existente com a lista
 * atualizada em vez de reusar calado (ver `AlarmFinding.contentSignature`
 * em `alarm-issues.ts`). Abaixo do teto, volta a 1-por-arquivo — cada issue
 * se auto-fecha quando o arquivo some, via streak normal.
 */
import { aggregateNoisyFindings, type AlarmFinding } from "./alarm-issues.ts";

/** Teto (#6562, generalizado no #6798): acima disto, agrega numa issue só
 * em vez de 1 por arquivo — SEMPRE, não só na 1ª execução (ver docstring do
 * módulo). A issue #6562 sugeriu 5-10; 10 escolhido porque é o teto mais
 * alto sugerido — menos agressivo em agregar, mais fiel ao
 * granular-por-arquivo que o #6130 pediu. */
export const SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD = 10;

/** Fingerprint fixo do achado agregado — nunca colide com um nome de
 * arquivo real (`*-safeBackup-*`), e é estável entre execuções pra
 * `alarm-issues.ts` conseguir rastrear/fechar/reusar a MESMA issue.
 * Literal mantido de propósito (nome "estreia" já não descreve o gatilho
 * desde o #6798 — agrega sempre acima do teto, não só na 1ª execução):
 * trocar o literal orfanaria a issue já usada pra isso, inclusive a #6573
 * (fechada) que este mecanismo pode reabrir/reusar de novo. */
const ESTREIA_AGGREGATE_FINGERPRINT = "estreia-aggregate";

export function buildAggregatedSafeBackupFinding(backupFiles: readonly string[]): AlarmFinding {
  const sorted = [...backupFiles].sort();
  return {
    check: "session-registry-safebackup",
    fingerprint: ESTREIA_AGGREGATE_FINGERPRINT,
    title: `[diar.ia.br] session-registry: ${sorted.length} cópias de conflito do OneDrive (agregado)`,
    body: [
      "Achado automático do alarme `Diaria-Session-Registry-SafeBackup-Alarm`",
      "(`scripts/session-registry-safebackup-alarm.ts`, #6130), agregado por volume acima do teto (#6798, generaliza o modo de estreia do #6562).",
      "",
      `${sorted.length} arquivos de backup de conflito encontrados em \`data/sessions/\` nesta execução — acima ` +
        `do teto de ${SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD}, agregados nesta issue única em vez de 1 issue por arquivo:`,
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
        "(`npx tsx scripts/lib/session-registry.ts gc`) remove backups órfãos automaticamente quando é seguro — " +
        "um backup ancorado a uma sessão AINDA ATIVA (ou stale mas dentro da janela conservadora de 7 dias, ver " +
        "`GC_CONSERVATIVE_MAX_AGE_MS`) fica esperando o GC agir sozinho, o que pode levar dias.",
      "",
      "Esta issue é agregada e RECORRENTE (#6798): enquanto o volume seguir acima do teto, esta MESMA issue é " +
        "reusada — quando a lista de arquivos muda (arquivo novo, ou algum já removido pelo GC), um comentário " +
        "novo aqui traz a lista atualizada, em vez de silenciar a mudança. Se o volume cair abaixo do teto, o " +
        "alarme volta ao modo 1-issue-por-arquivo e esta issue se fecha sozinha (streak de ausência).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P3",
    family: "estado",
    // #6798 — string ordenada e estável: muda sse o CONJUNTO de arquivos
    // muda (adição ou remoção), nunca por causa da ordem de listagem do
    // filesystem. É isto que faz `ensureAlarmIssue` comentar em vez de
    // reusar calado quando o backlog evolui.
    contentSignature: sorted.join("|"),
  };
}

/** Grupo declarado em cada finding pra `aggregateNoisyFindings` (#6572,
 * generalizado no #6798) — igual ao `check`, mas é um campo distinto de
 * propósito (nem todo `group` precisa ser o `check`, ver docstring de
 * `AlarmFinding.group`). */
const GROUP = "session-registry-safebackup";

/**
 * Ponto de decisão do alarme (#6562, generalizado no #6572, e de novo no
 * #6798): 1 finding por arquivo em regime normal; 1 finding agregado
 * SEMPRE que o volume excede `SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD`
 * (não mais só na 1ª execução — ver docstring do módulo). A DECISÃO (quando
 * agregar) é delegada ao mecanismo genérico `aggregateNoisyFindings`
 * (`alarm-issues.ts`) — só o TEXTO do achado agregado
 * (`buildAggregatedSafeBackupFinding`) continua específico deste check.
 */
export function resolveSafeBackupFindings(backupFiles: readonly string[]): AlarmFinding[] {
  if (backupFiles.length === 0) return [];
  return aggregateNoisyFindings(buildSafeBackupFindings(backupFiles), {
    threshold: SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD,
    buildAggregate: (_group, groupFindings) => buildAggregatedSafeBackupFinding(groupFindings.map((f) => f.fingerprint)),
  });
}

export function buildSafeBackupFindings(backupFiles: readonly string[]): AlarmFinding[] {
  return backupFiles.map((file) => ({
    check: "session-registry-safebackup",
    fingerprint: file,
    group: GROUP,
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
