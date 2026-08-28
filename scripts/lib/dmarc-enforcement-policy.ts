/**
 * dmarc-enforcement-policy.ts (#6442) — MOTOR DE DECISÃO PURO pro enforcement
 * DMARC de `news.diar.ia.br` (domínio de envio da newsletter via Kit, #6046).
 *
 * POR QUE ESTE MÓDULO EXISTE
 *
 * O #6111 (issue-mãe) mediu que `news.diar.ia.br` está em `p=none` (sem
 * enforcement) e propôs subir a política em 2 passos (`p=none` →
 * `p=quarantine` → `p=reject`) depois de "2-4 semanas de relatório DMARC
 * agregado limpo". Essa proposta foi abandonada em 26/08/2026 (decisão do
 * editor, comentário no #6111): o volume de envio do piloto Patronos (Kit,
 * poucos destinatários) provavelmente NUNCA atinge o piso que grandes
 * receptores (Google, Microsoft) exigem pra sequer EMITIR um relatório
 * agregado — esperar acúmulo de relatório é estruturalmente vazio, não
 * lento. Este módulo substitui "esperar relatório de terceiro" por "ler
 * sinal da PRÓPRIA plataforma de envio" (bounce/complaint via Kit, #6442).
 *
 * ## Analogia explícita com o freio de risco ISP da Clarice (#5026/#4705)
 *
 * `scripts/lib/clarice-envio-policy.ts` já resolve o mesmo problema de fundo
 * pra outro domínio de envio (Brevo/Clarice News): "decidir algo sobre
 * reputação de envio a partir de bounce/spam, sem esperar sinal de
 * terceiro". Este módulo REUSA os limiares VERMELHOS já calibrados lá
 * (`RED_RISK_THRESHOLDS.hardBounce` = 2%, `RED_RISK_THRESHOLDS.spam` = 0,3%
 * — os mesmos números do doc "Parceria Editorial Clarice.ai × Diar.ia",
 * `workers/brevo-dashboard/src/thresholds.ts`) em vez de inventar dois
 * números novos sem base — mas a analogia é EXPLÍCITA, não uma alegação de
 * equivalência: os dois contextos diferem em pelo menos 3 pontos, registrados
 * aqui pra quem for recalibrar não presumir mais garantia do que existe:
 *
 *   1. **Fonte do sinal é outra.** A Clarice lê bounce/spam por CAMPANHA
 *      (janela de dias de ENVIO, `SEND_WINDOWS.brakeSendDays`) via
 *      `/api/campaigns` do dashboard Brevo. O Kit não expõe bounce/complaint
 *      por broadcast (`KitBroadcastStats` não tem esses campos — só
 *      `open_rate`/`click_rate`/`unsubscribe_rate`) — o único sinal
 *      confirmado é o `state` CUMULATIVO do assinante (`bounced`/
 *      `complained`, ver `scripts/lib/kit-subscribers.ts`). Não há como medir
 *      "bounce dos últimos 3 dias de envio" no Kit hoje — só "quantos
 *      assinantes já acumularam esse estado desde sempre".
 *   2. **Denominador é outro.** A Clarice divide por `sent` da janela. Aqui
 *      não há `sent` por janela — o denominador é `totalConsidered`
 *      (assinantes em qualquer estado terminal observável, ver
 *      `DmarcSignals`), uma aproximação documentada, não uma paridade exata.
 *   3. **A decisão é OUTRA CLASSE.** A Clarice decide VOLUME diário (frear/
 *      acelerar um número que muda todo dia). Este motor decide uma
 *      TRANSIÇÃO DE POLÍTICA DNS rara e discreta (`none`→`quarantine`→
 *      `reject`) — nunca "quanto enviar hoje".
 *
 * Os limiares VERMELHOS (hard bounce, spam/complaint) medem risco de ISP de
 * forma independente do CANAL que os produziu — é essa generalidade que
 * justifica reusar o número, não reescalar as janelas/passo adaptativo da
 * Clarice, que são específicos do problema dela. **Números de piso de volume
 * e janela de maturidade abaixo (`MIN_VOLUME_FOR_DECISION`,
 * `MIN_MATURITY_DAYS`) são estimativas de calibração inicial, não medição —
 * documentado onde definidos, revisar com dado real do piloto quando houver
 * volume suficiente pra julgar.**
 *
 * ## READ-ONLY / DECISÃO APENAS
 *
 * Este módulo (e o script que o consome, `scripts/dmarc-enforcement-engine.ts`)
 * NUNCA escreve DNS. A saída é sempre uma RECOMENDAÇÃO (`recommendation` +
 * `nextPolicy`) pro editor aplicar manualmente no Cloudflare — mesma
 * disciplina do guard de publicação (`context/overnight-dispatch-rules.md`
 * item 1): decisão automatizada, execução humana.
 *
 * TUDO AQUI É PURO: sem rede, sem disco, sem `new Date()` interno — mesma
 * disciplina de `clarice-envio-policy.ts`.
 */

