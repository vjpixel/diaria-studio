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
 * A task é SEMANAL (domingos 07:00) — perder 1 execução (máquina desligada
 * naquele domingo, rede fora) não é sinal de nada quebrado. `STALENESS_THRESHOLD_DAYS`
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
 * perdidas + folga; a task roda domingos 07:00). */
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

/** Staleness de UM painel: o rótulo mais o `ts` do registro mais recente
 * dele. Ver `computeMultiPanelStaleness`. */
export interface PanelStaleness {
  panel: string;
  latestRecordTs: string | null;
  check: StalenessCheck;
}

/**
 * Pure: avalia staleness POR PAINEL e devolve o veredito agregado (#4900).
 *
 * **Por que por painel, e não pelo arquivo inteiro.** Até 10/08/2026 só
 * existia um painel, então "history.jsonl tem registro fresco" e "o monitor
 * está saudável" eram a mesma coisa, e olhar a última linha bastava. Com o
 * painel temático ativo, deixam de ser: se o passo `hubs` quebrar de forma
 * sustentada e o `geral` continuar rodando, `history.jsonl` segue recebendo
 * registro fresco toda semana e o alarme nunca dispara — o painel quebrado
 * fica invisível. É o mesmo modo de falha que a auditoria de GEO encontrou
 * no próprio monitor (rodou com 1 de 3 provedores sem alarmar, #4900 item b)
 * e que motivou este alarme (#4755); repeti-lo num nível acima seria
 * gratuito.
 *
 * Alarma se QUALQUER painel estiver stale. Painel sem nenhum registro conta
 * como stale, mesma semântica que `computeStaleness` já dá ao arquivo vazio —
 * e não gera falso positivo de bootstrap porque o monitor e o alarme rodam do
 * MESMO checkout: ou os dois conhecem o painel novo, ou nenhum conhece.
 */
export function computeMultiPanelStaleness(
  latestByPanel: readonly PanelStaleness[],
): { isStale: boolean; stalePanels: PanelStaleness[]; fingerprint: string } {
  const stalePanels = latestByPanel.filter((p) => p.check.isStale);
  // Fingerprint composto: cobre TODOS os painéis, não só os stale. Sem isso,
  // alarmar por `geral` gravaria um fingerprint que também suprimiria o
  // primeiro alarme de `hubs` (e vice-versa) — os dois painéis
  // compartilham um único `lastAlarmedFingerprint` no state.
  const fingerprint = [...latestByPanel]
    .sort((a, b) => a.panel.localeCompare(b.panel))
    .map((p) => `${p.panel}:${p.latestRecordTs ?? NEVER_MEASURED_FINGERPRINT}`)
    .join("|");
  return { isStale: stalePanels.length > 0, stalePanels, fingerprint };
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
  /** #4900: qual painel está stale. `undefined` preserva o texto de antes do
   * 2º painel existir (usado só pelos testes legados do alarme). */
  panel?: string,
): { subject: string; body: string } {
  const panelSuffix = panel ? ` (painel "${panel}")` : "";
  // `staleDays === null` também cobre o caso de `latestRecordTs` NÃO-null mas
  // ilegível (data corrompida — `computeStaleness` já trata isso como
  // "nunca medido", ver docstring) — sem este OR, o ramo `else` abaixo
  // interpolaria staleDays como a string literal "null" (achado de
  // self-review, corrigido antes de reportar; ver
  // test/geo-citation-staleness-alarm.test.ts).
  const neverMeasured = latestRecordTs === null || staleDays === null;
  const subject = neverMeasured
    ? `[diar.ia.br] monitor de citação GEO nunca registrou nenhuma medição${panelSuffix}`
    : `[diar.ia.br] monitor de citação GEO sem medição nova há ${staleDays} dias${panelSuffix}`;

  const lines: string[] = [];
  if (neverMeasured) {
    if (latestRecordTs !== null) {
      lines.push(
        `O último registro em data/geo-citations/history.jsonl tem um campo`,
        `ts ilegível ("${latestRecordTs}") — tratado como equivalente a`,
        "nenhuma medição válida.",
      );
    } else {
      lines.push(
        "data/geo-citations/history.jsonl está ausente, vazio, ou sem nenhum",
        "registro legível — o monitor semanal de citação (#4558 Parte C) nunca",
        "produziu uma medição válida.",
      );
    }
  } else {
    lines.push(
      `O último registro em data/geo-citations/history.jsonl é de ${latestRecordTs}`,
      `(${staleDays} dia(s) atrás) — mais do que os ${STALENESS_THRESHOLD_DAYS} dias`,
      "esperados (2 execuções semanais perdidas + folga) pra task",
      "\"Diaria-Geo-Citation-Monitor\" (domingos 07:00).",
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
