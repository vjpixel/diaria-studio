/**
 * scripts/lib/kit-subscriber-state-transition-alarm.ts (#7660)
 *
 * Lógica PURA (sem I/O) do alarme de transição de estado de assinantes Kit.
 * Compara snapshot anterior vs atual; dispara apenas na transição
 * active → {complained,bounced,cancelled,inactive}.
 */

import type { KitSubscriberSummary } from "./kit-subscribers.ts";

/** Estados de destino que contam como transição de perda (decisão do
 *  editor, #7660 — ver docstring do módulo). `bounced` INCLUÍDO por
 *  default mais seguro. */
export const KIT_STATE_TRANSITION_ALARM_STATES: readonly string[] = [
  "complained",
  "bounced",
  "cancelled",
  "inactive",
];

/** Estado de origem — só assinantes que ESTAVAM `active` no snapshot
 *  anterior contam. */
export const KIT_STATE_TRANSITION_FROM_STATE = "active";

/** Chave estável de finding pro `alarm-issues.ts` — 1 issue por assinante,
 *  não 1 por transição (mesmo padrão de `kitDoiOrphanFindingKey`). Só o id
 *  entra — nunca o estado/destino (varia, quebraria a idempotência). */
export const KIT_STATE_TRANSITION_FINDING_KEY_PREFIX = "kit-subscriber-state-transition";

export function kitStateTransitionFindingKey(subscriberId: number): string {
  return `${KIT_STATE_TRANSITION_FINDING_KEY_PREFIX}:${subscriberId}`;
}

export interface KitStateTransition {
  id: number;
  address: string;
  fromState: string;
  toState: string;
  /** ISO do snapshot em que a transição foi detectada (= `now` do caller). */
  detectedAt: string;
  /** `apoio_nivel` custom field, quando preenchido — sinal de que é um
   *  apoiador real, não cadastro de teste. */
  apoioNivel?: string;
  /** Último `sent`/`opened`/`clicked` conhecido, quando o caller passar —
   *  ajuda o editor a priorizar. */
  engagement?: { sent: number; opened: number; clicked: number };
}

export interface KitStateTransitionSnapshotEntry {
  id: number;
  state: string;
}

/**
 * Pura — detecta transições de estado entre `previous` (snapshot do dia
 * anterior) e `current` (snapshot de hoje). Só conta quando o assinante
 * estava `active` no snapshot anterior e está em um dos estados de alarme
 * (`KIT_STATE_TRANSITION_ALARM_STATES`) no atual. Assinantes novos
 * (sem entry no `previous`) NÃO contam — não há transição detectável; o
 * cadastro novo é assunto do DOI orphan guard (#6810), não deste alarme.
 */
export function detectKitStateTransitions(
  previous: readonly KitStateTransitionSnapshotEntry[],
  current: readonly KitSubscriberSummary[],
  now: Date,
  alarmStates: readonly string[] = KIT_STATE_TRANSITION_ALARM_STATES,
): KitStateTransition[] {
  const prev = new Map(previous.map((p) => [p.id, p.state] as const));
  const transitions: KitStateTransition[] = [];
  for (const s of current) {
    const fromState = prev.get(s.id);
    if (fromState === undefined) continue;
    if (fromState !== KIT_STATE_TRANSITION_FROM_STATE) continue;
    if (!alarmStates.includes(s.state)) continue;
    transitions.push({
      id: s.id,
      address: s.email_address,
      fromState,
      toState: s.state,
      detectedAt: now.toISOString(),
      apoioNivel: s.fields?.apoio_nivel,
    });
  }
  return transitions;
}

/** Pura — converte cada transição em um `AlarmFinding` do `alarm-issues.ts`.
 *  `family: "evento"` (fato histórico, não auto-resolve) — o assinante
 *  continua naquele estado até o editor agir manualmente (ex: re-registro
 *  via DOI pra `complained`), então a issue NUNCA fecha sozinha. */
