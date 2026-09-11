/**
 * scripts/lib/calibration-cadence-guard.ts (#7979, Camada 5 da #7972 — Fase 5)
 *
 * Guardrails de cadência do gatilho automático de calibração (Track B,
 * #7979), puro — recebe estado já lido pelo chamador
 * (`scripts/trigger-track-b-calibration.ts`), nunca lê disco/API. Os 3
 * tetos do design (#7972 §4):
 *
 * 1. **Teto de digest de sign-off**: no máximo 1 sessão combinada por
 *    semana — candidatos prontos entram num digest único em vez de abrir
 *    1 PR por candidato assim que cruza a barra.
 * 2. **Cooldown de novo candidato**: no máximo 1 candidato NOVO por
 *    semana — mesmo que vários passem a barra de evidência no mesmo dia,
 *    só 1 vira PR; o resto entra na fila ranqueada.
 * 3. **Orçamento de parâmetro calibrável**: teto fixo de 15 parâmetros
 *    calibráveis simultaneamente vivos — feature nova exige que uma
 *    feature existente de trivialidade comparável seja promovida a
 *    invariante congelado ou removida primeiro.
 *
 * Mitigação declarada de deslocamento de esforço (#7972 §4) — sem estes
 * 3 tetos, o mecanismo automático poderia gerar mais trabalho de revisão
 * pro editor do que o processo manual que substitui.
 */

export const MAX_LIVE_CALIBRATABLE_PARAMS = 15;
export const MAX_NEW_CANDIDATES_PER_WEEK = 1;
export const MAX_SIGNOFF_DIGESTS_PER_WEEK = 1;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CadenceState {
  /** Timestamps ISO de quando cada candidato NOVO foi aberto (1 entrada por PR de calibração aberta, não por feature passando a barra). */
  candidateOpenedAt: readonly string[];
  /** Timestamps ISO de quando cada digest de sign-off foi enviado ao editor. */
  digestSentAt: readonly string[];
  /** Contagem atual de parâmetros calibráveis vivos — CANDIDATE_FEATURES.length hoje; chamador deriva de calibration-power-report.ts. */
  liveCalibratableParamCount: number;
}

export interface CadenceDecision {
  canOpenNewCandidate: boolean;
  canSendSignoffDigest: boolean;
  atParamBudgetCap: boolean;
  /** Motivo textual de cada bloqueio ativo — vazio se nada bloqueado. */
  reasons: string[];
}

function countInLastWeek(timestamps: readonly string[], nowMs: number): number {
  return timestamps.filter((t) => {
    const ts = new Date(t).getTime();
    return !Number.isNaN(ts) && nowMs - ts < WEEK_MS && nowMs - ts >= 0;
  }).length;
}

/** Avalia os 3 guardrails contra o estado atual e o instante `nowIso`. Puro, determinístico — mesmo estado + mesmo `nowIso` sempre produz a mesma decisão. */
export function evaluateCadence(state: CadenceState, nowIso: string): CadenceDecision {
  const nowMs = new Date(nowIso).getTime();
  const reasons: string[] = [];

  const candidatesThisWeek = countInLastWeek(state.candidateOpenedAt, nowMs);
  const canOpenNewCandidate = candidatesThisWeek < MAX_NEW_CANDIDATES_PER_WEEK;
  if (!canOpenNewCandidate) {
    reasons.push(`cooldown de novo candidato: ${candidatesThisWeek}/${MAX_NEW_CANDIDATES_PER_WEEK} candidatos já abertos nos últimos 7 dias.`);
  }

  const digestsThisWeek = countInLastWeek(state.digestSentAt, nowMs);
  const canSendSignoffDigest = digestsThisWeek < MAX_SIGNOFF_DIGESTS_PER_WEEK;
  if (!canSendSignoffDigest) {
    reasons.push(`teto de digest de sign-off: ${digestsThisWeek}/${MAX_SIGNOFF_DIGESTS_PER_WEEK} digest(s) já enviado(s) nos últimos 7 dias.`);
  }

  const atParamBudgetCap = state.liveCalibratableParamCount >= MAX_LIVE_CALIBRATABLE_PARAMS;
  if (atParamBudgetCap) {
    reasons.push(`orçamento de parâmetro calibrável esgotado: ${state.liveCalibratableParamCount}/${MAX_LIVE_CALIBRATABLE_PARAMS} — promova um parâmetro existente a invariante congelado ou remova um antes de calibrar um novo.`);
  }

  return { canOpenNewCandidate, canSendSignoffDigest, atParamBudgetCap, reasons };
}

export interface QueuedCandidate {
  feature: string;
  /** |diff| de kept-rate entre presente/ausente — magnitude do efeito medido, ver calibration-power-report.ts. */
  effectSize: number;
  /** 1 - null_p_value — proxy de confiança estatística (0..1, maior = mais confiável). */
  confidence: number;
}

export interface RankedCandidate extends QueuedCandidate {
  /** effectSize × confidence — "tempo economizado × confiança" do design (#7979), usando magnitude do efeito como proxy de valor editorial já que o pipeline não mede tempo de revisão diretamente hoje. */
  value: number;
}

/** Ordena candidatos elegíveis (já passaram a barra de evidência) por `value` desc — maior valor primeiro na fila. Empate desempata por `feature` (ordem alfabética), pra ranking determinístico e reproduzível. */
export function rankQueuedCandidates(candidates: readonly QueuedCandidate[]): RankedCandidate[] {
  return candidates
    .map((c) => ({ ...c, value: c.effectSize * c.confidence }))
    .sort((a, b) => (b.value !== a.value ? b.value - a.value : a.feature.localeCompare(b.feature)));
}
