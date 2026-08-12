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
 * cobre 1 execução semanal perdida + folga, análogo ao raciocínio de
 * `CONSECUTIVE_FAILURE_THRESHOLD` em `clarice-opens-catchup-alarm.ts` (1
 * falha isolada é normal, N seguidas é sinal real) — só que medido em TEMPO
 * decorrido, porque staleness não tem "execução" pra contar quando a task
 * está desabilitada ou removida (nesse caso não há streak, só silêncio).
 *
 * ─── Por que 10, não 21 (#5117 item 5) ──────────────────────────────────────
 *
 * O valor original (21 dias ≈ 2 execuções semanais perdidas) não cabe no
 * próprio ciclo do alarme: ele mesmo só roda aos domingos (10:30, depois do
 * monitor das 07:00), então 21 dias de silêncio squeeza 3 domingos inteiros
 * de checagem sem detectar nada — o cenário descrito no #5117 (task
 * regenerada errado e ninguém percebe até 01/09) é exatamente esse buraco.
 * 10 dias cobre 1 execução semanal perdida (~7 dias) + folga de ~3 dias sem
 * abrir uma segunda semana de silêncio antes de alarmar.
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

/** Dias sem registro novo até alarmar — ~10 dias (1 execução semanal perdida
 * + folga; a task roda domingos 07:00 — ver #5117 item 5 para o porquê de
 * não ser mais 21). */
export const STALENESS_THRESHOLD_DAYS = 10;

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
 *
 * **Fingerprint cobre só os painéis STALE (#4961).** Uma versão anterior
 * compunha o fingerprint com TODOS os painéis monitorados, saudáveis
 * inclusive — a intenção era não deixar o 1º alarme de `hubs` ser suprimido
 * por já ter alarmado `geral` antes (os dois painéis compartilham um único
 * `lastAlarmedFingerprint` no state). Isso resolvia aquele problema, mas
 * criava um pior: com `hubs` travado (mesmo `ts` toda semana) e `geral`
 * saudável avançando normalmente, o `ts` de `geral` entrava no fingerprint
 * composto e o mudava toda semana mesmo sem nada mudar em `hubs` —
 * `shouldAlarm` reenviava o mesmo alarme de `hubs` indefinidamente, quebrando
 * a idempotência que este módulo promete (ver docstring do arquivo).
 * Restringir o fingerprint aos painéis em `stalePanels` resolve os dois ao
 * mesmo tempo: um painel saudável nunca entra no fingerprint (não pode mais
 * causar reenvio espúrio), e quando um painel ADICIONAL fica stale ele entra
 * no conjunto e muda o fingerprint (não é suprimido pelo alarme anterior,
 * que cobria um conjunto de painéis stale diferente).
 */
export function computeMultiPanelStaleness(
  latestByPanel: readonly PanelStaleness[],
): { isStale: boolean; stalePanels: PanelStaleness[]; fingerprint: string } {
  const stalePanels = latestByPanel.filter((p) => p.check.isStale);
  const fingerprint = [...stalePanels]
    .sort((a, b) => a.panel.localeCompare(b.panel))
    .map((p) => `${p.panel}:${p.latestRecordTs ?? NEVER_MEASURED_FINGERPRINT}`)
    .join("|");
  // #4961 achado secundário: ordena por staleDays desc (pior primeiro) antes
  // de devolver — o caller usa `stalePanels[0]` como "o painel mais grave"
  // (ver `scripts/geo-citation-staleness-alarm.ts`), e a ordem de entrada
  // aqui é a de `MONITORED_PANELS`, não a de gravidade. `staleDays: null`
  // (nunca medido) é pelo menos tão grave quanto qualquer valor numérico —
  // tratado como pior de todos (Infinity) pra ordenação.
  const sortedStalePanels = [...stalePanels].sort(
    (a, b) => (b.check.staleDays ?? Infinity) - (a.check.staleDays ?? Infinity),
  );
  return { isStale: stalePanels.length > 0, stalePanels: sortedStalePanels, fingerprint };
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
