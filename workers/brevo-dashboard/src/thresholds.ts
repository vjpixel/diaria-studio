/**
 * Thresholds dos circuit breakers do doc "Parceria Editorial Clarice.ai ×
 * Diar.ia" (métricas de reavaliação definidas pelo editor) — FONTE ÚNICA
 * (#3078) consumida pela aba Rampa (`weekly-plan.ts`), pela tabela Envios
 * (`sections-core.ts`) e por "Totais por mês" (`sections-kv.ts`).
 *
 * Antes do #3078 cada superfície fixava o threshold de bounce por conta
 * própria: a Rampa usava os 2 breakers reais do doc (hard ≥2%, total
 * hard+soft ≥5%, deliberadamente separados — #2981, hard-alto/total-baixo é
 * um cenário real que a soma sozinha mascara), enquanto Envios/Totais
 * alertavam num "≥3% combinado" que não existe no doc — um envio com hard
 * 2.5%/total 2.8% (breaker de hard já estourado) não colorria nada nelas.
 * Extraído de `weekly-plan.ts` (que reexporta os mesmos nomes pra não quebrar
 * consumidores existentes).
 */
export interface HealthThresholds {
  /** Abertura: >= green é 🟢; >= yellow (e < green) é 🟡; abaixo de yellow é 🔴. Maior é melhor. */
  openRate: { green: number; yellow: number };
  /** Hard bounce / bounce total / spam / unsub: < green é 🟢; < yellow é 🟡; >= yellow é 🔴. Menor é melhor. */
  hardBounceRate: { green: number; yellow: number };
  bounceRate: { green: number; yellow: number };
  spamRate: { green: number; yellow: number };
  unsubRate: { green: number; yellow: number };
}

/**
 * 🔴 = o breaker do doc (nível de PAUSA — o doc tem UM nível só); 🟡 = zona de
 * alerta que adicionamos ("olhar com cuidado / segurar o crescimento" chegando
 * perto do breaker). Hard bounce e bounce total SEPARADOS: o doc tem dois
 * breakers (hard ≥2%, total hard+soft ≥5%) — juntar perderia o caso
 * hard-alto/total-baixo.
 */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  openRate: { green: 17, yellow: 15 }, // 🔴 <15% (breaker do doc)
  hardBounceRate: { green: 1.5, yellow: 2 }, // 🔴 ≥2% (breaker)
  bounceRate: { green: 4, yellow: 5 }, // 🔴 ≥5% total hard+soft (breaker)
  spamRate: { green: 0.05, yellow: 0.1 }, // 🔴 ≥0,1% (breaker)
  unsubRate: { green: 2, yellow: 3 }, // 🔴 ≥3% (breaker)
};

/**
 * Circuit breaker de bounce combinado (#3078) — usado por superfícies que só
 * exibem 1 número de bounce (soma hard+soft numa célula só), diferente da
 * Rampa que mostra hard e total lado a lado. Dispara quando hard bounce
 * SOZINHO já estoura (>= `hardBounceRate.yellow`) OU quando o total hard+soft
 * estoura (>= `bounceRate.yellow`) — regra "OR" entre os 2 breakers reais do
 * doc, nunca um threshold combinado inventado. É isso que garante o caso
 * hard-alto/total-baixo (ex: hard 2.5%, total 2.8%) alertar mesmo com o total
 * ainda longe de 5%.
 */
export function isBounceBreach(
  hardBounceRatePct: number,
  totalBounceRatePct: number,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): boolean {
  return hardBounceRatePct >= t.hardBounceRate.yellow || totalBounceRatePct >= t.bounceRate.yellow;
}