import { RED_RISK_THRESHOLDS } from "./clarice-envio-policy.ts";

// ---------------------------------------------------------------------------
// 1. Limiares — importados, nunca redigitados (ver docstring do módulo)
// ---------------------------------------------------------------------------

export interface DmarcEnforcementThresholdsPct {
  /** Ponto percentual de bounce cumulativo (`bouncedCount / totalConsidered`)
   * a partir do qual o sinal é considerado NÃO SAUDÁVEL. Default: o mesmo
   * `hardBounce` (2%) do freio Clarice — analogia explícita, ver docstring. */
  readonly bounce: number;
  /** Idem, pra complaint cumulativo (`complainedCount / totalConsidered`).
   * Default: o mesmo `spam` (0,3%, limiar oficial do Google Postmaster) do
   * freio Clarice. */
  readonly complaint: number;
}

export const DEFAULT_DMARC_THRESHOLDS: DmarcEnforcementThresholdsPct = {
  bounce: RED_RISK_THRESHOLDS.hardBounce,
  complaint: RED_RISK_THRESHOLDS.spam,
};

/**
 * Piso de assinantes considerados abaixo do qual o motor NUNCA decide
 * (`insufficient-volume`) — um piloto de 5-20 destinatários (#6111) produz
 * taxas que uma única baixa (1 bounce = 20% com denominador 5) tornaria
 * ruidosas demais pra decidir com confiança. **Estimativa de calibração
 * inicial** (não uma medição — não existe ainda amostra grande o bastante
 * pra derivar um piso empírico), escolhida por ser a mesma ordem de grandeza
 * que a Beehiiv/Brevo já tratam como "amostra mínima pra taxa fazer sentido"
 * em outros pontos do projeto (ex: `HEALTH_SAMPLE_DAYS`/janelas do freio
 * Clarice operam sobre milhares de envios/dia — aqui o piso é sobre
 * CONTAGEM, não dias, porque o Kit não expõe janela temporal por estado).
 * Revisar com dado real do piloto antes de tratar como definitivo.
 */
export const MIN_VOLUME_FOR_DECISION = 50;

/**
 * Dias mínimos desde o 1º broadcast completado do domínio antes de
 * considerar escalar a política — piso derivado DIRETAMENTE do texto do
 * #6111 ("depois de 2-4 semanas de relatório limpo, subir p=quarantine e
 * reject"): usamos o EXTREMO INFERIOR da faixa (14 dias) como piso mínimo, não
 * o superior — o motor real (bounce/complaint por sinal próprio) substitui o
 * relatório agregado como EVIDÊNCIA, mas a JANELA de maturidade do domínio
 * (tempo pro ISP formar reputação) continua sendo a mesma lógica de fundo do
 * #6111, então reusamos o número em vez de inventar um novo.
 */
export const MIN_MATURITY_DAYS = 14;

// ---------------------------------------------------------------------------
// 2. Sinais de entrada
// ---------------------------------------------------------------------------

/**
 * Sinais crus, já agregados pelo caller (`scripts/dmarc-enforcement-engine.ts`)
 * a partir da API do Kit. Estrutural/injetável — sem isso, testar a decisão
 * exigiria mockar `kitFetch`.
 */
