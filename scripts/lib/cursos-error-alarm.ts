/**
 * cursos-error-alarm.ts (#4320, REDESENHADO no #4382)
 *
 * Lógica PURA (sem I/O) do alarme de erro do worker `cursos` — segue o MESMO
 * molde de `scripts/lib/clarice-guardrail-alarm.ts` (#4064): consulta em
 * cadência, avalia contra limiares, envia e-mail via Gmail API quando
 * dispara, idempotente (nunca reavalia o mesmo intervalo duas vezes).
 *
 * ─── #4382: por que este módulo mudou de "eventos de log" pra "contadores" ──
 *
 * A versão original (#4320) consultava a Cloudflare GraphQL Analytics API
 * (dataset `workersInvocationsAdaptiveGroups`) e fazia grep de texto nas
 * mensagens de log retornadas. Isso foi CONFIRMADO AO VIVO (com credenciais
 * Cloudflare reais, #4382) como quebrado — o campo `workersInvocationsAdaptiveGroups`
 * não existe no schema exposto a esta conta, mesmo numa query mínima sem a
 * sub-seleção `logs{}`. Não é permissão (a mensagem de erro do Cloudflare é
 * "unknown field", não "not authorized"/"forbidden") — o dataset não existe
 * pra leitura de conteúdo de log via essa API pública. Ela parece expor só
 * métricas AGREGADAS (contagem de requests, erros por status, CPU time).
 *
 * O redesign: o worker `cursos` agora incrementa 4 contadores CUMULATIVOS
 * direto no KV `CURSOS_SUBSCRIBERS` nos mesmos pontos onde já loga (ver
 * `scripts/lib/shared/cursos-alarm-counters.ts` pras chaves + o helper de
 * incremento, fail-soft, chamado de `workers/cursos/src/index.ts` e
 * `subscribe.ts`). Este módulo pura passa a operar sobre um DELTA de
 * contadores (cumulativo atual − cumulativo da última checagem), não mais
 * sobre uma lista de eventos com timestamp.
 *
 * Duas condições de alarme (inalteradas em espírito, só a fonte de dado mudou):
 *
 * 1. FATAL (qualquer ocorrência, ou seja, delta > 0) — os dois contadores que
 *    espelham as linhas de log que indicam falha dura:
 *      - `fatalCookieHmacSecretAusente` ("COOKIE_HMAC_SECRET ausente" —
 *        index.ts × 2 call sites + subscribe.ts).
 *      - `fatalCadastroBeehiivFalhou` ("cadastro na Beehiiv falhou" —
 *        subscribe.ts, só quando a Beehiiv respondeu não-ok; não conta
 *        `not_configured`/secrets ausentes, que é o outro contador acima).
 *
 * 2. TAXA de `?email= não confirmado como assinante ativo` (delta de
 *    `emailGateNotConfirmed` / (delta de `emailGateNotConfirmed` + delta de
 *    `emailGateConfirmed`)) — sinal de saúde do caminho A (link com merge tag
 *    na newsletter). Taxa baixa é normal; 100% é merge tag quebrada ou o gate
 *    morto de novo. `verificação Beehiiv falhou` (outcome "verification_failed")
 *    fica DE FORA de ambos os contadores de propósito (#4321 — não deve se
 *    misturar com a taxa de negativo confirmado).
 *
 *    Amostra mínima (`DEFAULT_NOT_CONFIRMED_MIN_SAMPLE`): mesma lição do poll
 *    "É IA?" (memory `eia-poll-volume-insuficiente-para-medir`) — uma janela
 *    com poucos hits não vira sinal, `ratePct` fica `null`.
 *
 * ─── Idempotência: cursor de CONTADORES, não de tempo ──────────────────────
 *
 * Diferente da versão original (cursor `lastCheckedUntil`, janela de tempo
 * `[since, until)` consultada na Analytics API), agora não há "janela"
 * consultável — só um valor cumulativo lido AGORA. A idempotência vem de
 * guardar o snapshot cumulativo da última checagem (`lastCounters`) e
 * calcular o delta contra o snapshot ATUAL — cada execução só "vê" o que foi
 * incrementado desde a última leitura bem-sucedida, nunca reprocessa o mesmo
 * incremento 2x (mesmo espírito do cursor de tempo: avança só em sucesso).
 *
 * 1ª execução (sem `lastCounters` — `state.lastCounters === null`): NÃO tenta
 * inferir um delta "desde sempre" a partir de 0 (o total cumulativo pode
 * conter meses de histórico anterior a este alarme existir — 1 fatal antigo
 * não pode dar um falso-alarme retroativo no dia em que o alarme liga). A 1ª
 * execução só ESTABELECE o baseline (delta sempre 0) — a próxima já mede de
 * verdade. Troca deliberada frente à versão original (que usava
 * `INITIAL_LOOKBACK_MS` de 24h na 1ª execução): sem "janela" no design de
 * contador, não há como saber a IDADE do valor cumulativo herdado, então
 * conservador aqui significa nunca alarmar sobre histórico desconhecido.
 */

