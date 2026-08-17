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
}

export function emptyBeehiivBackupStalenessAlarmState(): BeehiivBackupStalenessAlarmState {
  return { lastAlarmedFingerprint: null };
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
