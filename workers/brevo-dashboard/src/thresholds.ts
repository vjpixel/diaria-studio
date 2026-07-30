/**
 * Thresholds dos circuit breakers do doc "Parceria Editorial Clarice.ai ×
 * Diar.ia" (métricas de reavaliação definidas pelo editor) — FONTE ÚNICA
 * (#3078) consumida pela aba Rampa (`weekly-plan.ts`), pela tabela Envios
 * (`sections-core.ts`) e por "Totais por mês" (`sections-kv.ts`) — EXCETO
 * `spamRate`, que desde #4154 é exceção nesta "fonte única": Envios/Totais
 * NUNCA mais coloriram spam (o número ali vem de `complaints` da Brevo, que
 * subconta ~50× — só a leitura do Postmaster, exclusiva da aba Rampa, é
 * confiável o bastante pra colorir), e o guardrail por braço do experimento
 * CTA (`experiment-cta.ts::CTA_SPAM_BREACH_YELLOW_PCT`) mantém seu próprio
 * valor fixo, deliberadamente desacoplado deste. `spamRate` aqui governa
 * SÓ a aba Rampa.
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
import type { PostmasterSpamEntry, PostmasterProducer } from "./types.ts";

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
  // #4154 (260730): atualizado pelo editor pros limiares oficiais do Google
  // Postmaster Tools (verde <0,10%, amarelo <0,30%, 🔴 ≥0,30%) agora que a
  // leitura automática via API está em produção — substitui o par 0,05/0,1
  // anterior, calibrado sobre o número (subcontado) da Brevo.
  spamRate: { green: 0.1, yellow: 0.3 }, // 🔴 ≥0,3% (limiar oficial do Postmaster Tools)
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

/**
 * #4063: o circuit breaker de spam da Rampa lia `globalStats.complaints` da
 * Brevo — que subconta o spam real em ~50× (a Brevo só enxerga feedback
 * loops; o "marcar como spam" do Gmail não passa por FBL, e 73% da base é
 * Gmail). Medido no Google Postmaster Tools (domínio `clarice.ai`): ~1,0%,
 * pico 1,5%, contra ≤0,02% reportado pela Brevo — o breaker do doc (≥0,1%)
 * nunca disparou.
 *
 * Decisão do editor: o breaker NUNCA reporta 🟢 usando o número da Brevo. A
 * fonte que governa é uma leitura do Postmaster (`PostmasterSpamEntry`,
 * gravada automaticamente via API por `scripts/postmaster-spam-sync.ts` a
 * cada 12h desde #4154, ou manualmente por `scripts/postmaster-spam-entry.ts`
 * como fallback) — com PRECEDÊNCIA sobre `complaints`. Sem leitura (ausente
 * OU velha demais pra confiar), o sinal é `indeterminate`: nunca
 * `breach=true` (não é um bloqueio automático — a trava fica pra depois),
 * mas também nunca colorido verde (ver `classifySpamSignal` em
 * `weekly-plan.ts`, que força 🟡 nesse caso).
 */
export type SpamSignalSource = "postmaster" | "indeterminate";

export interface SpamSignal {
  source: SpamSignalSource;
  /** % da leitura do Postmaster usada nesta avaliação — `null` quando `source==="indeterminate"`. */
  ratePct: number | null;
  /** `true` quando a leitura do Postmaster cruzou o breaker (`>= thresholds.spamRate.yellow`). Sempre `false` quando indeterminado. */
  breach: boolean;
  /** Qual produtor gravou a leitura (#4154) — `undefined` quando indeterminado ou entry pré-#4154 sem o campo. Só informativo (label da UI), nunca entra na classificação. */
  producedBy?: PostmasterProducer;
}

/**
 * Além de "campo ausente", uma leitura mais velha que isto é tratada como se
 * não existisse — o Postmaster é lido ~1min antes de CADA envio (cadência
 * diária/poucos dias), então uma leitura de vários dias atrás não é mais
 * representativa do risco do envio de hoje. 48h dá folga (ex: sexta lida,
 * envio de segunda) sem deixar uma leitura de semanas atrás perpetuar um
 * falso "confiável".
 */
export const POSTMASTER_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Resolve o sinal de spam que GOVERNA a avaliação de guardrail — nunca o
 * `complaints`/`spamRate` derivado da Brevo. `entry` é o que está gravado sob
 * a chave KV `postmaster:spam` (ou `null`/ausente). `now` injetado (não
 * `new Date()` interno) para determinismo em teste.
 *
 * Regressão coberta (#633, exigida pela própria issue #4063): um `spamRatePct`
 * de Postmaster acima do limite resolve para `breach: true` MESMO com
 * `complaints` da Brevo em zero — esta função nem recebe o dado da Brevo,
 * então a garantia é estrutural (não há como o número da Brevo influenciar
 * o resultado).
 */
export function resolveSpamSignal(
  entry: Pick<PostmasterSpamEntry, "spamRatePct" | "recordedAt" | "producedBy"> | null | undefined,
  now: Date = new Date(),
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): SpamSignal {
  if (!entry || !Number.isFinite(entry.spamRatePct)) {
    return { source: "indeterminate", ratePct: null, breach: false };
  }
  const recordedMs = Date.parse(entry.recordedAt);
  if (!Number.isFinite(recordedMs) || now.getTime() - recordedMs > POSTMASTER_STALE_MS) {
    return { source: "indeterminate", ratePct: null, breach: false };
  }
  return {
    source: "postmaster",
    ratePct: entry.spamRatePct,
    producedBy: entry.producedBy,
    breach: entry.spamRatePct >= t.spamRate.yellow,
  };
}
