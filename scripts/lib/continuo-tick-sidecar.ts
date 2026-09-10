/**
 * scripts/lib/continuo-tick-sidecar.ts (#7814)
 *
 * O detector de fabricação de conclusão do contínuo (#7537,
 * `hermes/scripts/detect-tick-claim-fabrication.py`) só é AUDITÁVEL por um
 * humano enquanto `~/.hermes/logs/agent.log*` ainda tiver a linha que
 * confirma (ou refuta) a alegação do tick. Esse log rotaciona por TAMANHO
 * (sem política de retenção declarada — medido ao vivo em 10/09/2026:
 * `agent.log` + `.1`/`.2`/`.3`, ~5MB cada, cobrindo de forma VARIÁVEL entre
 * ~3 e ~15 dias dependendo do volume de tick) — o achado do #7641 (ocorrência
 * de 06/09 sem transcript, a de 08/09 ainda investigável) é o caso concreto
 * de perda.
 *
 * Em vez de reter `agent.log` inteiro por mais tempo (decisão de política
 * de rotação do Hermes, fora deste repo — `hermes/scripts/watch-continuo-
 * health.sh` só CONSOME, não escreve `~/.hermes/logs/`), este módulo extrai
 * um SIDECAR ENXUTO por tick — chamadas de ferramenta (nome, timestamp,
 * tamanho) e o `session_id` do bracket do log, nunca o texto/transcript
 * completo — e persiste em `data/continuo/tick-sidecars/` (OneDrive,
 * gitignored, SEM rotação por tamanho) antes que o log de origem rotacione
 * pra fora. "Capturar o que basta" em vez de "guardar tudo" (item 3 da
 * issue).
 *
 * ## Formato da linha de origem
 *
 * `agent.tool_executor` grava, por chamada de ferramenta concluída:
 *
 *     2026-09-09 15:41:23,039 INFO [cron_5d791ef6fc2c_20260909_123316] agent.tool_executor: tool terminal completed (4.78s, 4046 chars)
 *     2026-09-02 05:27:09,312 WARNING [cron_5d791ef6fc2c_20260902_022624] agent.tool_executor: Tool terminal returned error (3.05s): {...}
 *
 * O bracket `[session_id]` é o identificador de tick do PRÓPRIO Hermes
 * (`cron_{job_id}_{YYYYMMDD}_{HHMMSS}`) — DIFERENTE do `sessionId` (UUID)
 * que `scripts/lib/session-registry.ts` grava em `data/sessions/continuo-*.json`
 * (aquele é o `session_id` do harness Claude Code DENTRO do tick). Os dois
 * espaços de identificador não são o mesmo — foi exatamente essa confusão
 * de correlação que causou o falso positivo investigado no #7641. Este
 * módulo usa o bracket do log DIRETAMENTE (extraído por match de string, sem
 * inferência de janela/timestamp) — não precisa correlacionar nada.
 *
 * Timestamp do `agent.log` é UTC (confirmado no #7641: a linha
 * `09:51:26,124` citada lá bate, no mesmo segundo, com o mtime real do
 * arquivo escrito, descrito no mesmo texto como "09:51:26 UTC").
 *
 * Nem toda linha de ferramenta tem `[session_id]` (chamadas fora de um
 * bracket cron aparecem soltas, sem sessão associada — decisão explícita:
 * `parseAgentLogLine` devolve `null` pra elas, nunca um sessionId
 * inventado). O CAMINHO escrito (ex: qual arquivo o `write_file` tocou) não
 * aparece nesta linha — limitação documentada, não fabricada: o sidecar
 * registra nome/timestamp/tamanho da chamada, não o argumento dela.
 */

export type ToolCallOutcome = "completed" | "failed" | "returned_error";

export interface ToolCallEvent {
  /** Bracket de sessão do Hermes, ex: `cron_5d791ef6fc2c_20260909_123316`. */
  readonly sessionId: string;
  /** ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`). */
  readonly at: string;
  readonly tool: string;
  readonly outcome: ToolCallOutcome;
  readonly durationS: number | null;
  readonly sizeChars: number | null;
}

