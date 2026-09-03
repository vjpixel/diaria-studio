/**
 * scripts/lib/kit-subscriber-limit-alarm.ts (#7362)
 *
 * Lógica PURA (sem I/O) do alarme de teto de assinantes do plano Kit —
 * mesmo molde de `scripts/lib/kit-doi-orphan-guard.ts` (decisão pura testável
 * + fingerprint/idempotência do alarme, separados do I/O que mora em
 * `scripts/kit-subscriber-limit-alarm.ts`).
 *
 * ─── Contexto (#7362) ───────────────────────────────────────────────────────
 *
 * O plano do Kit tem teto de assinantes (`subscriber_limit`, hoje 1000 no
 * plano "creator") e nenhum script do repo lia esse campo até esta unidade —
 * o teto era invisível pra maquinaria de guard/alarme. Medido ao vivo em
 * 03/09/2026 (Kit MCP): `subscriber_limit 1000`, `active 629`. Pela
 * aritmética do protocolo de mídia paga em curso (~750 cadastros esperados
 * na janela do teste), o teto seria cruzado por volta da metade da janela.
 *
 * ─── Decisão do editor (03/09/2026, registrada na issue #7362) — REVISADA ──
 *
 * Versão original (manhã de 03/09): "Armar alarme em 900 e decidir na hora"
 * — implementada pela #7368 como `DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD =
 * 900`, um limiar ABSOLUTO. **Essa decisão mudou no mesmo dia**: o editor
 * trocou o plano do Kit de "creator" (`subscriber_limit` 1000) para "free"
 * (`subscriber_limit` 10000, efetivo em 07/09/2026) — e um limiar absoluto de
 * 900 vira 9% de ocupação no plano novo, disparando muito cedo e sendo
 * ignorado (issue reaberta às 23:27Z do mesmo dia com esse achado).
 *
 * Correção (comentário de 18:55Z, aplicada aqui): o limiar é **PERCENTUAL
 * sobre o `subscriber_limit` lido da API**, não um número absoluto —
 * atravessa qualquer virada de plano sem precisar recalibrar código.
 * `DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD_PCT = 0.85` (85%, sugestão
 * explícita do comentário que reabriu a issue) é essa decisão, como
 * constante — mesmo padrão de `DEFAULT_EFFORT` (hook de review) e
 * `MONTHLY_BUDGET_FLOOR_BRL` (`cac.ts`): decisão provisória do editor,
 * recalibrar é trocar esta constante (uma linha), não reescrever o
 * mecanismo.
 *
 * ─── Idempotência: mesmo padrão dos demais alarmes locais (#4320/.../#6810) ─
 *
 * Latch simples (não fingerprint de conjunto, como o #6810 — aqui é um único
 * booleano de estado, não uma lista de itens): cruzar o threshold arma o
 * alarme (1 e-mail); permanecer acima não re-alarma a cada execução (a task
 * roda de 4 em 4h — mesmo racional de "estado", não "evento", de
 * `AlarmFinding.family` no `alarm-issues.ts`); cair de volta abaixo do
 * threshold re-arma pra um próximo cruzamento.
 */

/** Decisão do editor, #7362, comentário de 03/09/2026 18:55Z — ver docstring
 *  do módulo. Percentual de ocupação do `subscriber_limit`, não contagem
 *  absoluta — sobrevive a qualquer virada de plano (creator→free em 07/09,
 *  ou qualquer degrau futuro) sem precisar tocar em código. */
export const DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD_PCT = 0.85;

export interface KitSubscriberLimitEvaluation {
  activeCount: number;
  subscriberLimit: number;
  /** Fração 0-1 (ex: 0.85 = 85%) — nunca uma contagem absoluta. */
  thresholdPct: number;
  /** `activeCount / subscriberLimit` — 0 quando `subscriberLimit <= 0`
   *  (teto desconhecido, tratado como sem ocupação em vez de `NaN`/`Infinity`). */
  occupancyPct: number;
  /** `true` quando `occupancyPct >= thresholdPct` e `subscriberLimit > 0`
   *  (teto desconhecido nunca dispara — não há contra o que comparar). */
  triggered: boolean;
  /** `subscriberLimit - activeCount` — pode ser negativo se o teto já foi
   *  ultrapassado (o Kit pode ter bloqueado cadastro OU já ter cobrado o
   *  degrau seguinte — ver "Não verificado" na issue #7362, nenhuma das
   *  duas saídas é assumida aqui). */
  remainingToLimit: number;
}

/**
 * Pura — avalia o teto de assinantes contra o threshold PERCENTUAL de
 * alarme. `activeCount`/`subscriberLimit` vêm do caller (I/O real:
 * `getKitAccount` + `listAllKitSubscribers(config, {status: "active"})`).
 */
