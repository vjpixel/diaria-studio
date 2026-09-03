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
 * ─── Decisão do editor (03/09/2026, registrada na issue #7362) ─────────────
 *
 * "Armar alarme em 900 e decidir na hora." Não subir de degrau
 * preventivamente nem capar o teste — as duas alternativas foram recusadas
 * explicitamente (comprometeria caixa/orçamento antes da hora, ou tiraria um
 * braço do teste pago do ranking de custo).
 *
 * `DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD` é essa decisão, como constante —
 * mesmo padrão de `DEFAULT_EFFORT` (hook de review) e `MONTHLY_BUDGET_FLOOR_BRL`
 * (`cac.ts`): decisão provisória do editor, reverter/recalibrar é trocar esta
 * constante (uma linha), não reescrever o mecanismo. **Threshold ABSOLUTO,
 * não relativo ao `subscriber_limit` lido** — a decisão foi "em 900", não
 * "a 100 do teto"; se o plano subir de degrau (`subscriber_limit` mudar), o
 * editor decide se recalibra esta constante, o alarme não recalibra sozinho.
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

/** Decisão do editor, #7362, 03/09/2026 — ver docstring do módulo. */
export const DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD = 900;

export interface KitSubscriberLimitEvaluation {
  activeCount: number;
  subscriberLimit: number;
  threshold: number;
  /** `true` quando `activeCount >= threshold`. */
  triggered: boolean;
  /** `subscriberLimit - activeCount` — pode ser negativo se o teto já foi
   *  ultrapassado (o Kit pode ter bloqueado cadastro OU já ter cobrado o
   *  degrau seguinte — ver "Não verificado" na issue #7362, nenhuma das
   *  duas saídas é assumida aqui). */
  remainingToLimit: number;
}

/**
 * Pura — avalia o teto de assinantes contra o threshold de alarme.
 * `activeCount`/`subscriberLimit` vêm do caller (I/O real: `getKitAccount` +
 * `listAllKitSubscribers(config, {status: "active"})`).
 */
export function evaluateKitSubscriberLimitAlarm(
  activeCount: number,
  subscriberLimit: number,
  threshold: number = DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD,
): KitSubscriberLimitEvaluation {
  return {
    activeCount,
    subscriberLimit,
    threshold,
    triggered: activeCount >= threshold,
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
  const { activeCount, subscriberLimit, threshold, remainingToLimit } = evaluation;
  const subject = `[diar.ia.br] Kit: ${activeCount} assinantes ativos cruzou o alarme de ${threshold} (teto do plano: ${subscriberLimit})`;

  const lines: string[] = [
    "O guard `Diaria-Kit-Subscriber-Limit-Alarm` "
      + "(`scripts/kit-subscriber-limit-alarm.ts`) detectou que a contagem de "
      + `assinantes ATIVOS do Kit (${activeCount}) cruzou o limiar de alarme`,
    `(${threshold}) — teto real do plano hoje: ${subscriberLimit} (\`subscriber_limit\`, ` +
      `GET /v4/account). Margem restante até o teto: ${remainingToLimit}.`,
    "",
    "Decisão do editor (#7362, 03/09/2026): armar alarme em 900 e decidir na hora",
    "— não subir de degrau preventivamente nem capar o teste. Duas saídas",
    "possíveis quando o Kit estoura o teto (não confirmado qual delas ele",
    "aplica): bloquear novo cadastro, ou saltar de degrau de cobrança",
    "sozinho. Verificar o painel do Kit (Account & Billing) antes de decidir.",
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
