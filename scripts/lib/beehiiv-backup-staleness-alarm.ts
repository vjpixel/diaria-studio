/**
 * scripts/lib/beehiiv-backup-staleness-alarm.ts (#5494)
 *
 * Lógica PURA do alarme de staleness do snapshot semanal `Diaria-Beehiiv-Backup`
 * (`data/beehiiv-backup/{YYYY-MM-DD}/`, #5229). Fecha o buraco de
 * observabilidade descrito na issue #5494 item 3: se o backup não gerar o
 * snapshot da semana, `check-acquisition-health.ts` cai silenciosamente no
 * guard de idempotência ("já avaliado nesta semana") — journal de servidor,
 * exit 0, sem e-mail. A perda é irrecuperável (`promoteBeehiivSubscription`
 * faz DELETE+CREATE diário e sobrescreve a origem — o snapshot é a única
 * cópia da origem antes da destruição).
 *
 * Mesmo padrão dos outros `*-Alarm` deste lote (#5111
 * `linkedin-weekly-staleness-alarm.ts`, #4755 `geo-citation-staleness-alarm.ts`):
 * lógica pura aqui, I/O (existsSync, envio de e-mail) no script
 * (`scripts/beehiiv-backup-staleness-alarm.ts`).
 *
 * ## Dois motivos de alarme, não confundir
 *
 * 1. **Stale**: existe um snapshot, mas o mais recente tem mais de
 *    `maxAgeDays` (default 7 — a task é semanal, então qualquer coisa acima
 *    de 1 semana já significa que pelo menos 1 rodada foi perdida).
 * 2. **Unusable**: o snapshot mais recente existe (diretório com a data),
 *    mas `isSubscribersSnapshotUsable` (`beehiiv-backup-snapshots.ts`, #5281)
 *    reprova — manifest com erro/skipped, ou `subscribers.jsonl`
 *    ausente/vazio/corrompido. Um snapshot "no prazo" mas inutilizável é tão
 *    ruim quanto um snapshot ausente — a proteção que a #5229 existe pra dar
 *    (preservar a origem antes do DELETE+CREATE) não aconteceu de verdade.
 *
 * `missing` (nenhum snapshot existe ainda) é um 3º veredito, tratado como
 * alarme só se `sinceEpochSecondsForMissing` também já tiver passado —
 * antes da 1ª rodada da task rodar (#5229 armado 260814), zero snapshots é
 * esperado, não um erro; nunca alarmar de propósito antes desse marco (mesmo
 * fail-soft de `check-acquisition-health.ts`: task rodando antes da 1ª
 * dependência existir não é alarme de infraestrutura).
 */

export type BeehiivBackupStalenessVerdict = "ok" | "alarm-stale" | "alarm-unusable" | "alarm-missing" | "ok-too-early";

export interface BeehiivBackupStalenessEvaluation {
  verdict: BeehiivBackupStalenessVerdict;
  /** `null` só quando nenhum snapshot existe (`alarm-missing`/`ok-too-early`). */
  latestSnapshotDate: string | null;
  /** Idade do snapshot mais recente em dias (fracionário), `null` sem snapshot. */
  ageDays: number | null;
}

