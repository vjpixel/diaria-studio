/**
 * scripts/lib/ads-spend-ingest-alarm.ts (#5597)
 *
 * Lógica PURA do alarme que interpreta o CONTEÚDO do log de
 * `scripts/google-ads-ingest-spend.ts` (e, quando o mesmo padrão for
 * espelhado lá, `scripts/microsoft-ads-ingest-spend.ts`) — não só o exit
 * code. Decisão deliberada do #5237/#5502: os dois scripts mantêm exit code
 * 0 em toda classe de falha, inclusive `defect` (query malformada, versão
 * de API descontinuada) — a task agendada encadeia
 * `google-ads-ingest-spend.ts && microsoft-ads-ingest-spend.ts`, e sair
 * não-zero calaria a ingestão do canal vizinho. A distinção fica só no
 * BANNER (`console.error` com "✖ DEFEITO na ingestão"), o que significa que
 * nenhum alarme baseado em `systemctl --state=failed` (#5563) consegue
 * enxergar um defeito real — a unit sempre sai "sucesso".
 *
 * **Escopo desta unidade (#5597):** só o script do alarme, seguindo a
 * convenção de `clarice-envio-alarm.ts` (lê CONTEÚDO gravado por outra
 * task, classifica, alarma) — a task `Diaria-Ads-Spend-Ingest` em si ainda
 * NÃO existe no registro (`docs/scheduled-tasks-registry.md`, #5502 Parte
 * C), então não há log real pra ler até ela ser criada/armada. Este alarme
 * fica pronto pra quando isso acontecer, com `logPath` default seguindo a
 * mesma convenção de subpasta que `spend.csv` já usa (`data/aquisicao/`).
 *
 * ## Formato do log lido
 *
 * `scripts/lib/task-runner.ts` (`runScheduledTask`) grava cada execução
 * como um bloco delimitado:
 *
 *     ===== <ISO timestamp> - <description> =====
 *     ----- <stepKey> -----
 *     <stdout+stderr do passo, cru>
 *     ===== fim (<stepKey>=<code> ...) =====
 *
 * `parseLatestLogRun` extrai o ÚLTIMO bloco (execução mais recente,
 * múltiplas execuções se acumulam no mesmo arquivo via `appendFileSync`) —
 * é sobre ESSE texto que a classificação de conteúdo roda.
 */

/** Verdict determinístico da última execução conhecida. */
export type AdsSpendIngestAlarmVerdict = "ok" | "alarm-defect" | "alarm-no-run";

export interface AdsSpendIngestAlarmEvaluation {
  verdict: AdsSpendIngestAlarmVerdict;
  /** Texto do run mais recente encontrado no log — `null` quando
   *  `verdict === "alarm-no-run"` (log ausente, vazio, ou sem nenhum bloco
   *  reconhecível). */
  latestRun: string | null;
  /** Timestamp ISO do início do run mais recente, extraído do cabeçalho
   *  `===== <ISO> - ... =====` — `null` junto com `latestRun`. */
  latestRunAt: string | null;
}

/** Marcador literal emitido por `reportFallback` em
 *  `scripts/google-ads-ingest-spend.ts` quando `failureClass === "defect"`
 *  — ver docstring do módulo pro racional de exit 0 mesmo neste caso. */
const DEFECT_MARKER = "✖ DEFEITO";

/** Regex do cabeçalho de bloco escrito por `runScheduledTask` —
 *  `===== 2026-08-17T18:20:00.000Z - descrição qualquer =====`. Captura o
 *  timestamp ISO em group 1. Âncora de início de linha (`m` flag) — o
 *  bloco pode conter qualquer texto arbitrário no meio (stdout/stderr de
 *  script), inclusive linhas que comecem com `=====` por acidente; a
 *  distinção real é feita por SPLIT em todos os cabeçalhos válidos e pegar
 *  o último segmento, não por um regex "greedy até o próximo =====". */
const RUN_HEADER_RE = /^===== (\S+) - .*=====$/gm;

/**
 * Extrai o texto do bloco de execução mais recente de um log acumulado
 * (múltiplos runs concatenados via `appendFileSync`, mais antigo primeiro).
 * `null` se `logContent` for `null`/vazio ou não tiver nenhum cabeçalho de
 * run reconhecível (log corrompido/formato inesperado — tratado como "não
 * dá pra confirmar que rodou", mesmo racional fail-toward-alarming de
 * `classifyEnvioReportId`).
 *
 * @pure
 */
export function parseLatestLogRun(logContent: string | null): { text: string; startedAt: string } | null {
  if (!logContent) return null;

  const headers: Array<{ index: number; startedAt: string }> = [];
  for (const m of logContent.matchAll(RUN_HEADER_RE)) {
    headers.push({ index: m.index, startedAt: m[1] });
  }
  if (headers.length === 0) return null;

  const last = headers[headers.length - 1];
  const text = logContent.slice(last.index).trim();
  return { text, startedAt: last.startedAt };
}

