/**
 * onboarding-followup-panel.ts (#10606)
 *
 * Visão PURA pro painel `/assinantes` do Studio: quantas pessoas receberam
 * cada e-mail do onboarding (e-mails 1/2/3 da escada + cada etapa das
 * sequências de apoio e formulário, #10604/#10605) e, por pessoa, quantos
 * pedidos de apoio e de formulário ela recebeu — tudo contado do store
 * (`data/onboarding/store.json`), sem consultar o ESP.
 *
 * "Recebeu" = enviado/agendado confirmado pelo nosso registro (lote Kit
 * relido `scheduled`/`completed`, `email{1,2}_sent_at` gravado, campanha
 * Brevo do e-mail 3 criada AGENDADA — `email3_scheduled_at`, #10603; a
 * rascunho anterior fica em pendentes). Entrega/abertura real no ESP é outra métrica
 * (fora do escopo inicial da issue).
 *
 * E-mail sempre MASCARADO (`a***@dominio`), nunca cru. Entrada/lote de
 * piloto (`pilot:*`, `onboarding-pilot-*`) nunca entra na contagem.
 */

import type { OnboardingEntry, OnboardingStore } from "./onboarding-store.ts";
import type { OnboardingKitLot } from "./onboarding-kit-transport.ts";
import {
  APOIO_STEPS,
  FORM_STEPS,
  isApoioStep,
  isFormStep,
  kitIdForEntry,
  normalizeEmail,
  type FollowupLot,
  type FollowupRunRecord,
  type FollowupStepKind,
} from "./onboarding-followup.ts";

const PILOT_SUBSCRIPTION_PREFIX = "pilot:";
const PILOT_TAG_PREFIX = "onboarding-pilot-";

/** `a***@dominio` — mesmo padrão de `maskEmail` (beehiiv-kit-reconcile.ts). */
export function maskEmail(email: string): string {
  const e = String(email ?? "");
  const at = e.indexOf("@");
  if (at <= 0) return e.length > 0 ? `${e[0]}***` : "***";
  return `${e[0]}***${e.slice(at)}`;
}

export type OnboardingEmailStep = "email1" | "email2" | "email3" | FollowupStepKind;

export const STEP_LABELS: Record<OnboardingEmailStep, string> = {
  email1: "E-mail 1 (D0, boas-vindas)",
  email2: "E-mail 2 (D+3)",
  email3: "E-mail 3 (D+10, pedido de apoio)",
  apoio30: "Apoio D+30",
  apoio90: "Apoio D+90",
  apoio180: "Apoio D+180",
  apoio360: "Apoio D+360",
  form: "Formulário (D+6)",
  form_lembrete: "Lembrete do formulário (a cada 30 dias)",
};

export interface EmailStepCount {
  step: OnboardingEmailStep;
  label: string;
  recebidos: number;
  porTransporte: { kit: number; brevo: number };
  /** Terminais (não vão receber esta etapa), por motivo. */
  pulados: Record<string, number>;
  /** Ainda podem receber (devidos que não saíram, ou etapa não vencida), por motivo. */
  pendentes: Record<string, number>;
  /** Destinatários de lote que falhou (cancelado/não agendado) sem envio registrado. */
  falhos: number;
  /** Para as sequências de apoio/formulário: os motivos de pendência/pulo
   *  que vêm da ÚLTIMA rodada (`followup.last_run.counts`), não acumulados. */
  daUltimaRodada: boolean;
}

export interface PersonRow {
  /** Chave estável da linha (id Kit, ou `subscription_id` legado). */
  key: string;
  emailMasked: string;
  cadastroAt: string | null;
  apoioRecebidos: number;
  formRecebidos: number;
  preencheu: boolean;
  /** `null` = sem dado (nunca checado e sem índice de apoiadores). */
  apoia: boolean | null;
}

/** Tipo do alerta (#10606, fleet review da PR #10651): o painel roteia a
 *  ação e o dedupe por este discriminante, nunca pelo texto de `etapa`. */
export type PanelAlertKind =
  /** Rodadas `--send` seguidas com falha no transporte Kit (e-mails 1/2/3). */
  | "kit_streak"
  /** Rodadas seguidas com falha no e-mail 3 via Brevo. */
  | "email3_brevo_streak"
  /** Rodadas seguidas com falha nas sequências de apoio/formulário. */
  | "followup_streak"
  /** Lote com broadcast não agendado e não apagado (`schedule_failed`). */
  | "lot_schedule_failed";

