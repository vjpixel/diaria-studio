/**
 * lib/geo-citation-staleness-alarm.ts (#4755)
 *
 * Lógica PURA (sem I/O) do alarme de STALENESS do monitor semanal de
 * citação GEO (`geo-citation-monitor.ts`, #4558 Parte C) — mesmo molde de
 * `scripts/lib/apoios-diff-alarm.ts` (fingerprint + re-arma).
 *
 * Contexto (#4755, achado do fleet review da #4754): `test/pending-scheduled-tasks.test.ts`
 * descobre a task `Diaria-Geo-Citation-Monitor` pelo NOME (`Get-ScheduledTask`)
 * mas nunca checa `State`/`LastTaskResult` — uma task registrada e depois
 * desabilitada (ou removida, ou a máquina fica semanas desligada, ou todo
 * provider perde a API key) passa nesse guard em silêncio. Todos esses modos
 * de falha colapsam no MESMO sintoma observável: `data/geo-citations/history.jsonl`
 * para de receber registro novo. Por isso o sinal aqui não é "a última
 * execução falhou" (o exit code já ficou honesto no #4754) — é **staleness**:
 * "faz N dias que não chega registro novo".
 *
 * ─── Por que ~3 semanas, não 1 execução perdida ────────────────────────────
 *
 * A task é SEMANAL (segundas 10:30) — perder 1 execução (máquina desligada
 * naquela segunda, rede fora) não é sinal de nada quebrado. `STALENESS_THRESHOLD_DAYS`
 * cobre 2 execuções semanais perdidas + folga, análogo ao raciocínio de
 * `CONSECUTIVE_FAILURE_THRESHOLD` em `clarice-opens-catchup-alarm.ts` (1
 * falha isolada é normal, N seguidas é sinal real) — só que medido em TEMPO
 * decorrido, porque staleness não tem "execução" pra contar quando a task
 * está desabilitada ou removida (nesse caso não há streak, só silêncio).
 *
 * ─── Idempotência: fingerprint do último registro conhecido ────────────────
 *
 * Igual a `apoios-diff-alarm.ts`: o fingerprint é o `ts` do registro mais
 * recente (ou um sentinela quando não há NENHUM registro legível). Enquanto
 * o histórico ficar parado no MESMO último registro, staleness some ao
 * threshold e o fingerprint não muda — não reenvia o mesmo alarme a cada
 * checagem semanal. Quando um registro novo chega (task voltou a rodar), o
 * fingerprint muda e, se isso tirar o histórico da zona de staleness, o
 * estado persistido volta a `null` — RE-ARMANDO o alarme pra próxima vez que
 * o histórico parar de crescer de novo.
 */

/** Dias sem registro novo até alarmar — ~3 semanas (2 execuções semanais
 * perdidas + folga; a task roda segundas 10:30). */
export const STALENESS_THRESHOLD_DAYS = 21;

/** Fingerprint sentinela usado quando não há NENHUM registro legível em
 * `history.jsonl` (arquivo ausente, vazio, ou 100% de linhas corrompidas) —
 * distinto de qualquer `ts` real, então nunca colide com um fingerprint
 * genuíno. */
export const NEVER_MEASURED_FINGERPRINT = "__never__";

export interface GeoCitationStalenessAlarmState {
  /** Fingerprint do último registro para o qual já alarmamos, ou `null`
   * quando não há staleness pendente conhecida ("re-armado"). */
  lastAlarmedFingerprint: string | null;
  /** ISO — só pra REPORTAR ("desde X"), fora da idempotência. */
  lastCheckedAt: string | null;
}

export function emptyGeoCitationStalenessAlarmState(): GeoCitationStalenessAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pure: fingerprint estável do registro mais recente conhecido — usado pra
 * idempotência (mesmo padrão de `computeDiffFingerprint` em `apoios-diff-alarm.ts`). */
export function fingerprintFor(latestRecordTs: string | null): string {
  return latestRecordTs ?? NEVER_MEASURED_FINGERPRINT;
}

export interface StalenessCheck {
  isStale: boolean;
  /** Dias desde o último registro, ou `null` quando não há nenhum registro
   * legível (não há "desde quando" pra contar). */
  staleDays: number | null;
}

