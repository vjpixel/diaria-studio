/**
 * cursos-error-alarm.ts (#4320)
 *
 * Lógica PURA (sem I/O) do alarme de erro do worker `cursos` — segue o MESMO
 * molde de `scripts/lib/clarice-guardrail-alarm.ts` (#4064): consulta em
 * cadência, avalia contra limiares, envia e-mail via Gmail API quando
 * dispara, idempotente por CURSOR de tempo (nunca reavalia a mesma janela
 * duas vezes).
 *
 * Contexto (#4320, extraído da #4305/PR #4306): o worker `cursos` loga todo
 * caminho de degradação (`console.error`/`console.warn`) e
 * `[observability] enabled = true` no `wrangler.toml` faz o Cloudflare
 * coletar — mas coletar não é avisar. Sem este alarme, o único caminho de
 * descoberta é um leitor reclamar.
 *
 * Duas condições de alarme:
 *
 * 1. FATAL (qualquer ocorrência) — as duas linhas de log que indicam falha
 *    dura, independente de volume:
 *      - "COOKIE_HMAC_SECRET ausente" (index.ts + subscribe.ts — sem o
 *        secret, ninguém consegue desbloquear/cadastrar).
 *      - "cadastro na Beehiiv falhou" (subscribe.ts — Beehiiv rejeitou o
 *        cadastro inline, nenhum assinante novo criado).
 *
 * 2. TAXA de `?email= não confirmado como assinante ativo` (index.ts) —
 *    sinal de saúde do caminho A (link com merge tag na newsletter). Taxa
 *    baixa é normal (parte de quem clica não é assinante ativo — link
 *    velho, ex-assinante, editado à mão); 100% é merge tag quebrada ou o
 *    gate morto de novo (mesmo raciocínio do comentário #4321 em
 *    `index.ts`, que já antecipa este alarme).
 *
 *    O log original só emite uma linha no caminho de FALHA (`não
 *    confirmado`) — o caminho de SUCESSO (`outcome.status === "active"`)
 *    não logava nada, então não havia denominador pra calcular uma taxa de
 *    verdade (só o numerador). Este PR adiciona
 *    `EMAIL_GATE_CONFIRMED_MESSAGE` no branch de sucesso de `handleIndex`
 *    (workers/cursos/src/index.ts) — instrumentação mínima, mesmo padrão
 *    "todo caminho loga" do #4306, necessária pra essa taxa significar
 *    algo. `verificação Beehiiv falhou` (rede/401/403/429/5xx — outcome
 *    "verification_failed") fica DE FORA do denominador de propósito — o
 *    comentário #4321 em index.ts já é explícito que esse sinal (Beehiiv
 *    fora do ar) não deve se misturar com a taxa de negativo confirmado
 *    "nem no alarme nem no dashboard de logs".
 *
 *    Amostra mínima (`DEFAULT_NOT_CONFIRMED_MIN_SAMPLE`): mesma lição do
 *    poll "É IA?" (memory `eia-poll-volume-insuficiente-para-medir` — ~8
 *    votos/edição não medem nada) — uma janela com poucos hits não vira
 *    sinal, `ratePct` fica `null` (nunca um alarme baseado em N pequeno).
 */

// ─── Padrões de log fatal (qualquer ocorrência) ─────────────────────────────

export const FATAL_LOG_PATTERNS = [
  "COOKIE_HMAC_SECRET ausente",
  "cadastro na Beehiiv falhou",
] as const;

export type FatalLogPattern = (typeof FATAL_LOG_PATTERNS)[number];

// ─── Mensagens do sinal de taxa (path A — `?email=` da newsletter) ─────────

/** Emitida no branch de SUCESSO de `handleIndex` (workers/cursos/src/index.ts). */
export const EMAIL_GATE_CONFIRMED_MESSAGE = "[cursos] ?email= confirmado como assinante ativo — desbloqueado";
/** Já existia antes do #4320 (branch de falha `outcome.reason !== "verification_failed"`). */
export const EMAIL_GATE_NOT_CONFIRMED_MESSAGE = "[cursos] ?email= não confirmado como assinante ativo — servindo teaser";

/** Default do limiar de alarme da taxa — tunável via `--rate-threshold-pct`/env, decisão operacional (não é limiar medido, ver docstring do módulo). */
export const DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT = 90;
/** Amostra mínima antes de calcular `ratePct` — abaixo disso, `null` (nunca alarma em N pequeno). */
export const DEFAULT_NOT_CONFIRMED_MIN_SAMPLE = 5;

