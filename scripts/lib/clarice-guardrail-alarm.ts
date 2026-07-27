/**
 * clarice-guardrail-alarm.ts (#4064)
 *
 * Lógica PURA (sem I/O) do alarme de guardrail furado do ramp Clarice — a
 * PARTE 1 da issue #4064 (só alarme, notificação por e-mail; a trava no
 * pré-flight do agendamento fica pra depois, decisão explícita do editor).
 *
 * Caso concreto que motivou a issue (#4061): o braço B do experimento CTA-01
 * fechou o envio 8 com 11,1% de abertura (limiar: 15%) e o envio 9B saiu no
 * dia seguinte mesmo assim (2,0% de abertura) — o sinal existia, estava
 * medido, mas nada notificava o editor a tempo de suspender o envio seguinte
 * (campanha agendada na Brevo é IMUTÁVEL — não deleta/desagenda via API
 * depois de "scheduled").
 *
 * Decisão do editor (260727): job roda ~6h após CADA envio (`GUARDRAIL_EVAL_WINDOW_MS`
 * — abertura já estabilizou, ~18h de folga antes do envio seguinte, que sai
 * 06:00 BRT no dia seguinte). Reusa `evaluateArmGuardrails`/`thresholds.ts`
 * (workers/brevo-dashboard/src/experiment-cta.ts) SEM reimplementar limiar —
 * `armMetricsFromCampaign` só adapta o shape de UMA campanha (não um
 * experimento A/B) pro formato `ArmMetrics` que essa função já espera.
 */
import {
  evaluateArmGuardrails,
  type ArmMetrics,
  type ArmGuardrailResult,
} from "../../workers/brevo-dashboard/src/experiment-cta.ts";
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from "../../workers/brevo-dashboard/src/thresholds.ts";

/** Janela de espera pós-envio antes de avaliar guardrails (decisão do editor, 260727). */
export const GUARDRAIL_EVAL_WINDOW_MS = 6 * 60 * 60 * 1000;

// ─── Adapter: 1 campanha → ArmMetrics (reuso de evaluateArmGuardrails) ──────

export interface CampaignGuardrailInput {
  id: number | string;
  name: string;
  /** ISO. */
  sentDate: string;
  sent: number;
  delivered: number;
  uniqueViews: number;
  unsubscriptions: number;
  complaints: number;
  hardBounces: number;
  softBounces: number;
}

/**
 * Adapta os stats de UMA campanha (não um braço de experimento A/B) pro shape
 * `ArmMetrics` — `evaluateArmGuardrails` só usa `sent/delivered/uniqueViews/
 * unsubscriptions/complaints/hardBounces/softBounces`; `decisionClicks`/
 * `uniqueClicks` são irrelevantes pra guardrail (ficam 0), e `armId`/`label`
 * viram identificadores da campanha em si.
 */
export function armMetricsFromCampaign(input: CampaignGuardrailInput): ArmMetrics {
  return {
    armId: String(input.id),
    label: input.name,
    campaignCount: 1,
    sent: input.sent,
    delivered: input.delivered,
    uniqueViews: input.uniqueViews,
    uniqueClicks: 0,
    decisionClicks: 0,
    unsubscriptions: input.unsubscriptions,
    complaints: input.complaints,
    hardBounces: input.hardBounces,
    softBounces: input.softBounces,
  };
}

/** Avalia os guardrails de UMA campanha — mesmos limiares do doc, via `evaluateArmGuardrails`/`thresholds.ts`. */
export function evaluateSendGuardrails(
  input: CampaignGuardrailInput,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): ArmGuardrailResult {
  return evaluateArmGuardrails(armMetricsFromCampaign(input), thresholds);
}

// ─── Janela de avaliação + idempotência ─────────────────────────────────────

/** `true` quando `now - sentDate >= windowMs` (default: 6h, decisão do editor). */
export function isReadyForEvaluation(
  sentDateIso: string,
  now: Date,
  windowMs: number = GUARDRAIL_EVAL_WINDOW_MS,
): boolean {
  const sentMs = Date.parse(sentDateIso);
  if (!Number.isFinite(sentMs)) return false;
  return now.getTime() - sentMs >= windowMs;
}

export interface GuardrailAlarmState {
  /** IDs (como string) de campanhas já avaliadas — nunca reavaliar/realarmar a mesma campanha 2x. */
  evaluated: string[];
}

export function emptyGuardrailAlarmState(): GuardrailAlarmState {
  return { evaluated: [] };
}

/**
 * Filtra, dentre as campanhas ENVIADAS, quais estão prontas pra avaliação
 * (cruzaram a janela de 6h) E ainda não foram avaliadas (idempotência — sem
 * isso, cada execução do job re-alarmaria a mesma campanha indefinidamente).
 */