export interface DmarcSignals {
  /**
   * Total de assinantes em estado TERMINAL observável (`active` +
   * `cancelled` + `bounced` + `complained` + `inactive` — todo o universo
   * que `GET /v4/subscribers?status=all` devolve). Denominador de
   * `bounceRatePct`/`complaintRatePct`. **Aproximação documentada**: não é
   * "quantos e-mails foram efetivamente ENVIADOS" (o Kit não expõe isso por
   * assinante) — é "quantos assinantes já passaram por pelo menos 1 ciclo de
   * estado", o melhor proxy disponível hoje.
   */
  readonly totalConsidered: number;
  /** Assinantes com `state === "bounced"` (cumulativo, nunca por janela — ver
   *  docstring do módulo, ponto 1). */
  readonly bouncedCount: number;
  /** Assinantes com `state === "complained"` (cumulativo). */
  readonly complainedCount: number;
  /**
   * Dias corridos desde o `send_at`/`published_at` do PRIMEIRO broadcast
   * `completed` do domínio, até `now`. `null` = nenhum broadcast completado
   * observado ainda (não há histórico de envio real pra julgar maturidade).
   */
  readonly daysSinceFirstSend: number | null;
}

// ---------------------------------------------------------------------------
// 3. Decisão
// ---------------------------------------------------------------------------

export type DmarcPolicy = "none" | "quarantine" | "reject";

/**
 * Próximo degrau de enforcement, na ordem única de escalada (#6111).
 * `reject` é o teto — não escala além dele (não-op, nunca lança).
 */
export function nextEnforcementStep(current: DmarcPolicy): DmarcPolicy {
  if (current === "none") return "quarantine";
  if (current === "quarantine") return "reject";
  return "reject";
}

export type DmarcEnforcementLevel =
  | "insufficient-volume"
  | "unhealthy"
  | "healthy-immature"
  | "healthy";

export type DmarcRecommendation = "hold" | "escalate" | "consider-rollback";

export interface DmarcEnforcementDecision {
  readonly level: DmarcEnforcementLevel;
  readonly recommendation: DmarcRecommendation;
  /**
   * Política sugerida caso o editor siga a recomendação — `null` quando a
   * recomendação é `hold` sem alvo específico, ou quando `consider-rollback`
   * deixa a escolha do alvo pro julgamento humano (nunca automatizado —
   * ver docstring do módulo, READ-ONLY / DECISÃO APENAS).
   */
  readonly nextPolicy: DmarcPolicy | null;
  readonly bounceRatePct: number;
  readonly complaintRatePct: number;
  /** Explicação pt-BR, legível, citando métrica e valor vs limiar — mesmo
   *  padrão de `BrakeDecision.reasons` (clarice-envio-policy.ts). */
  readonly reasons: readonly string[];
}

/** "1,40%" — formatação pt-BR determinística (sem ICU), mesma de `clarice-envio-policy.ts`. */
function fmtPct(n: number, decimals = 2): string {
  return `${n.toFixed(decimals).replace(".", ",")}%`;
}

function ratePct(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0 || count < 0) return 0;
  return (count / total) * 100;
}

/**
 * Decide o enforcement DMARC a partir dos sinais crus do Kit + a política
 * DNS atual (`currentPolicy`, lida pelo caller via DNS TXT — este módulo não
 * sabe nada sobre DNS). Ordem de checagem, primeira que casa decide:
 *
 * 1. **Volume insuficiente** (`totalConsidered < MIN_VOLUME_FOR_DECISION`)
 *    ⇒ `hold`, nunca decide sobre amostra pequena demais — mesmo espírito do
 *    `sufficientData` da Clarice (nunca fabricar `ok`/escalada por ausência
 *    de dado).
 * 2. **Sinal não saudável** (`bounceRatePct >= thresholds.bounce` OU
 *    `complaintRatePct >= thresholds.complaint`) ⇒ `unhealthy`. Se a política
 *    atual já é `none`, recomendação é `hold` (não há pra onde recuar). Se já
 *    escalou (`quarantine`/`reject`), recomendação é `consider-rollback` —
 *    JAMAIS um `nextPolicy` automático de rollback: a decisão de recuar uma
 *    política DNS já em produção é sempre humana (trade-off editorial real:
 *    recuar pode ter custo de reputação diferente de nunca ter escalado).
 * 3. **Domínio ainda imaturo** (`daysSinceFirstSend === null` ou
 *    `< MIN_MATURITY_DAYS`) ⇒ `healthy-immature`, `hold` — sinal está limpo
 *    mas ainda não decorreu tempo suficiente pra confiar na amostra.
 * 4. **Saudável e maduro** ⇒ `healthy`, `escalate` pro próximo degrau
 *    (`nextEnforcementStep`).
 */
