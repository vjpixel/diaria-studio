/**
 * scripts/lib/continuo-session-registration-check.ts (#7890)
 *
 * Verificação EXTERNA de que `session-registry.ts register --kind continuo`
 * de fato rodou cedo o suficiente num tick. Hoje esse registro é um passo em
 * PROSA no SKILL.md do contínuo (`hermes/skills/hermes-diaria-continuo/
 * SKILL.md`, "Cada ciclo" passo 1.3) — depende do modelo executá-lo. Se o
 * tick falhar cedo (ex: falha de credencial logo no início), o registro
 * nunca acontece e nada de fora percebe: foi exatamente isso que causou uma
 * correlação errada do detector de fabricação de conclusão (#7537) no caso
 * do #7641 — `latest_continuo_session` (`detect-tick-claim-fabrication.py`)
 * não distingue "sem sessão nenhuma" de "sessão mais recente É de um tick
 * anterior, não deste", e escolheu a sessão errada em silêncio.
 *
 * ## Dois espaços de identificador, nunca confundir (achado do #7889)
 *
 * O sidecar de tick (`scripts/lib/continuo-tick-sidecar.ts`, #7814) guarda o
 * `session_id` do BRACKET do log do Hermes (`cron_{job}_{data}_{hora}`) —
 * identificador do TICK do Hermes. `session-registry.ts` grava um
 * `sessionId` (UUID do harness do Claude Code) em
 * `data/sessions/continuo-{machineTag}-{sessionId}.json`, com campos
 * `startedAt`/`lastHeartbeat`. Os dois NUNCA são comparáveis por valor — a
 * única correlação possível é por JANELA DE TEMPO: um tick que de fato
 * registrou sua sessão deveria ter uma entrada de `data/sessions/` cujo
 * `[startedAt, lastHeartbeat]` se sobrepõe ao `[firstAt, lastAt]` do sidecar
 * do tick (com folga — o registro acontece um pouco depois do início real
 * do tick, dentro do mesmo passo 1).
 *
 * ## O que este módulo faz (e não faz)
 *
 * `findUnregisteredTicks` recebe as janelas de tick (dos sidecars — só
 * ticks "encerrados" já têm sidecar, então não alarma sobre um tick ainda
 * em andamento) e as janelas de sessão `kind=continuo` já registradas, e
 * devolve os ticks SEM NENHUMA sessão cuja janela se sobreponha. Puro —
 * toda leitura de disco (sidecars, `data/sessions/`) fica no CLI
 * (`scripts/check-continuo-session-registration.ts`), que é quem decide
 * status/reason pro consumidor (`hermes/scripts/watch-continuo-health.sh`).
 *
 * Não corrige nada, não registra sessão retroativamente — só sinaliza o
 * gap explicitamente (item 2 da proposta da issue #7890), em vez de deixar
 * o detector de fabricação correlacionar errado em silêncio (o modo de
 * falha que causou o #7641).
 */

/** Janela de um tick, extraída de um sidecar já capturado (#7814). */
export interface TickWindow {
  /** `session_id` do bracket do log do Hermes — NUNCA o UUID do harness. */
  readonly sessionId: string;
  readonly firstAt: string;
  readonly lastAt: string;
}

/** Janela de uma sessão `kind=continuo` registrada via `session-registry.ts`. */
export interface RegisteredSessionWindow {
  /** `sessionId` (UUID) do registro — só para reportar, nunca comparado por valor com `TickWindow.sessionId`. */
  readonly sessionId: string;
  readonly startedAt: string;
  /** `null` quando a sessão nunca recebeu heartbeat — cai para `startedAt`. */
  readonly lastHeartbeat: string | null;
}

/** Tick é de 30min (protocolo do contínuo, mesmo valor usado em
 *  `continuo-tick-sidecar.ts` e no `SOFT_STALE_MS`/heartbeat de
 *  `session-registry.ts`). 15min de folga de cada lado cobre o atraso
 *  normal entre o início real do tick e o `register` (passo 1, item 1.3 —
 *  roda depois do sync/guard de colisão) sem ficar tão largo a ponto de
 *  casar com a sessão de um tick vizinho. */
export const DEFAULT_CORRELATION_BUFFER_MINUTES = 15;

/** Só ticks cujo `lastAt` caiu dentro desta janela contam pra checagem —
 *  evita reabrir alarme (ou reprocessar) sobre sidecars antigos que já
 *  passaram por um dia de varredura. 26h ecoa a mesma margem de frescor
 *  usada pela checagem 1 (review Opus diário) em `watch-continuo-health.sh`
 *  — o script roda 1x/dia, então "desde a última rodada" é ~24h + folga. */
export const DEFAULT_LOOKBACK_HOURS = 26;

function toMs(iso: string): number {
  return Date.parse(iso);
}