export interface TickSidecar {
  readonly sessionId: string;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly toolCallCount: number;
  readonly toolCalls: ReadonlyArray<{
    readonly at: string;
    readonly tool: string;
    readonly outcome: ToolCallOutcome;
    readonly durationS: number | null;
    readonly sizeChars: number | null;
  }>;
  /** ISO 8601 UTC de quando o sidecar foi extraído (não de quando o tick rodou). */
  readonly capturedAt: string;
}

/** Tick é de 30min (protocolo do contínuo). Folga generosa antes de
 * considerar uma sessão "encerrada" e pronta pra captura — capturar cedo
 * demais persistiria um sidecar incompleto (tick ainda em andamento) que
 * nunca mais seria atualizado (a captura é idempotente por design, ver
 * `selectSessionsToCapture`). */
export const DEFAULT_MIN_IDLE_MINUTES = 60;

/** Retenção do sidecar em `data/continuo/tick-sidecars/` — âncora no
 * consumo real (item 2 da issue): watchdog abre issue, overnight/develop
 * trabalha na noite seguinte ou após um fim de semana longo. 45 dias é
 * "semanas" (linguagem da própria issue) com folga bem acima do piso de 7
 * dias — sidecar é KB, não MB, então o custo de reter mais é desprezível. */
export const DEFAULT_MAX_AGE_DAYS = 45;

const LOG_LINE_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})\s+(?:INFO|WARNING|ERROR|DEBUG)\s+\[([^\]]+)\]\s+agent\.tool_executor:\s+[Tt]ool\s+(\S+)\s+(completed|failed|returned error)(?:\s+\(([\d.]+)s(?:,\s*(\d+)\s*chars)?\))?/;

/** Parseia UMA linha de `agent.log`. `null` quando a linha não é uma
 * conclusão de ferramenta com bracket de sessão — nunca inventa sessionId
 * pra linha sem bracket (ex: entradas de fallback do harness sem cron). */
export function parseAgentLogLine(line: string): ToolCallEvent | null {
  const m = LOG_LINE_RE.exec(line);
  if (!m) return null;
  const [, date, ms, sessionId, tool, outcomeRaw, durationRaw, sizeRaw] = m;
  const outcome: ToolCallOutcome =
    outcomeRaw === "completed" ? "completed" : outcomeRaw === "failed" ? "failed" : "returned_error";
  return {
    sessionId,
    at: `${date.replace(" ", "T")}.${ms}Z`,
    tool,
    outcome,
    durationS: durationRaw !== undefined ? Number(durationRaw) : null,
    sizeChars: sizeRaw !== undefined ? Number(sizeRaw) : null,
  };
}

/** Parseia um texto de log inteiro (múltiplas linhas), ignorando linhas que
 * não casam (fail-soft — um `agent.log` tem MUITAS linhas que não são
 * conclusão de ferramenta). */
export function parseAgentLogText(text: string): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];
  for (const line of text.split("\n")) {
    const event = parseAgentLogLine(line);
    if (event) events.push(event);
  }
  return events;
}

/** Restringe a eventos de sessões do job do contínuo (`CONTINUO_JOB_ID` em
 * `scripts/check-continuo-auth-stall.ts` — reusado, não duplicado). Outras
 * sessões do Hermes (outros crons, sessões interativas) não são do escopo
 * deste sidecar. */
export function filterToolCallsBySessionPrefix(
  events: readonly ToolCallEvent[],
  prefix: string,
): ToolCallEvent[] {
  return events.filter((e) => e.sessionId.startsWith(prefix));
}

/** Agrupa eventos por `sessionId` (bracket do log), ordem de inserção
 * preservada dentro de cada grupo (mas não garantidamente cronológica —
 * `buildTickSidecar` ordena antes de persistir). */
export function groupBySession(events: readonly ToolCallEvent[]): Map<string, ToolCallEvent[]> {
  const groups = new Map<string, ToolCallEvent[]>();
  for (const event of events) {
    const existing = groups.get(event.sessionId);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(event.sessionId, [event]);
    }
  }
  return groups;
}