export function evaluateKitSubscriberLimitAlarm(
  activeCount: number,
  subscriberLimit: number,
  thresholdPct: number = DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD_PCT,
): KitSubscriberLimitEvaluation {
  const occupancyPct = subscriberLimit > 0 ? activeCount / subscriberLimit : 0;
  return {
    activeCount,
    subscriberLimit,
    thresholdPct,
    occupancyPct,
    triggered: subscriberLimit > 0 && occupancyPct >= thresholdPct,
    remainingToLimit: subscriberLimit - activeCount,
  };
}

// ─── Idempotência do alarme (latch) ─────────────────────────────────────────

export interface KitSubscriberLimitAlarmState {
  /** `true` enquanto o último e-mail de alarme enviado ainda não foi
   *  "resolvido" por uma leitura que caiu de volta abaixo do threshold. */
  alarmed: boolean;
  /** ISO — só pra REPORTAR, não participa da decisão. */
  lastCheckedAt: string | null;
}

export function emptyKitSubscriberLimitAlarmState(): KitSubscriberLimitAlarmState {
  return { alarmed: false, lastCheckedAt: null };
}

/** Pura — `true` só na TRANSIÇÃO pra acima do threshold (latch), nunca a
 *  cada execução em que `triggered` permanece `true`. */
export function shouldAlarmKitSubscriberLimit(
  state: KitSubscriberLimitAlarmState,
  evaluation: KitSubscriberLimitEvaluation,
): boolean {
  return evaluation.triggered && !state.alarmed;
}

/** Pura — avança o latch: arma quando `triggered`, re-arma (limpa) quando a
 *  leitura mais recente caiu de volta abaixo do threshold. */
export function advanceKitSubscriberLimitAlarmState(
  state: KitSubscriberLimitAlarmState,
  evaluation: KitSubscriberLimitEvaluation,
  now: Date,
): KitSubscriberLimitAlarmState {
  return { alarmed: evaluation.triggered, lastCheckedAt: now.toISOString() };
}

/** Chave estável de finding pro `alarm-issues.ts` — 1 issue "estado" só
 *  (não 1 por assinante, ao contrário do #6810: aqui o achado É o teto
 *  cruzado, não uma lista de itens individuais). Constante independente de
 *  `threshold`/contagem — muda de contagem não deve abrir uma 2ª issue
 *  enquanto a primeira segue aberta e sem resolução. */
export const KIT_SUBSCRIBER_LIMIT_FINDING_KEY = "kit-subscriber-limit-alarm";

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

export function buildKitSubscriberLimitAlarmEmail(
  evaluation: KitSubscriberLimitEvaluation,
  now: Date = new Date(),
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const { activeCount, subscriberLimit, thresholdPct, occupancyPct, remainingToLimit } = evaluation;
  const thresholdDisplay = `${Math.round(thresholdPct * 100)}%`;
  const occupancyDisplay = `${Math.round(occupancyPct * 100)}%`;
  const subject = `[diar.ia.br] Kit: ${activeCount} assinantes ativos (${occupancyDisplay}) cruzou o alarme de ${thresholdDisplay} do teto do plano (${subscriberLimit})`;

  const lines: string[] = [
    "O guard `Diaria-Kit-Subscriber-Limit-Alarm` "
      + "(`scripts/kit-subscriber-limit-alarm.ts`) detectou que a contagem de "
      + `assinantes ATIVOS do Kit (${activeCount}) cruzou o limiar de alarme`,
    `(${thresholdDisplay} de ocupação) — teto real do plano hoje: ${subscriberLimit} ` +
      `(\`subscriber_limit\`, GET /v4/account). Ocupação atual: ${occupancyDisplay}. ` +
      `Margem restante até o teto: ${remainingToLimit}.`,
    "",
    "Decisão do editor (#7362, comentário de 03/09/2026 18:55Z): limiar PERCENTUAL",
    `sobre o subscriber_limit lido da API (${thresholdDisplay}), não uma contagem`,
    "absoluta — atravessa virada de plano sem recalibrar código. Não subir de",
    "degrau preventivamente nem capar o teste. Duas saídas possíveis quando o",
    "Kit estoura o teto (não confirmado qual delas ele aplica): bloquear novo",
    "cadastro, ou saltar de degrau de cobrança sozinho. Verificar o painel do",
    "Kit (Account & Billing) antes de decidir.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  ];

  if (issueRef) {
    lines.splice(
      2,
      0,
      "",
      issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`,
    );
  }

  return { subject, body: lines.join("\n") };
}