export interface PanelAlert {
  kind: PanelAlertKind;
  /** Etapa do lote — só em `lot_schedule_failed`. */
  step?: OnboardingEmailStep;
  etapa: string;
  mensagem: string;
}

export interface FollowupPanelView {
  steps: EmailStepCount[];
  people: PersonRow[];
  alerts: PanelAlert[];
  blocked: { apoio: FollowupRunRecord["apoio_blocked"]; form: FollowupRunRecord["form_blocked"] };
  lastRunAt: string | null;
}

function emptyCount(step: OnboardingEmailStep, daUltimaRodada = false): EmailStepCount {
  return { step, label: STEP_LABELS[step], recebidos: 0, porTransporte: { kit: 0, brevo: 0 }, pulados: {}, pendentes: {}, falhos: 0, daUltimaRodada };
}

function bump(rec: Record<string, number>, k: string, n = 1): void {
  rec[k] = (rec[k] ?? 0) + n;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function isPilotLot(lot: { tag_name?: string; recipient_subscription_ids?: readonly string[] }): boolean {
  return (lot.tag_name ?? "").startsWith(PILOT_TAG_PREFIX) || (lot.recipient_subscription_ids ?? []).some((id) => String(id).startsWith(PILOT_SUBSCRIPTION_PREFIX));
}

function failedLot(lot: { status: string; schedule_failed?: boolean }): boolean {
  return lot.status === "cancelled" || lot.schedule_failed === true;
}

/** Destinatários de lotes FALHOS de uma etapa da escada que não têm envio. */
function ladderFailedIds(lots: readonly OnboardingKitLot[], kind: "email1" | "email2" | "email3"): Set<string> {
  const ids = new Set<string>();
  for (const lot of lots) if (lot.kind === kind && failedLot(lot) && lot.last_error) for (const id of lot.recipient_subscription_ids) ids.add(id);
  return ids;
}

function email3Received(entry: OnboardingEntry, lotsById: ReadonlyMap<string, OnboardingKitLot>): "kit" | "brevo" | null {
  if (entry.email3_state !== "campaign_created") return null;
  if (entry.email3_kit_lot_id) {
    const lot = lotsById.get(entry.email3_kit_lot_id);
    return lot && (lot.status === "scheduled" || lot.status === "completed") ? "kit" : null;
  }
  // Brevo: só conta com `email3_scheduled_at` (campanha criada AGENDADA, #10603).
  // Antes do #10603 a campanha era RASCUNHO — `campaign_created` sozinho não
  // prova envio (review #10623).
  return entry.email3_campaign_id != null && entry.email3_scheduled_at != null && ISO_RE.test(entry.email3_scheduled_at) ? "brevo" : null;
}

/**
 * @pure — monta a visão do painel. `apoiaByEmail` (opcional) responde "apoia?"
 * pelo índice de apoiadores do Studio quando a pessoa nunca foi checada no Kit
 * pelo executor das sequências.
 */
export function buildFollowupPanel(
  store: Pick<OnboardingStore, "entries" | "kit_transport" | "followup" | "consecutive_email3_failures" | "last_email3_error">,
  opts: { apoiaByEmail?: (email: string) => boolean | null } = {},
): FollowupPanelView {
  const entries = Object.values(store.entries).filter((e) => !e.subscription_id.startsWith(PILOT_SUBSCRIPTION_PREFIX));
  const kitLots = Object.values(store.kit_transport?.lots ?? {}).filter((l) => !isPilotLot(l));
  const lotsById = new Map(kitLots.map((l) => [l.lot_id, l] as const));
  const followup = store.followup ?? { people: {}, lots: {} };
  const lastRun = followup.last_run ?? null;

  // --- Escada (e-mails 1/2/3) ---
  const c1 = emptyCount("email1");
  const c2 = emptyCount("email2");
  const c3 = emptyCount("email3");
  const failed1 = ladderFailedIds(kitLots, "email1");
  const failed2 = ladderFailedIds(kitLots, "email2");
  const failed3 = ladderFailedIds(kitLots, "email3");
  for (const e of entries) {
    const t1 = e.email1_transport ?? (e.email1_kit_lot_id ? "kit" : "brevo");
    if (e.email1_sent_at != null && ISO_RE.test(e.email1_sent_at)) {
      c1.recebidos++;
      c1.porTransporte[t1]++;
    } else if (failed1.has(e.subscription_id)) c1.falhos++;
    else if (e.status_detectado !== "active") bump(c1.pendentes, "aguardando_confirmacao");
    else bump(c1.pendentes, "na_fila");

    if (e.email2_sent_at != null) {
      if (ISO_RE.test(e.email2_sent_at)) {
        c2.recebidos++;
        c2.porTransporte[e.email2_kit_lot_id ? "kit" : t1]++;
      } else bump(c2.pulados, String(e.email2_sent_at).slice(0, 60));
    } else if (failed2.has(e.subscription_id)) c2.falhos++;
    else if (e.email1_sent_at != null) bump(c2.pendentes, "d3_nao_venceu_ou_na_fila");

    const r3 = email3Received(e, lotsById);
    if (r3) {
      c3.recebidos++;
      c3.porTransporte[r3]++;
    } else if (e.email3_state === "pending") {
      if (failed3.has(e.subscription_id)) c3.falhos++;
      else bump(c3.pendentes, "d10_nao_venceu_ou_na_fila");
    } else if (e.email3_state === "campaign_created") {
      bump(c3.pendentes, e.email3_kit_lot_id ? "lote_kit_nao_confirmado" : "rascunho_brevo_sem_envio_confirmado");
    }
    else bump(c3.pulados, e.email3_state);
  }

  // --- Sequências de apoio/formulário (#10604/#10605) ---
  const people = followup.people ?? {};
  const fLots = Object.values(followup.lots ?? {}) as FollowupLot[];
  const followupSteps = [...APOIO_STEPS.map((s) => s.kind), ...FORM_STEPS.map((s) => s.kind)];
  const followupCounts = new Map<FollowupStepKind, EmailStepCount>(followupSteps.map((k) => [k, emptyCount(k, true)] as const));
  for (const p of Object.values(people)) {
    for (const s of p.sends ?? []) {
      const c = followupCounts.get(s.step);
      if (!c) continue;
      c.recebidos++;
      c.porTransporte.kit++;
    }
    for (const s of p.skips ?? []) {
      const c = followupCounts.get(s.step);
      if (c) bump(c.pulados, s.motivo);
    }
  }
  for (const lot of fLots) {
    const c = followupCounts.get(lot.kind);
    if (!c || !failedLot(lot) || !lot.last_error) continue;
    c.falhos += lot.recipient_subscription_ids.filter((id) => !(people[id]?.sends ?? []).some((s) => s.step === lot.kind)).length;
  }
  const TERMINAL_RUN_MOTIVOS = new Set(["vencida", "nao_ativo"]);
  for (const [kind, byMotivo] of Object.entries(lastRun?.counts ?? {}) as [FollowupStepKind, Record<string, number>][]) {
    const c = followupCounts.get(kind);
    if (!c) continue;
    for (const [motivo, n] of Object.entries(byMotivo)) {
      // `enviado`/`falhou` já contados pelos registros; `apoia` vem dos pulos gravados.
      // `excede_janela` (#10652) é projeção sobre quem já está em `adiado_teto` —
      // somar dobraria a contagem; aparece como alerta.
      if (motivo === "enviado" || motivo === "falhou" || motivo === "apoia" || motivo === "excede_janela") continue;
      bump(TERMINAL_RUN_MOTIVOS.has(motivo) ? c.pulados : c.pendentes, motivo, n);
    }
  }

  // --- Por pessoa ---
  const rows = new Map<string, PersonRow>();
  const apoiaOf = (email: string, checked: boolean | null | undefined): boolean | null =>
    checked ?? opts.apoiaByEmail?.(normalizeEmail(email)) ?? null;
  for (const e of entries) {
    const kitId = kitIdForEntry(e);
    const key = kitId != null ? String(kitId) : e.subscription_id;
    const cadastro = e.created_at != null ? new Date(e.created_at * 1000).toISOString() : e.detected_at ?? null;
    rows.set(key, {
      key,
      emailMasked: maskEmail(e.email),
      cadastroAt: cadastro,
      apoioRecebidos: email3Received(e, lotsById) ? 1 : 0,
      formRecebidos: 0,
      preencheu: false,
      apoia: apoiaOf(e.email, undefined),
    });
  }
  for (const [key, p] of Object.entries(people)) {
    const row = rows.get(key) ?? {
      key,
      emailMasked: maskEmail(p.email),
      cadastroAt: p.cadastro_at ?? null,
      apoioRecebidos: 0,
      formRecebidos: 0,
      preencheu: false,
      apoia: null,
    };
    row.apoioRecebidos += (p.sends ?? []).filter((s) => isApoioStep(s.step)).length;
    row.formRecebidos += (p.sends ?? []).filter((s) => isFormStep(s.step)).length;
    row.preencheu = Boolean(p.form_filled_at);
    row.apoia = apoiaOf(p.email, p.apoia);
    if (row.cadastroAt == null) row.cadastroAt = p.cadastro_at ?? null;
    rows.set(key, row);
  }
  const peopleRows = [...rows.values()].sort(
    (a, b) => Number(a.apoia === true) - Number(b.apoia === true) || b.apoioRecebidos - a.apoioRecebidos || (b.cadastroAt ?? "").localeCompare(a.cadastroAt ?? ""),
  );

  // --- Falha visível no topo ---
  const alerts: PanelAlert[] = [];
  const kitFails = store.kit_transport?.consecutive_failed_send_runs ?? 0;
  if (kitFails >= 2) alerts.push({ kind: "kit_streak", etapa: "E-mails 1/2/3 (transporte Kit)", mensagem: `${kitFails} rodadas --send seguidas com falha` });
  const e3Fails = store.consecutive_email3_failures ?? 0;
  if (e3Fails >= 2) {
    alerts.push({ kind: "email3_brevo_streak", etapa: "E-mail 3 (Brevo)", mensagem: `${e3Fails} rodadas seguidas com falha${store.last_email3_error ? `: ${maskInText(store.last_email3_error)}` : ""}` });
  }
  const fFails = followup.consecutive_failed_runs ?? 0;
  if (fFails >= 2) {
    alerts.push({ kind: "followup_streak", etapa: "Sequências de apoio/formulário", mensagem: `${fFails} rodadas seguidas com falha${lastRun?.error ? `: ${maskInText(lastRun.error)}` : ""}` });
  }
  // #10652: excedente do teto que não cabe na janela — aparece já na 1ª rodada,
  // sem esperar o contador de rodadas falhas.
  if ((lastRun?.cap_window_overflow ?? 0) > 0) {
    const perda = Object.entries(lastRun?.counts ?? {})
      .filter(([, c]) => (c?.excede_janela ?? 0) > 0)
      .map(([k, c]) => `${STEP_LABELS[k as OnboardingEmailStep] ?? k}: ${c!.excede_janela}`)
      .join(", ");
    alerts.push({
      etapa: "Sequências de apoio/formulário",
      mensagem: `excedente do teto de lote não cabe na janela — ao menos ${perda} vão vencer sem receber (subir max_recipients_per_lot ou grace_days)`,
    });
  }
  for (const lot of [...kitLots, ...fLots]) {
    if (lot.schedule_failed === true && lot.status !== "cancelled") {
      const step = lot.kind in STEP_LABELS ? (lot.kind as OnboardingEmailStep) : undefined;
      alerts.push({ kind: "lot_schedule_failed", step, etapa: step ? STEP_LABELS[step] : lot.kind, mensagem: `lote ${lot.lot_id}: broadcast não agendado e não apagado (${maskInText(lot.last_error ?? "sem detalhe")})` });
    }
  }

  return {
    steps: [c1, c2, c3, ...followupSteps.map((k) => followupCounts.get(k)!)],
    people: peopleRows,
    alerts,
    blocked: { apoio: lastRun?.apoio_blocked ?? null, form: lastRun?.form_blocked ?? null },
    lastRunAt: lastRun?.at ?? null,
  };
}

/** Mascara qualquer e-mail dentro de um texto livre (erro de lote etc.). */
export function maskInText(text: string): string {
  return String(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m));
}
