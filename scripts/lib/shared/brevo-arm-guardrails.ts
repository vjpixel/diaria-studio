/**
 * shared/brevo-arm-guardrails.ts (#13994)
 *
 * Guardrails por braço do experimento CTA (abertura, bounce, unsub, spam),
 * extraídos de `workers/brevo-dashboard/src/experiment-cta.ts` para o
 * pipeline (`clarice-guardrail-alarm.ts`, `brevo-diaria-guardrail.ts`) parar
 * de importar código do Worker. O Worker reexporta daqui; o corpo é o mesmo.
 *
 * Imports só de `shared/`: seguro para o Worker e para qualquer domínio de
 * `scripts/lib`.
 */
import { isBounceBreach, DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from "./brevo-health-thresholds.ts";

export interface ArmMetrics {
  armId: string;
  label: string;
  /** Nº de campanhas deste braço com stats reais somadas. */
  campaignCount: number;
  sent: number;
  delivered: number;
  /** Aberturas únicas (MPP-inclusivo — mesma base do resto do dashboard). */
  uniqueViews: number;
  /** Cliques únicos no nível da campanha inteira (globalStats/campaignStats). */
  uniqueClicks: number;
  /** Cliques (totais, por URL — ver limitação no topo do arquivo) no link da métrica de decisão. */
  decisionClicks: number;
  unsubscriptions: number;
  complaints: number;
  hardBounces: number;
  softBounces: number;
}

// ─── Guardrails por braço (reusa os circuit breakers da Rampa) ──────────────

export interface ArmGuardrailResult {
  armId: string;
  openRatePct: number;
  hardBounceRatePct: number;
  bounceRatePct: number;
  unsubRatePct: number;
  spamRatePct: number;
  openBreach: boolean;
  bounceBreach: boolean;
  unsubBreach: boolean;
  spamBreach: boolean;
  anyBreach: boolean;
}

export interface ArmGuardrailOptions {
  /**
   * #4131 finding 3 (self-review do PR #4063/#4064): o guard `openRatePct > 0`
   * abaixo existe pra distinguir "dado ainda propagando" (MPP leva minutos)
   * de "0% permanente", no contexto ORIGINAL desta função — dashboard, olhos
   * humanos revisando minutos após o envio. Reusar essa função tal como está
   * pro alarme de envio único (#4064, `evaluateSendGuardrails` em
   * `clarice-guardrail-alarm.ts`) herdaria o blind spot num contexto onde ele
   * INVERTE o propósito da feature: o alarme roda ~10h após o envio
   * (`GUARDRAIL_EVAL_WINDOW_MS`), quando o dado já maturou — nesse ponto, 0%
   * de abertura é o cenário MAIS catastrófico (falha total de entrega), não
   * "ainda propagando", e o guard original faria justo esse caso nunca
   * disparar o alarme. `treatZeroAsBreach: true` remove o guard `> 0` (só
   * compara contra o limiar) — default `false` preserva o comportamento
   * original da dashboard sem qualquer mudança.
   */
  treatZeroAsBreach?: boolean;
}

/**
 * #4154 (achado do self-review do #4342, decisão do editor): spam usa um
 * limiar PRÓPRIO deste experimento, ≥0,1% — deliberadamente DESACOPLADO de
 * `DEFAULT_HEALTH_THRESHOLDS.spamRate` (thresholds.ts). Aquele threshold
 * compartilhado foi afrouxado de 0,1%/0,3% pros limiares oficiais do Google
 * Postmaster Tools porque a Rampa passou a ler o Postmaster de verdade — mas
 * o guardrail por BRAÇO deste experimento não pode usar Postmaster (é
 * agregado por domínio, não por braço) e continua lendo `complaints` da
 * Brevo, que subconta o spam real em ~50× (#4063). Herdar o valor
 * compartilhado sem essa ressalva teria afrouxado 3× a proteção deste
 * guardrail sem nenhuma melhora na precisão do dado de entrada.
 */
export const CTA_SPAM_BREACH_YELLOW_PCT = 0.1;

/**
 * Mesmos thresholds de `thresholds.ts` (fonte única dos circuit breakers da
 * Rampa/Envios/Totais por mês) pra abertura/bounce/unsub — spam é exceção,
 * ver `CTA_SPAM_BREACH_YELLOW_PCT` acima.
 */
export function evaluateArmGuardrails(
  m: ArmMetrics,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
  options: ArmGuardrailOptions = {},
): ArmGuardrailResult {
  const openRatePct = m.delivered > 0 ? (m.uniqueViews / m.delivered) * 100 : 0;
  const hardBounceRatePct = m.sent > 0 ? (m.hardBounces / m.sent) * 100 : 0;
  const bounceRatePct = m.sent > 0 ? ((m.hardBounces + m.softBounces) / m.sent) * 100 : 0;
  const unsubRatePct = m.sent > 0 ? (m.unsubscriptions / m.sent) * 100 : 0;
  const spamRatePct = m.sent > 0 ? (m.complaints / m.sent) * 100 : 0;
  // #3078: mesmo guard de "openAlert exige dado real" usado em sections-core.ts
  // (renderDashboardHtml) — exige `openRatePct > 0`, não só `delivered > 0`.
  // Uma campanha recém-enviada pode ter delivered>0 mas uniqueViews ainda em
  // 0 (dado de abertura ainda propagando, MPP leva minutos) — sem este guard
  // mais estrito, esse instante transitório seria erroneamente reportado como
  // guardrail cruzado. Trade-off aceito (mesmo do original): uma campanha
  // genuinamente com 0% de abertura PERMANENTE nunca alerta — raro na prática
  // (Brevo sempre tem MPP). #4131 finding 3: `treatZeroAsBreach` (ver
  // ArmGuardrailOptions) permite ao caminho do ALARME (janela já madura,
  // #4064) remover esse guard sem afetar o caminho original da dashboard.
  const openBreach = options.treatZeroAsBreach
    ? openRatePct < thresholds.openRate.yellow
    : openRatePct > 0 && openRatePct < thresholds.openRate.yellow;
  const bounceBreach = isBounceBreach(hardBounceRatePct, bounceRatePct, thresholds);
  const unsubBreach = unsubRatePct >= thresholds.unsubRate.yellow;
  const spamBreach = spamRatePct >= CTA_SPAM_BREACH_YELLOW_PCT;
  return {
    armId: m.armId, openRatePct, hardBounceRatePct, bounceRatePct, unsubRatePct, spamRatePct,
    openBreach, bounceBreach, unsubBreach, spamBreach,
    anyBreach: openBreach || bounceBreach || unsubBreach || spamBreach,
  };
}