// ─── Padrões de log fatal (mantidos só pro nome/documentação — a DETECÇÃO
// agora é por contador, não por grep de texto) ──────────────────────────────

export const FATAL_LOG_PATTERNS = [
  "COOKIE_HMAC_SECRET ausente",
  "cadastro na Beehiiv falhou",
] as const;

export type FatalLogPattern = (typeof FATAL_LOG_PATTERNS)[number];

/** Default do limiar de alarme da taxa — tunável via `--rate-threshold-pct`/env, decisão operacional (não é limiar medido, ver docstring do módulo). */
export const DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT = 90;
/** Amostra mínima antes de calcular `ratePct` — abaixo disso, `null` (nunca alarma em N pequeno). */
export const DEFAULT_NOT_CONFIRMED_MIN_SAMPLE = 5;

// ─── Snapshot de contadores (lido do KV pelo caller de I/O) ────────────────

export interface CursosCounterSnapshot {
  fatalCookieHmacSecretAusente: number;
  fatalCadastroBeehiivFalhou: number;
  emailGateConfirmed: number;
  emailGateNotConfirmed: number;
}

export function emptyCounterSnapshot(): CursosCounterSnapshot {
  return {
    fatalCookieHmacSecretAusente: 0,
    fatalCadastroBeehiivFalhou: 0,
    emailGateConfirmed: 0,
    emailGateNotConfirmed: 0,
  };
}

// ─── Estado + idempotência (cursor de CONTADORES) ──────────────────────────

export interface CursosAlarmState {
  /** Snapshot cumulativo da última checagem BEM-SUCEDIDA, ou `null` na 1ª execução. */
  lastCounters: CursosCounterSnapshot | null;
  /** ISO 8601 da última checagem — só pra REPORTAR no e-mail ("desde X"); não
   * participa da idempotência (o cursor real é `lastCounters`). `null` na 1ª execução. */
  lastCheckedAt: string | null;
}

export function emptyCursosAlarmState(): CursosAlarmState {
  return { lastCounters: null, lastCheckedAt: null };
}

/** Pura: avança o cursor pro snapshot recém-lido + o instante desta checagem. */
export function advanceState(current: CursosCounterSnapshot, now: Date): CursosAlarmState {
  return { lastCounters: current, lastCheckedAt: now.toISOString() };
}

// ─── Delta ──────────────────────────────────────────────────────────────────

export interface CounterDelta {
  fatalCookieHmacSecretAusente: number;
  fatalCadastroBeehiivFalhou: number;
  emailGateConfirmed: number;
  emailGateNotConfirmed: number;
  /** `true` quando QUALQUER contador atual é MENOR que o da última checagem —
   * sinal de reset externo do KV (namespace recriado, chave apagada manualmente
   * etc. — os contadores em si só somam, nunca decrementam sozinhos). O delta
   * daquele contador específico é clampado a 0 (nunca negativo) — não
   * interrompe a avaliação dos demais, só é reportado no e-mail se disparar
   * junto de alguma condição real. */
  resetDetected: boolean;
}

/**
 * Pura: calcula o delta (incrementos desde a última checagem) a partir do
 * state + snapshot atual. 1ª execução (`state.lastCounters === null`) sempre
 * retorna delta zerado (ver docstring do módulo — nunca alarma
 * retroativamente sobre histórico de idade desconhecida).
 */
export function computeCounterDelta(state: CursosAlarmState, current: CursosCounterSnapshot): CounterDelta {
  if (state.lastCounters === null) {
    return { fatalCookieHmacSecretAusente: 0, fatalCadastroBeehiivFalhou: 0, emailGateConfirmed: 0, emailGateNotConfirmed: 0, resetDetected: false };
  }
  const prev = state.lastCounters;
  let resetDetected = false;
  const d = (currN: number, prevN: number): number => {
    if (currN < prevN) {
      resetDetected = true;
      return 0;
    }
    return currN - prevN;
  };
  return {
    fatalCookieHmacSecretAusente: d(current.fatalCookieHmacSecretAusente, prev.fatalCookieHmacSecretAusente),
    fatalCadastroBeehiivFalhou: d(current.fatalCadastroBeehiivFalhou, prev.fatalCadastroBeehiivFalhou),
    emailGateConfirmed: d(current.emailGateConfirmed, prev.emailGateConfirmed),
    emailGateNotConfirmed: d(current.emailGateNotConfirmed, prev.emailGateNotConfirmed),
    resetDetected,
  };
}