export interface CursosLogEvent {
  /** ISO 8601. */
  timestamp: string;
  message: string;
}

export interface FatalMatch {
  pattern: FatalLogPattern;
  timestamp: string;
  message: string;
}

/** Pura: varre os eventos e retorna todo match de um padrão fatal (qualquer ocorrência). */
export function detectFatalMatches(events: CursosLogEvent[]): FatalMatch[] {
  const matches: FatalMatch[] = [];
  for (const ev of events) {
    for (const pattern of FATAL_LOG_PATTERNS) {
      if (ev.message.includes(pattern)) {
        matches.push({ pattern, timestamp: ev.timestamp, message: ev.message });
      }
    }
  }
  return matches;
}

export interface NotConfirmedRateResult {
  confirmed: number;
  notConfirmed: number;
  total: number;
  /** `null` quando `total < minSample` — amostra insuficiente pra medir (nunca alarma). */
  ratePct: number | null;
}

/**
 * Pura: conta confirmado × não-confirmado dentre os eventos e calcula a taxa
 * de não-confirmado. `verificação Beehiiv falhou` (verification_failed) NÃO
 * conta pra nenhum dos dois lados — ver docstring do módulo (#4321).
 */
export function computeNotConfirmedRate(
  events: CursosLogEvent[],
  minSample: number = DEFAULT_NOT_CONFIRMED_MIN_SAMPLE,
): NotConfirmedRateResult {
  let confirmed = 0;
  let notConfirmed = 0;
  for (const ev of events) {
    if (ev.message.includes(EMAIL_GATE_CONFIRMED_MESSAGE)) confirmed++;
    else if (ev.message.includes(EMAIL_GATE_NOT_CONFIRMED_MESSAGE)) notConfirmed++;
  }
  const total = confirmed + notConfirmed;
  // `total > 0` explícito (não só `total >= minSample`): um `minSample` de 0
  // (ou negativo, por engano) não pode fazer `ratePct` virar `0/0 = NaN` —
  // sem tentativa nenhuma na janela, a taxa é indefinida, nunca "0% de nada".
  const ratePct = total > 0 && total >= minSample ? (notConfirmed / total) * 100 : null;
  return { confirmed, notConfirmed, total, ratePct };
}

/** Pura: `true` quando `ratePct` existe (amostra suficiente) E cruza o limiar. */
export function isRateBreached(
  result: NotConfirmedRateResult,
  thresholdPct: number = DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT,
): boolean {
  return result.ratePct !== null && result.ratePct >= thresholdPct;
}

// ─── Janela + idempotência (cursor de tempo, não lista de IDs) ─────────────
//
// Diferente do guardrail Clarice (que idempotiza por ID de campanha — cada
// campanha é avaliada exatamente 1x), aqui não há um ID discreto por evento
// de log. O cursor `lastCheckedUntil` cumpre o mesmo papel: cada execução só
// consulta [lastCheckedUntil, now) — janelas nunca se sobrepõem, então nunca
// reavalia (e nunca realarma) o mesmo intervalo 2x. O cursor só avança
// quando a run termina com sucesso (main() só chama `advanceState` depois de
// qualquer e-mail de alarme ter sido enviado com sucesso) — uma falha de
// fetch OU de envio de e-mail deixa o cursor parado, e a MESMA janela (agora
// maior) é reprocessada na próxima execução. Mesmo padrão de
// `clarice-sync-brevo.ts --incremental` (`modifiedSince`).

export interface CursosAlarmState {
  /** ISO 8601, ou `null` na 1ª execução (sem histórico ainda). */
  lastCheckedUntil: string | null;
}

export function emptyCursosAlarmState(): CursosAlarmState {
  return { lastCheckedUntil: null };
}

/** Lookback da 1ª execução (sem state prévio) — 24h é generoso o bastante pra não perder um incidente recente sem re-processar dias de história. */
export const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface AlarmWindow {
  since: Date;
  until: Date;
}

/** Pura: resolve a janela [since, until) da próxima execução a partir do state + `now`. */
export function resolveWindow(state: CursosAlarmState, now: Date): AlarmWindow {
  const until = now;
  const since = state.lastCheckedUntil
    ? new Date(Date.parse(state.lastCheckedUntil))
    : new Date(now.getTime() - INITIAL_LOOKBACK_MS);
  return { since, until };
}