export function decideDmarcEnforcement(
  signals: DmarcSignals,
  currentPolicy: DmarcPolicy,
  thresholds: DmarcEnforcementThresholdsPct = DEFAULT_DMARC_THRESHOLDS,
): DmarcEnforcementDecision {
  const bounceRatePct = ratePct(signals.bouncedCount, signals.totalConsidered);
  const complaintRatePct = ratePct(signals.complainedCount, signals.totalConsidered);

  if (!Number.isFinite(signals.totalConsidered) || signals.totalConsidered < MIN_VOLUME_FOR_DECISION) {
    return {
      level: "insufficient-volume",
      recommendation: "hold",
      nextPolicy: null,
      bounceRatePct,
      complaintRatePct,
      reasons: [
        `volume insuficiente pra decidir (${Number.isFinite(signals.totalConsidered) ? signals.totalConsidered : 0} assinantes considerados, piso ${MIN_VOLUME_FOR_DECISION}) — segurando em ${currentPolicy}, nunca escalando sobre amostra pequena.`,
      ],
    };
  }

  const bounceUnhealthy = bounceRatePct >= thresholds.bounce;
  const complaintUnhealthy = complaintRatePct >= thresholds.complaint;

  if (bounceUnhealthy || complaintUnhealthy) {
    const reasons: string[] = [];
    if (bounceUnhealthy) {
      reasons.push(
        `bounce: ${fmtPct(bounceRatePct)} (${signals.bouncedCount}/${signals.totalConsidered}) >= limiar ${fmtPct(thresholds.bounce)}.`,
      );
    }
    if (complaintUnhealthy) {
      reasons.push(
        `complaint: ${fmtPct(complaintRatePct)} (${signals.complainedCount}/${signals.totalConsidered}) >= limiar ${fmtPct(thresholds.complaint)}.`,
      );
    }
    const recommendation: DmarcRecommendation = currentPolicy === "none" ? "hold" : "consider-rollback";
    if (currentPolicy === "none") {
      reasons.push("política atual já é 'none' — não há degrau pra recuar; segurando.");
    } else {
      reasons.push(
        `política atual é '${currentPolicy}' com sinal não saudável — considerar rollback manual (decisão humana, nunca automática).`,
      );
    }
    return {
      level: "unhealthy",
      recommendation,
      nextPolicy: null,
      bounceRatePct,
      complaintRatePct,
      reasons,
    };
  }

  if (signals.daysSinceFirstSend === null || signals.daysSinceFirstSend < MIN_MATURITY_DAYS) {
    const observed = signals.daysSinceFirstSend === null ? "nenhum broadcast completado ainda" : `${signals.daysSinceFirstSend} dia(s)`;
    return {
      level: "healthy-immature",
      recommendation: "hold",
      nextPolicy: null,
      bounceRatePct,
      complaintRatePct,
      reasons: [
        `sinal limpo (bounce ${fmtPct(bounceRatePct)}, complaint ${fmtPct(complaintRatePct)}), mas domínio ainda imaturo — ${observed} desde o 1º broadcast, piso ${MIN_MATURITY_DAYS} dias.`,
      ],
    };
  }

  return {
    level: "healthy",
    recommendation: "escalate",
    nextPolicy: nextEnforcementStep(currentPolicy),
    bounceRatePct,
    complaintRatePct,
    reasons: [
      `sinal limpo (bounce ${fmtPct(bounceRatePct)} < ${fmtPct(thresholds.bounce)}, complaint ${fmtPct(complaintRatePct)} < ${fmtPct(thresholds.complaint)}) e domínio maduro (${signals.daysSinceFirstSend} dias >= piso ${MIN_MATURITY_DAYS}) — recomenda escalar ${currentPolicy} → ${nextEnforcementStep(currentPolicy)}.`,
    ],
  };
}