// ─── FATAL: qualquer ocorrência (delta > 0) ────────────────────────────────

export interface FatalMatch {
  pattern: FatalLogPattern;
  /** Quantas vezes o contador incrementou nesta janela (delta). */
  count: number;
}

/** Pura: os contadores fatais com delta > 0 nesta janela. */
export function detectFatalMatches(delta: CounterDelta): FatalMatch[] {
  const matches: FatalMatch[] = [];
  if (delta.fatalCookieHmacSecretAusente > 0) {
    matches.push({ pattern: "COOKIE_HMAC_SECRET ausente", count: delta.fatalCookieHmacSecretAusente });
  }
  if (delta.fatalCadastroBeehiivFalhou > 0) {
    matches.push({ pattern: "cadastro na Beehiiv falhou", count: delta.fatalCadastroBeehiivFalhou });
  }
  return matches;
}

// ─── Taxa de "?email= não confirmado" ──────────────────────────────────────

export interface NotConfirmedRateResult {
  confirmed: number;
  notConfirmed: number;
  total: number;
  /** `null` quando `total < minSample` — amostra insuficiente pra medir (nunca alarma). */
  ratePct: number | null;
}

/**
 * Pura: extrai confirmado × não-confirmado do delta e calcula a taxa de
 * não-confirmado. `verificação Beehiiv falhou` (verification_failed) já vem
 * DE FORA de ambos os contadores desde a origem no worker (#4321) — nunca
 * incrementa nenhum dos dois.
 */
export function computeNotConfirmedRate(
  delta: CounterDelta,
  minSample: number = DEFAULT_NOT_CONFIRMED_MIN_SAMPLE,
): NotConfirmedRateResult {
  const confirmed = delta.emailGateConfirmed;
  const notConfirmed = delta.emailGateNotConfirmed;
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
  delta: CounterDelta;
  /** ISO 8601 da checagem anterior, ou `null` na 1ª execução (sem baseline pra comparar). */
  since: string | null;
  /** ISO 8601 desta checagem. */
  until: string;
}

/** Pura: consolida os dois sinais (fatal + taxa) numa única avaliação, pra 1 e-mail por run. */
export function evaluateCursosCounters(
  state: CursosAlarmState,
  current: CursosCounterSnapshot,
  now: Date,
  opts: CursosAlarmOptions = {},
): CursosAlarmEvaluation {
  const rateThresholdPct = opts.rateThresholdPct ?? DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT;
  const delta = computeCounterDelta(state, current);
  const fatalMatches = detectFatalMatches(delta);
  const rate = computeNotConfirmedRate(delta, opts.minSample);
  const rateBreached = isRateBreached(rate, rateThresholdPct);
  return {
    fatalMatches,
    rate,
    rateBreached,
    rateThresholdPct,
    delta,
    since: state.lastCheckedAt,
    until: now.toISOString(),
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
    parts.push("Erro(s) FATAL (qualquer ocorrência dispara):");
    for (const m of evaluation.fatalMatches) {
      parts.push(`- "${m.pattern}" — ${m.count}x na janela`);
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

  if (evaluation.delta.resetDetected) {
    parts.push(
      "",
      "AVISO: pelo menos um contador no KV apareceu MENOR que na checagem anterior (reset externo — namespace recriado/chave " +
        "apagada manualmente?). O delta desse contador foi tratado como 0 nesta janela — pode estar SUBESTIMADO.",
    );
  }

  const subject = `[diar.ia.br] Worker cursos: ${subjectBits.join(" + ")}`;
  const windowLabel = evaluation.since ? `${evaluation.since} → ${evaluation.until}` : `1ª checagem → ${evaluation.until} (sem baseline anterior)`;
  const header = [`Alarme do worker \`cursos\` — janela avaliada: ${windowLabel}.`, ""];
  const footer = [
    "",
    "Ação: `wrangler tail` (workers/cursos) ou o dashboard Cloudflare Workers Logs do worker `cursos` pra investigar ao vivo. " +
      "Ver docs/cursos-worker-alarm-setup.md pro runbook completo.",
    "",
    "(alarme automático — #4320/#4382)",
  ];
  return { subject, body: [...header, ...parts, ...footer].join("\n") };
}