/** Pura: avança o cursor pro fim da janela recém-processada. */
export function advanceState(until: Date): CursosAlarmState {
  return { lastCheckedUntil: until.toISOString() };
}

// ─── Avaliação consolidada + e-mail ─────────────────────────────────────────

export interface CursosAlarmOptions {
  rateThresholdPct?: number;
  minSample?: number;
}

export interface CursosAlarmEvaluation {
  fatalMatches: FatalMatch[];
  rate: NotConfirmedRateResult;
  rateBreached: boolean;
  rateThresholdPct: number;
  eventCount: number;
  since: string;
  until: string;
}

/** Pura: consolida os dois sinais (fatal + taxa) numa única avaliação, pra 1 e-mail por run. */
export function evaluateCursosLogs(
  events: CursosLogEvent[],
  window: AlarmWindow,
  opts: CursosAlarmOptions = {},
): CursosAlarmEvaluation {
  const rateThresholdPct = opts.rateThresholdPct ?? DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT;
  const fatalMatches = detectFatalMatches(events);
  const rate = computeNotConfirmedRate(events, opts.minSample);
  const rateBreached = isRateBreached(rate, rateThresholdPct);
  return {
    fatalMatches,
    rate,
    rateBreached,
    rateThresholdPct,
    eventCount: events.length,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
  };
}

/** Pura: `true` quando QUALQUER condição de alarme disparou nesta avaliação. */
export function shouldAlarm(evaluation: CursosAlarmEvaluation): boolean {
  return evaluation.fatalMatches.length > 0 || evaluation.rateBreached;
}

/**
 * Monta o e-mail de alarme (pura/testável) — cobre as duas condições (podem
 * disparar juntas na mesma janela). Sempre nomeia a janela avaliada e a ação
 * esperada (checar `wrangler tail`/dashboard Workers Logs do worker `cursos`).
 */
export function buildCursosAlarmEmail(evaluation: CursosAlarmEvaluation): { subject: string; body: string } {
  const parts: string[] = [];
  const subjectBits: string[] = [];

  if (evaluation.fatalMatches.length > 0) {
    subjectBits.push(`${evaluation.fatalMatches.length} erro(s) fatal(is)`);
    const byPattern = new Map<string, number>();
    for (const m of evaluation.fatalMatches) {
      byPattern.set(m.pattern, (byPattern.get(m.pattern) ?? 0) + 1);
    }
    parts.push("Erro(s) FATAL (qualquer ocorrência dispara):");
    for (const [pattern, count] of byPattern) {
      parts.push(`- "${pattern}" — ${count}x na janela`);
    }
    const sample = evaluation.fatalMatches.slice(0, 3);
    parts.push("", "Amostra (até 3):");
    for (const m of sample) {
      parts.push(`  [${m.timestamp}] ${m.message}`);
    }
  }

  if (evaluation.rateBreached) {
    subjectBits.push(`taxa não-confirmado ${evaluation.rate.ratePct!.toFixed(1)}%`);
    parts.push(
      parts.length > 0 ? "" : "",
      `Taxa de "?email= não confirmado como assinante ativo": ${evaluation.rate.ratePct!.toFixed(1)}% ` +
        `(limite: ≥${evaluation.rateThresholdPct}%) — ${evaluation.rate.notConfirmed}/${evaluation.rate.total} tentativas na janela.`,
      "100% costuma ser merge tag quebrada na newsletter (Beehiiv mandando {{email}} cru) ou o gate morto de novo — " +
        "verificar `sync-cursos-subscribers-kv.ts` (KV desatualizado) e as secrets do worker `cursos` (BEEHIIV_API_KEY/PUBLICATION_ID).",
    );
  }

  const subject = `[Diar.ia] Worker cursos: ${subjectBits.join(" + ")}`;
  const header = [
    `Alarme do worker \`cursos\` — janela avaliada: ${evaluation.since} → ${evaluation.until} (${evaluation.eventCount} eventos de log).`,
    "",
  ];
  const footer = [
    "",
    "Ação: `wrangler tail` (workers/cursos) ou o dashboard Cloudflare Workers Logs do worker `cursos` pra investigar ao vivo. " +
      "Ver docs/cursos-worker-alarm-setup.md pro runbook completo.",
    "",
    "(alarme automático — #4320)",
  ];
  return { subject, body: [...header, ...parts, ...footer].join("\n") };
}