export function toStateTransitionAlarmFindings(
  transitions: readonly KitStateTransition[],
): import("./alarm-issues.ts").AlarmFinding[] {
  return transitions.map((t) => {
    const isApoiador = Boolean(t.apoioNivel);
    const title = isApoiador
      ? `[diar.ia.br] Kit: apoiador ${t.address} (id ${t.id}) virou ${t.toState} a partir de ${t.fromState}`
      : `[diar.ia.br] Kit: assinante ${t.address} (id ${t.id}) virou ${t.toState} a partir de ${t.fromState}`;
    const body = [
      "Achado automático do alarme `Diaria-Kit-Subscriber-State-Transition-Alarm`",
      "(`scripts/kit-subscriber-state-transition-alarm.ts`).",
      "",
      `Assinante ${t.address} (id ${t.id}) mudou de estado no Kit:`,
      `  ${t.fromState} → ${t.toState}`,
      `  detectado em ${t.detectedAt}`,
      "",
      isApoiador
        ? "Custom field `apoio_nivel` preenchido (" + t.apoioNivel + ") — é um apoiador real, não cadastro de teste."
        : "Sem custom field `apoio_nivel` preenchido.",
      "",
      "Recuperação (#7660): o Kit NÃO reativa `complained`/`bounced` por API —",
      "é preciso re-registrar o assinante via form de DOI",
      "(`platform.config.json` → `kit.doiFormId`, hoje 9839463). Verificar o",
      "painel do Kit antes de decidir; `cancelled` e `inactive` têm caminhos",
      "diferentes (re-inscrição / reativação manual).",
      "",
      "Esta issue é `alarm-evento` — fato histórico, NUNCA fecha sozinha.",
      "Só um humano fecha após ação concreta.",
    ].join("\n");
    return {
      check: KIT_STATE_TRANSITION_FINDING_KEY_PREFIX,
      fingerprint: kitStateTransitionFindingKey(t.id),
      family: "evento",
      title,
      body,
      labels: ["bug"],
      priority: "P1",
    };
  });
}

// ─── Idempotência do e-mail (latch por assinante) ──────────────────────────

export interface KitStateTransitionAlarmState {
  /** `Set` de ids já alertados (transição ativa e e-mail enviado). */
  alertedSubscriberIds: number[];
  /** ISO — só pra REPORTAR, não participa da decisão. */
  lastCheckedAt: string | null;
}

export function emptyKitStateTransitionAlarmState(): KitStateTransitionAlarmState {
  return { alertedSubscriberIds: [], lastCheckedAt: null };
}

/** Pura — `true` quando a transição é NOVA (assinante ainda não foi
 *  alertado). Re-arma quando o assinante volta a `active` e transitiona
 *  novamente (o `advance` limpa o id do `alertedSubscriberIds`). */
export function shouldAlarmKitStateTransition(
  state: KitStateTransitionAlarmState,
  transitions: readonly KitStateTransition[],
): boolean {
  return transitions.some((t) => !state.alertedSubscriberIds.includes(t.id));
}

/** Pura — avança o latch: marca os ids alertados e limpa os que voltaram
 *  a `active` (re-arma pra uma próxima transição). */
export function advanceKitStateTransitionAlarmState(
  state: KitStateTransitionAlarmState,
  transitions: readonly KitStateTransition[],
  activeSubscriberIds: readonly number[],
  now: Date,
): KitStateTransitionAlarmState {
  const stillAlerted = state.alertedSubscriberIds.filter(
    (id) => !activeSubscriberIds.includes(id),
  );
  const newlyAlerted = transitions.map((t) => t.id);
  const alerted = Array.from(new Set([...stillAlerted, ...newlyAlerted])).sort(
    (a, b) => a - b,
  );
  return { alertedSubscriberIds: alerted, lastCheckedAt: now.toISOString() };
}