/** Constrói o sidecar de UM tick a partir dos eventos já filtrados pro seu
 * `sessionId`. Ordena por timestamp — a ordem de chegada no log já costuma
 * ser cronológica, mas `agent.log` + `.1`/`.2`/`.3` concatenados por leitura
 * de múltiplos arquivos não garantem isso sozinhos. */
export function buildTickSidecar(
  sessionId: string,
  events: readonly ToolCallEvent[],
  capturedAtIso: string,
): TickSidecar {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  return {
    sessionId,
    firstAt: sorted[0]?.at ?? "",
    lastAt: sorted[sorted.length - 1]?.at ?? "",
    toolCallCount: sorted.length,
    toolCalls: sorted.map(({ at, tool, outcome, durationS, sizeChars }) => ({
      at,
      tool,
      outcome,
      durationS,
      sizeChars,
    })),
    capturedAt: capturedAtIso,
  };
}

/** Sessão "encerrada" = última chamada de ferramenta vista há mais de
 * `minIdleMinutes` em relação a `nowIso`. Comparação puramente por string
 * ISO (`Date.parse`) — ambos os lados são UTC. Idade negativa (relógio
 * adiantado, ou `at` no futuro por corrupção de linha) NUNCA conta como
 * "encerrada" — mesmo guard de clock-skew usado em `session-registry.ts`. */
export function isSessionClosed(lastAt: string, nowIso: string, minIdleMinutes: number): boolean {
  const lastMs = Date.parse(lastAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) return false;
  const idleMinutes = (nowMs - lastMs) / 60_000;
  return idleMinutes >= minIdleMinutes;
}

/** Decide quais sessões (dentre as encontradas no log) merecem captura
 * agora: encerradas (ver `isSessionClosed`) E ainda não capturadas
 * (`alreadyCaptured`, tipicamente os nomes de arquivo já presentes em
 * `data/continuo/tick-sidecars/`). Captura é IDEMPOTENTE por design — uma
 * sessão já capturada nunca é reprocessada, mesmo que a linha ainda apareça
 * no log na próxima rodada (evita reescrever um sidecar que já existe e,
 * mais importante, nunca sobrescreve um sidecar de tick ainda em andamento
 * com um "quase completo" seguido depois por um completo diferente — a
 * primeira captura só acontece após `isSessionClosed`). */
export function selectSessionsToCapture(
  sessionsWithEvents: ReadonlyMap<string, ToolCallEvent[]>,
  alreadyCaptured: ReadonlySet<string>,
  nowIso: string,
  minIdleMinutes: number,
): string[] {
  const ready: string[] = [];
  for (const [sessionId, events] of sessionsWithEvents) {
    if (alreadyCaptured.has(sessionId)) continue;
    const lastAt = events.reduce((max, e) => (e.at > max ? e.at : max), events[0]?.at ?? "");
    if (lastAt && isSessionClosed(lastAt, nowIso, minIdleMinutes)) {
      ready.push(sessionId);
    }
  }
  return ready;
}

/** Sidecars mais velhos que `maxAgeDays` (por `capturedAt`, não por
 * `lastAt` — a retenção é sobre "há quanto tempo temos essa cópia", não
 * sobre o tick original) — prontos pra remoção. Puro: recebe a lista já
 * lida do disco, devolve só os nomes a apagar. */
export function selectSidecarsToPrune(
  sidecars: ReadonlyArray<{ readonly name: string; readonly capturedAt: string }>,
  nowIso: string,
  maxAgeDays: number,
): string[] {
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return [];
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return sidecars
    .filter((s) => {
      const capturedMs = Date.parse(s.capturedAt);
      if (Number.isNaN(capturedMs)) return false; // indeterminado nunca vira "apagar"
      return nowMs - capturedMs > maxAgeMs;
    })
    .map((s) => s.name);
}

/** Nome de arquivo determinístico pro sidecar de uma sessão — 1 sessão = 1
 * arquivo, sem caracteres que precisem de escaping (bracket já é
 * `[a-z0-9_]+` por construção do Hermes). */
export function sidecarFileName(sessionId: string): string {
  return `${sessionId}.json`;
}