/** Pure: dado o snapshot mais recente disponível (`latestSnapshotDate`,
 *  `YYYY-MM-DD` ou `null` se nenhum existir), se ele é utilizável
 *  (`usable`, resultado de `isSubscribersSnapshotUsable`), e `now`, decide o
 *  veredito. `latestSnapshotEpochSeconds` é o epoch (segundos, UTC, início
 *  do dia) do `latestSnapshotDate` — computado pelo caller via
 *  `snapshotDateToEpochSeconds` (`acquisition-health.ts`) pra este módulo
 *  não depender de parsing de data.
 *
 *  `firstExpectedRunEpochSeconds`: epoch a partir do qual "nenhum snapshot"
 *  vira alarme de verdade — antes disso (task ainda não teve a chance de
 *  rodar 1x) é `ok-too-early`, nunca `alarm-missing`. Default:
 *  `firstExpectedRunEpochSeconds = 0` (epoch Unix) — ou seja, "já era pra ter
 *  rodado" sempre que o caller não informar um marco explícito, porque
 *  `Diaria-Beehiiv-Backup` (#5229) já está armado e com snapshots reais
 *  desde 260814; ausência de snapshot na produção real É um erro, nunca
 *  "task nova que ainda não teve a chance de rodar". **Cuidado**: um default
 *  derivado de `nowEpochSeconds` (ex.: `nowEpochSeconds - N dias`) é
 *  self-referencial e NUNCA produz `ok-too-early` sozinho — `nowEpochSeconds
 *  >= nowEpochSeconds - N` é sempre verdadeiro pra qualquer N>0 (achado no
 *  self-review do #5494; se algum caller precisar de fato de uma janela de
 *  graça, tem que passar um `firstExpectedRunEpochSeconds` fixo, nunca
 *  relativo ao próprio `now` da chamada). */
export function evaluateBeehiivBackupStalenessAlarm(
  nowEpochSeconds: number,
  latestSnapshotDate: string | null,
  latestSnapshotEpochSeconds: number | null,
  usable: boolean,
  maxAgeDays: number = 7,
  firstExpectedRunEpochSeconds: number = 0,
): BeehiivBackupStalenessEvaluation {
  if (latestSnapshotDate == null || latestSnapshotEpochSeconds == null) {
    return {
      verdict: nowEpochSeconds >= firstExpectedRunEpochSeconds ? "alarm-missing" : "ok-too-early",
      latestSnapshotDate: null,
      ageDays: null,
    };
  }
  const ageDays = (nowEpochSeconds - latestSnapshotEpochSeconds) / 86400;
  if (!usable) {
    return { verdict: "alarm-unusable", latestSnapshotDate, ageDays };
  }
  if (ageDays > maxAgeDays) {
    return { verdict: "alarm-stale", latestSnapshotDate, ageDays };
  }
  return { verdict: "ok", latestSnapshotDate, ageDays };
}

export function isAlarmVerdict(verdict: BeehiivBackupStalenessVerdict): boolean {
  return verdict === "alarm-stale" || verdict === "alarm-unusable" || verdict === "alarm-missing";
}

// ---------------------------------------------------------------------------
// Idempotência — 1 alarme por (veredito, snapshot) até o estado mudar. Mesmo
// padrão de `LinkedinWeeklyStalenessAlarmState` (#5111): reenviar todo dia
// enquanto o mesmo snapshot velho continuar sendo "o mais recente" seria
// ruído, não sinal novo.
// ---------------------------------------------------------------------------

export interface BeehiivBackupStalenessAlarmState {
  lastAlarmedFingerprint: string | null;
  /** #10710 — idempotência dos 2 checks extras, independente do principal. */
  lastCoverageFingerprint?: string | null;
  lastExitHistoryFingerprint?: string | null;
}

export function emptyBeehiivBackupStalenessAlarmState(): BeehiivBackupStalenessAlarmState {
  return { lastAlarmedFingerprint: null, lastCoverageFingerprint: null, lastExitHistoryFingerprint: null };
}

/** Fingerprint estável: veredito + data do snapshot mais recente conhecido
 *  (não a idade em dias, que muda a cada execução mesmo sem nada de novo
 *  acontecer — senão o alarme reenviaria todo dia enquanto ficasse stale). */
export function computeBeehiivBackupStalenessFingerprint(evaluation: BeehiivBackupStalenessEvaluation): string {
  return `${evaluation.verdict}:${evaluation.latestSnapshotDate ?? "none"}`;
}

export function shouldSendBeehiivBackupStalenessAlarm(
  evaluation: BeehiivBackupStalenessEvaluation,
  state: BeehiivBackupStalenessAlarmState,
): boolean {
  if (!isAlarmVerdict(evaluation.verdict)) return false;
  return computeBeehiivBackupStalenessFingerprint(evaluation) !== state.lastAlarmedFingerprint;
}