/**
 * Pure: avalia staleness a partir do `ts` do registro mais recente (já
 * extraído pelo caller via I/O — ver `readLatestGeoCitationTs` no script).
 * `null` (arquivo ausente/vazio/corrompido) é tratado como staleness máxima
 * — o monitor nunca produziu nenhuma medição válida, o que é pelo menos tão
 * grave quanto uma medição velha.
 */
export function computeStaleness(
  latestRecordTs: string | null,
  now: Date,
  thresholdDays: number = STALENESS_THRESHOLD_DAYS,
): StalenessCheck {
  if (latestRecordTs === null) {
    return { isStale: true, staleDays: null };
  }
  const latestMs = new Date(latestRecordTs).getTime();
  if (Number.isNaN(latestMs)) {
    // `ts` ilegível — mesmo fail-soft do resto do repo, trata como "nunca medido".
    return { isStale: true, staleDays: null };
  }
  const staleDays = Math.floor((now.getTime() - latestMs) / (24 * 60 * 60 * 1000));
  return { isStale: staleDays >= thresholdDays, staleDays };
}

/** Pura: avança o estado — `fingerprint: null` quando não há staleness
 * pendente nesta checagem (re-arma pra próxima ocorrência). */
export function advanceState(fingerprint: string | null, now: Date): GeoCitationStalenessAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/**
 * Pure: `true` quando o histórico está stale E o fingerprint é diferente do
 * último já alarmado (staleness nova, ou re-apareceu depois de ter sido
 * resolvida — ver docstring do módulo).
 */
export function shouldAlarm(
  state: GeoCitationStalenessAlarmState,
  check: StalenessCheck,
  fingerprint: string,
): boolean {
  if (!check.isStale) return false;
  return fingerprint !== state.lastAlarmedFingerprint;
}

/** Pure: monta assunto + corpo do e-mail de alarme — texto puro, mesmo
 * padrão de `apoios-diff-alarm.ts`/`clarice-opens-catchup-alarm.ts`. */
export function buildGeoCitationStalenessAlarmEmail(
  latestRecordTs: string | null,
  staleDays: number | null,
): { subject: string; body: string } {
  const subject =
    latestRecordTs === null
      ? "[diar.ia.br] monitor de citação GEO nunca registrou nenhuma medição"
      : `[diar.ia.br] monitor de citação GEO sem medição nova há ${staleDays} dias`;

  const lines: string[] = [];
  if (latestRecordTs === null) {
    lines.push(
      "data/geo-citations/history.jsonl está ausente, vazio, ou sem nenhum",
      "registro legível — o monitor semanal de citação (#4558 Parte C) nunca",
      "produziu uma medição válida.",
    );
  } else {
    lines.push(
      `O último registro em data/geo-citations/history.jsonl é de ${latestRecordTs}`,
      `(${staleDays} dia(s) atrás) — mais do que os ${STALENESS_THRESHOLD_DAYS} dias`,
      "esperados (2 execuções semanais perdidas + folga) pra task",
      "\"Diaria-Geo-Citation-Monitor\" (segundas 10:30).",
    );
  }

  lines.push(
    "",
    "Isso cobre, com o mesmo sintoma observável, qualquer um destes motivos:",
    "  - a task foi desabilitada ou removida do Task Scheduler;",
    "  - a máquina do editor ficou semanas desligada/sem essa task rodar;",
    "  - todo provider (ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY) perdeu a key.",
    "",
    "Verifique:",
    "  Get-ScheduledTask -TaskName 'Diaria-Geo-Citation-Monitor' | Get-ScheduledTaskInfo",
    "  data\\geo-citations\\.monitor.log  (últimas execuções da task)",
    "",
    "npx tsx scripts/geo-citation-monitor.ts --dry-run confirma se ao menos um",
    "provider está configurado, sem gastar nenhuma chamada de rede.",
    "",
    "Este alarme não requer nenhuma ação automática — é só um aviso; nada é",
    "escrito na Brevo/Beehiiv/GitHub por ele.",
  );

  return { subject, body: lines.join("\n") };
}