export function pickCampaignsPendingEvaluation<T extends { id: number | string; sentDate: string }>(
  sentCampaigns: T[],
  state: GuardrailAlarmState,
  now: Date,
  windowMs: number = GUARDRAIL_EVAL_WINDOW_MS,
): T[] {
  const evaluatedSet = new Set(state.evaluated.map(String));
  return sentCampaigns.filter(
    (c) => !evaluatedSet.has(String(c.id)) && isReadyForEvaluation(c.sentDate, now, windowMs),
  );
}

/** Marca uma campanha como avaliada (idempotente — não duplica se já presente). */
export function markEvaluated(state: GuardrailAlarmState, campaignId: number | string): GuardrailAlarmState {
  const id = String(campaignId);
  if (state.evaluated.includes(id)) return state;
  return { evaluated: [...state.evaluated, id] };
}

// ─── Próximo envio agendado (nomear + prazo de suspensão) ───────────────────

export interface ScheduledSendInfo {
  name: string;
  /** ISO. */
  scheduledAt: string;
}

/**
 * Encontra o próximo envio agendado (o mais próximo no FUTURO, relativo a
 * `now`) entre campanhas `queued` — é o que o alarme precisa nomear, já que
 * campanha agendada na Brevo é imutável (suspender é ação manual, com prazo).
 * `null` se não houver nenhum agendamento futuro.
 */
export function resolveNextScheduledSend<T extends { name: string; scheduledAt: string | null }>(
  scheduled: T[],
  now: Date,
): ScheduledSendInfo | null {
  const future = scheduled
    .filter((c): c is T & { scheduledAt: string } => {
      if (!c.scheduledAt) return false;
      const ms = Date.parse(c.scheduledAt);
      return Number.isFinite(ms) && ms > now.getTime();
    })
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const next = future[0];
  return next ? { name: next.name, scheduledAt: next.scheduledAt } : null;
}

// ─── E-mail de alarme ────────────────────────────────────────────────────────

/** Descreve, em texto, quais métricas romperam o breaker — usa os mesmos rótulos/limiares do doc, sem reimplementar limiar. */
export function describeBreaches(
  guardrail: ArmGuardrailResult,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): string[] {
  const out: string[] = [];
  if (guardrail.openBreach) {
    out.push(`Abertura ${guardrail.openRatePct.toFixed(1)}% (limite: ≥${thresholds.openRate.yellow}%)`);
  }
  if (guardrail.bounceBreach) {
    out.push(
      `Bounce — hard ${guardrail.hardBounceRatePct.toFixed(2)}% (limite: <${thresholds.hardBounceRate.yellow}%) / total ${guardrail.bounceRatePct.toFixed(2)}% (limite: <${thresholds.bounceRate.yellow}%)`,
    );
  }
  if (guardrail.unsubBreach) {
    out.push(`Unsub ${guardrail.unsubRatePct.toFixed(2)}% (limite: <${thresholds.unsubRate.yellow}%)`);
  }
  if (guardrail.spamBreach) {
    out.push(`Spam (Brevo/complaints) ${guardrail.spamRatePct.toFixed(3)}% (limite: <${thresholds.spamRate.yellow}%)`);
  }
  return out;
}

/**
 * Monta o e-mail de alarme (pura/testável). Precisa SEMPRE: (a) nomear qual
 * é o próximo envio agendado e (b) até quando dá pra suspender — requisito
 * explícito da decisão do editor, já que a suspensão é ação manual e a
 * campanha agendada na Brevo é imutável via API.
 */
export function buildGuardrailAlarmEmail(
  campaignName: string,
  guardrail: ArmGuardrailResult,
  nextScheduled: ScheduledSendInfo | null,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): { subject: string; body: string } {
  const breaches = describeBreaches(guardrail, thresholds);
  const subject = `[Diar.ia] Guardrail furado no envio "${campaignName}"`;
  const lines = [
    `O envio "${campaignName}" fechou com guardrail furado, avaliado ~6h após o disparo:`,
    "",
    ...breaches.map((b) => `- ${b}`),
    "",
  ];
  if (nextScheduled) {
    lines.push(
      `Próximo envio agendado: "${nextScheduled.name}", para ${nextScheduled.scheduledAt}.`,
      "Campanha agendada na Brevo é IMUTÁVEL (não deleta/desagenda via API depois de \"scheduled\") — " +
        `se decidir não seguir com ele, suspenda MANUALMENTE no painel Brevo antes de ${nextScheduled.scheduledAt}.`,
    );
  } else {
    lines.push(
      "Nenhum próximo envio agendado encontrado no momento (nada a suspender agora, mas reavalie antes do próximo agendamento).",
    );
  }
  lines.push("", `(alarme automático — avaliação rodou em ${now.toISOString()})`);
  return { subject, body: lines.join("\n") };
}