export function markBeehiivBackupStalenessAlarmed(
  evaluation: BeehiivBackupStalenessEvaluation,
): BeehiivBackupStalenessAlarmState {
  return { lastAlarmedFingerprint: computeBeehiivBackupStalenessFingerprint(evaluation) };
}

// ---------------------------------------------------------------------------
// Cobertura mensal + exit-history (#10710)
//
// O alarme acima só olha o snapshot MAIS RECENTE — por isso não viu nada em
// 14/10/2026, quando todos os snapshots anteriores a 04/10 sumiram de
// `data/beehiiv-backup/` (remoção vinda do OneDrive remoto). Estes dois
// checks fecham o buraco: (1) todo mês-calendário fechado desde o início da
// task semanal precisa ter ao menos 1 snapshot; (2) o backup de
// `exit-history/` (drain via MCP, #7248) precisa existir e estar completo.
// ---------------------------------------------------------------------------

/** 1º mês com a task semanal armada (`Diaria-Beehiiv-Backup`, 1º snapshot
 *  semanal em 2026-08-14). Meses anteriores tinham snapshots avulsos
 *  (2026-06), sem garantia de cobertura — não entram na checagem. */
export const BEEHIIV_BACKUP_COVERAGE_START_MONTH = "2026-08";

/** Meses cuja perda o editor já reconheceu como definitiva (ex: a Lixeira do
 *  OneDrive expirou sem restauração). Mês listado aqui sai do alarme. Vazio
 *  de propósito em 21/10/2026: agosto e setembro de 2026 ainda podem voltar
 *  da Lixeira online do OneDrive (retenção ~30 dias a partir de 14/10). */
export const BEEHIIV_BACKUP_ACKNOWLEDGED_LOST_MONTHS: readonly string[] = [];

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * @pure — meses FECHADOS (de `startMonth` até o mês anterior ao de `todayIso`)
 * sem nenhum snapshot em `snapshotDates` (`YYYY-MM-DD`), menos os
 * `acknowledgedLost`. O mês corrente nunca entra: ainda pode receber o
 * snapshot de domingo.
 */
export function findMonthsWithoutSnapshot(
  snapshotDates: readonly string[],
  todayIso: string,
  startMonth: string = BEEHIIV_BACKUP_COVERAGE_START_MONTH,
  acknowledgedLost: readonly string[] = BEEHIIV_BACKUP_ACKNOWLEDGED_LOST_MONTHS,
): string[] {
  const covered = new Set(snapshotDates.map(monthOf));
  const ack = new Set(acknowledgedLost);
  const current = monthOf(todayIso);
  const missing: string[] = [];
  for (let month = startMonth; month < current; month = nextMonth(month)) {
    if (!covered.has(month) && !ack.has(month)) missing.push(month);
  }
  return missing;
}

/** Fingerprint estável do alarme de cobertura — muda só quando o conjunto de
 *  meses faltantes muda (restaurar um mês, ou um mês novo sumir). */
export function computeCoverageFingerprint(missingMonths: readonly string[]): string {
  return `coverage-missing:${[...missingMonths].sort().join(",")}`;
}

export function buildCoverageAlarmEmail(missingMonths: readonly string[]): { subject: string; body: string } {
  const subject = `⚠️ Beehiiv backup: ${missingMonths.length} mês(es) sem nenhum snapshot (${missingMonths.join(", ")})`;
  const body = [
    "Alarme automático de cobertura mensal do data/beehiiv-backup/ (#10710).",
    "",
    `Meses fechados sem nenhum snapshot semanal: ${missingMonths.join(", ")}.`,
    "",
    "A task semanal grava um snapshot por domingo, então um mês inteiro sem nenhum quer dizer que os snapshots " +
      "foram apagados depois de gravados. Nenhum script do repo apaga data/beehiiv-backup/ (gc-data-dir.ts o exclui " +
      "até no --apply); o caso de 14/10/2026 veio do OneDrive remoto.",
    "",
    "O que fazer: restaurar as pastas YYYY-MM-DD da Lixeira online do OneDrive (onedrive.live.com → Lixeira), que " +
      "guarda o apagado por ~30 dias. Se a perda for definitiva, listar o mês em " +
      "BEEHIIV_BACKUP_ACKNOWLEDGED_LOST_MONTHS (scripts/lib/beehiiv-backup-staleness-alarm.ts) pra este alarme parar.",
  ].join("\n");
  return { subject, body };
}