/** `true` quando `lastAt` cai dentro de `lookbackHours` a partir de `nowIso`.
 *  Timestamp corrompido/ilegível (`NaN`) NUNCA conta como "recente" — não
 *  inventa relevância pra dado que não consegue parsear. */
export function isWithinLookback(lastAt: string, nowIso: string, lookbackHours: number): boolean {
  const lastMs = toMs(lastAt);
  const nowMs = toMs(nowIso);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - lastMs;
  if (ageMs < 0) return false; // no futuro — clock skew, nunca "recente"
  return ageMs <= lookbackHours * 60 * 60 * 1000;
}

/** `true` quando a janela do tick (com folga de `bufferMinutes` de cada
 *  lado) se sobrepõe à janela da sessão. Qualquer timestamp ilegível faz a
 *  função devolver `false` — nunca afirma sobreposição sobre dado corrompido
 *  (o mesmo viés conservador de `isSessionClosed` em
 *  `continuo-tick-sidecar.ts`: incerteza nunca vira "está tudo bem"). */
export function windowsOverlap(
  tick: TickWindow,
  session: RegisteredSessionWindow,
  bufferMinutes: number = DEFAULT_CORRELATION_BUFFER_MINUTES,
): boolean {
  const tickFirstMs = toMs(tick.firstAt);
  const tickLastMs = toMs(tick.lastAt);
  const sessStartMs = toMs(session.startedAt);
  const sessEndMs = toMs(session.lastHeartbeat ?? session.startedAt);
  if (![tickFirstMs, tickLastMs, sessStartMs, sessEndMs].every(Number.isFinite)) return false;
  const bufferMs = bufferMinutes * 60 * 1000;
  const tickStart = tickFirstMs - bufferMs;
  const tickEnd = tickLastMs + bufferMs;
  // Sobreposição de intervalos [tickStart, tickEnd] x [sessStartMs, sessEndMs]
  // (sessão sem heartbeat vira um ponto — sessStartMs === sessEndMs — e a
  // checagem ainda funciona: um ponto "se sobrepõe" a um intervalo quando
  // cai dentro dele).
  return tickStart <= sessEndMs && sessStartMs <= tickEnd;
}

/**
 * Devolve os ticks (dentre `ticks`, restritos por `isWithinLookback`) sem
 * NENHUMA sessão `kind=continuo` cuja janela se sobreponha. Ordem de
 * entrada preservada.
 */
export function findUnregisteredTicks(
  ticks: readonly TickWindow[],
  sessions: readonly RegisteredSessionWindow[],
  nowIso: string,
  opts: { lookbackHours?: number; bufferMinutes?: number } = {},
): TickWindow[] {
  const lookbackHours = opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const bufferMinutes = opts.bufferMinutes ?? DEFAULT_CORRELATION_BUFFER_MINUTES;
  const recent = ticks.filter((t) => isWithinLookback(t.lastAt, nowIso, lookbackHours));
  return recent.filter((t) => !sessions.some((s) => windowsOverlap(t, s, bufferMinutes)));
}

export type SessionRegistrationStatus = "ok" | "alarm" | "indeterminate";

export interface SessionRegistrationCheckResult {
  readonly status: SessionRegistrationStatus;
  readonly reason: string;
  readonly checkedTickCount: number;
  readonly unregisteredTicks: readonly TickWindow[];
}

/**
 * Monta o veredito a partir de dados JÁ LIDOS (puro — nenhum I/O aqui; o CLI
 * decide como ler `data/continuo/tick-sidecars/` e `data/sessions/`, e o que
 * fazer quando um dos dois diretórios está ausente/ilegível).
 */
export function evaluateSessionRegistration(
  ticks: readonly TickWindow[],
  sessions: readonly RegisteredSessionWindow[],
  nowIso: string,
  opts: { lookbackHours?: number; bufferMinutes?: number } = {},
): SessionRegistrationCheckResult {
  const lookbackHours = opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const recentTicks = ticks.filter((t) => isWithinLookback(t.lastAt, nowIso, lookbackHours));
  if (recentTicks.length === 0) {
    return {
      status: "ok",
      reason: `nenhum sidecar de tick dentro da janela de ${lookbackHours}h — nada a correlacionar`,
      checkedTickCount: 0,
      unregisteredTicks: [],
    };
  }
  const unregistered = findUnregisteredTicks(ticks, sessions, nowIso, opts);
  if (unregistered.length === 0) {
    return {
      status: "ok",
      reason: `${recentTicks.length} tick(s) recente(s), todos com sessão continuo registrada na janela`,
      checkedTickCount: recentTicks.length,
      unregisteredTicks: [],
    };
  }
  return {
    status: "alarm",
    reason: `${unregistered.length} de ${recentTicks.length} tick(s) recente(s) sem sessão continuo registrada (session-registry.ts register --kind continuo não rodou, ou rodou fora da janela de correlação)`,
    checkedTickCount: recentTicks.length,
    unregisteredTicks: unregistered,
  };
}