/**
 * `true` quando `startedAt` (ISO) cai no MESMO dia-calendário UTC que
 * `now` — usado pra decidir "a task rodou hoje" sem reconsultar systemd.
 * Comparação em UTC (não BRT) de propósito: o objetivo é só "existe
 * atividade recente", não uma fronteira de dia editorial precisa — mesma
 * simplificação aceita em `readArmedTimerUnitBaseNames` (#5607) e outros
 * alarmes de cadência diária deste repo que não precisam de fuso exato.
 *
 * @pure
 */
export function isRunFromToday(startedAt: string, now: Date): boolean {
  const started = new Date(startedAt);
  if (isNaN(started.getTime())) return false;
  return started.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

/**
 * Avalia o log acumulado da ingestão de gasto de aquisição. `logContent` é
 * `null` quando o arquivo não existe (task nunca rodou nesta máquina, ou
 * ainda não foi armada — #5597/#5502 Parte C).
 *
 * - Nenhum run reconhecível, OU o run mais recente não é de HOJE →
 *   `alarm-no-run` (mesmo racional de `alarm-no-report` do
 *   `clarice-envio-alarm.ts` — a task pode ter simplesmente nunca disparado,
 *   caso que `Diaria-Systemd-Failed-Units-Alarm`/`--state=failed` não cobre).
 * - Run de hoje contém o marcador `✖ DEFEITO` → `alarm-defect` — o caso
 *   concreto que motivou a issue: exit 0 fixo esconde um defeito real.
 * - Run de hoje sem o marcador → `ok` (inclusive os desfechos `auth-pending`/
 *   `empty`, que são estado esperado, não falha).
 *
 * @pure
 */
export function evaluateAdsSpendIngestAlarm(logContent: string | null, now: Date): AdsSpendIngestAlarmEvaluation {
  const latest = parseLatestLogRun(logContent);
  if (!latest || !isRunFromToday(latest.startedAt, now)) {
    return { verdict: "alarm-no-run", latestRun: latest?.text ?? null, latestRunAt: latest?.startedAt ?? null };
  }
  const verdict: AdsSpendIngestAlarmVerdict = latest.text.includes(DEFECT_MARKER) ? "alarm-defect" : "ok";
  return { verdict, latestRun: latest.text, latestRunAt: latest.startedAt };
}

export function isAlarmingVerdict(verdict: AdsSpendIngestAlarmVerdict): boolean {
  return verdict !== "ok";
}

// ---------------------------------------------------------------------------
// Idempotência — 1 alarme por dia-calendário UTC (`YYYY-MM-DD` do
// `latestRunAt`, ou da própria checagem quando não há run — "sem run hoje"
// também merece 1 alarme por dia, não repetido a cada invocação da task de
// alarme).
// ---------------------------------------------------------------------------

export interface AdsSpendIngestAlarmState {
  lastAlarmedDay: string | null;
}

export function emptyAdsSpendIngestAlarmState(): AdsSpendIngestAlarmState {
  return { lastAlarmedDay: null };
}

export function shouldSendAdsSpendIngestAlarm(
  evaluation: AdsSpendIngestAlarmEvaluation,
  state: AdsSpendIngestAlarmState,
  now: Date,
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  const today = now.toISOString().slice(0, 10);
  return state.lastAlarmedDay !== today;
}

export function markAdsSpendIngestAlarmed(now: Date): AdsSpendIngestAlarmState {
  return { lastAlarmedDay: now.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildAdsSpendIngestAlarmEmail(
  evaluation: AdsSpendIngestAlarmEvaluation,
  logPath: string,
  issueLines: string,
): { subject: string; body: string } {
  if (evaluation.verdict === "alarm-defect") {
    return {
      subject: "⚠️ Diaria-Ads-Spend-Ingest: DEFEITO real detectado no log (exit code não avisa)",
      body:
        `O log de ingestão de gasto (${logPath}) contém o marcador "${DEFECT_MARKER}" no run mais recente ` +
        `(${evaluation.latestRunAt}) — query malformada ou versão de API descontinuada em ` +
        `scripts/lib/google-ads-ingest.ts, não indisponibilidade externa esperada. Por decisão do #5237, ` +
        `o script sai com exit 0 mesmo neste caso (pra não calar a ingestão do canal vizinho na mesma task ` +
        `encadeada) — este alarme existe justamente pra tornar visível o que o exit code esconde.\n\n` +
        `Trecho do run:\n\n${evaluation.latestRun}\n\n` +
        `Corrigir em scripts/lib/google-ads-ingest.ts (query GAQL / apiVersion) — esperar não resolve.` +
        issueLines,
    };
  }
  return {
    subject: "⚠️ Diaria-Ads-Spend-Ingest: nenhuma execução encontrada hoje",
    body:
      `Nenhum run de hoje foi encontrado em ${logPath} — a task pode não ter disparado ` +
      `(systemd não armado/desabilitado, máquina desligada na janela) ou o log nunca foi criado. ` +
      `Verifique: systemctl --user list-timers | grep ads-spend, e ` +
      `journalctl --user -u diaria-ads-spend-ingest.service -n 50 se a unit existir.` +
      issueLines,
  };
}