/** Fingerprint do alarme de exit-history — um por status (missing/incomplete/
 *  unreadable); `complete` nunca alarma. */
export function computeExitHistoryFingerprint(status: string): string {
  return `exit-history:${status}`;
}

export function buildExitHistoryAlarmEmail(status: string): { subject: string; body: string } {
  const subject = `⚠️ Beehiiv exit-history: ${status} (data/beehiiv-backup/exit-history/)`;
  const body = [
    "Alarme automático do backup de exit-history da Beehiiv (#10710, #7248).",
    "",
    `Estado do manifest data/beehiiv-backup/exit-history/manifest.json: ${status}.`,
    "",
    "Esse arquivo guarda o unsubscribed_on REAL dos assinantes inactive — dado que só a MCP list_subscriptions " +
      "expõe e que some junto com o acesso à Beehiiv. Sem ele, a data de saída é estimada e o churn/LTV fica impreciso.",
    "",
    "O que fazer: numa sessão Claude Code com o conector Beehiiv, despachar " +
      'Agent(subagent_type="beehiiv-exit-history-drain"). O Stage 0 da edição diária já despacha sozinho enquanto o ' +
      "manifest não estiver completo (pendingAgentDispatch 0h.4 de scripts/stage-0-run.ts).",
  ].join("\n");
  return { subject, body };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

const VERDICT_REASON: Record<BeehiivBackupStalenessVerdict, string> = {
  ok: "",
  "ok-too-early": "",
  "alarm-missing":
    "Nenhum snapshot foi encontrado em data/beehiiv-backup/ ainda, e a task Diaria-Beehiiv-Backup já deveria ter " +
    "rodado pelo menos 1 vez a esta altura.",
  "alarm-unusable":
    "O snapshot mais recente existe, mas subscribers.jsonl está ausente, vazio, ou o manifest.json reporta erro/skip " +
    "no endpoint subscribers — sem base utilizável pra preservar a origem antes do DELETE+CREATE diário.",
  "alarm-stale": "O snapshot mais recente está com mais dias do que o esperado pra uma task semanal.",
};

export function buildBeehiivBackupStalenessAlarmEmail(
  evaluation: BeehiivBackupStalenessEvaluation,
  maxAgeDays: number,
): { subject: string; body: string } {
  const dateLabel = evaluation.latestSnapshotDate ?? "nenhum snapshot encontrado";
  const ageLabel = evaluation.ageDays != null ? `${Math.round(evaluation.ageDays * 10) / 10} dia(s)` : "n/d";
  const subject = `⚠️ Beehiiv backup semanal: ${evaluation.verdict} (${dateLabel})`;
  const body = [
    `Alarme automático do Diaria-Beehiiv-Backup-Staleness-Alarm (#5494).`,
    "",
    `Veredito: ${evaluation.verdict}`,
    `Snapshot mais recente: ${dateLabel} (idade: ${ageLabel}; limite: ${maxAgeDays} dia(s)).`,
    "",
    VERDICT_REASON[evaluation.verdict],
    "",
    "Por que importa: promoteBeehiivSubscription (scripts/evaluate-brevo-diaria.ts) faz DELETE+CREATE diário e " +
      "sobrescreve o utm_source original — o snapshot semanal é a única cópia da origem antes da destruição. Um " +
      "domingo perdido em silêncio não volta.",
    "",
    "Rode manualmente: npx tsx scripts/backup-beehiiv.ts",
    "",
    "Detalhes: scripts/lib/beehiiv-backup-staleness-alarm.ts, docs/beehiiv-backup-setup.md.",
  ].join("\n");
  return { subject, body };
}
