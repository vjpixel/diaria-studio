/**
 * clarice-envio-policy.ts (#4705) — MOTOR DE DECISÃO PURO do envio diário
 * automatizado pra base Clarice News (task 19:00 BRT planeja/agenda a onda do
 * dia seguinte às 06:00 BRT = 09:00 UTC).
 *
 * POR QUE ESTE MÓDULO EXISTE (a catraca):
 * O planejador atual (`clarice-wave-plan.ts` → `computeWeekPlan`/`decideSemaphore`
 * do worker) decide volume pelo SEMÁFORO, e o semáforo inclui ABERTURA
 * (`openRate < 15% ⇒ 🔴 ⇒ corta 30%`). Isso funciona pra uma base quente; pra
 * uma base de 1º envio ~96% fria, que abre ~1%, é uma CATRACA: todo dia cai no
 * vermelho por definição, todo dia corta 30%, e o volume implode sozinho.
 * Observado ao vivo: 10.014 → 322 → 1.053 → 817 e-mails/dia. O freio não estava
 * protegendo reputação nenhuma — estava zerando o alcance por causa de uma
 * métrica que a própria natureza da base garante que fica baixa.
 *
 * DECISÃO DO EDITOR (11/08/2026, NÃO reabrir aqui):
 *   1. ABERTURA SAI DO FREIO. Vira métrica de OBSERVAÇÃO/TENDÊNCIA (janela 60d,
 *      `openRateTrend` abaixo) — nunca corta volume, nunca entra em
 *      `decideBrake`/`adaptiveStep`.
 *   2. FREIO = SÓ RISCO DE ISP: hard bounce ≥2%, bounce total (hard+soft) ≥5%,
 *      unsub ≥3%, spam do Postmaster ≥0,3%. Limiares MANTIDOS exatamente como
 *      já estão em `workers/brevo-dashboard/src/thresholds.ts` (importados
 *      daqui, nunca redigitados — ver `RED_RISK_THRESHOLDS`).
 *   3. ESCALADA ADAPTATIVA pela folga até os limiares (substitui o +10% fixo do
 *      `DEFAULT_WEEK_STEP`), com teto de +25%/dia. **SUPERSEDIDO pelo item 3
 *      da #6888 (01/09/2026) — ver `adaptiveStep` abaixo: o passo voltou a
 *      ser fixo, agora em 10%/dia, incondicional (nunca mais consulta risco).**
 *   4. SEM teto absoluto de volume — desde #6793/#6888 (freio nunca mais
 *      trava, passo é fixo) os únicos limitadores reais que sobram são a
 *      fila e o crédito Brevo.
 *   5. SUNSET de não-abridores (`shouldSunsetNonOpener`): ≥2 envios e 0 aberturas
 *      vira inelegível, cortando o laço que alimenta spam.
 *
 * TUDO AQUI É PURO: sem rede, sem disco, sem `new Date()` interno (todo `now` é
 * parâmetro injetado — mesma disciplina de `clarice-wave-plan.ts` e
 * `weekly-plan.ts`, e o que torna a decisão testável sem bater na Brevo).
 *
 * TIPOS DE ENTRADA AUTOCONTIDOS de propósito: as interfaces abaixo
 * (`RiskMetrics`, `SpamSignalLike`, `SendDayLike`, `OpenRateTrendPoint`) são
 * ESTRUTURAIS — nada aqui importa `BrevoCampaign` nem `SpamSignal` do worker
 * Cloudflare. Um `BrevoCampaign` satisfaz `SendDayLike` por estrutura, então o
 * call site passa o objeto do worker direto, sem adaptador. `SpamSignalLike`
 * é a ÚNICA exceção deliberada (achado do type-design-analyzer no review da
 * PR): é uma união discriminada (`{source:"postmaster", ratePct:number} |
 * {source:"indeterminate", ratePct:null}`), enquanto `SpamSignal` do worker
 * (`resolveSpamSignal`) é um shape FLAT (`ratePct: number | null`
 * independente de `source`) — os dois estados impossíveis que a união
 * discriminada elimina em tempo de compilação (`postmaster` com `ratePct`
 * nulo, `indeterminate` com `ratePct` numérico) o `SpamSignal` flat permite
 * representar, mesmo que `resolveSpamSignal` nunca os produza na prática. Por
 * isso `SpamSignal` NÃO satisfaz `SpamSignalLike` por estrutura — o call site
 * precisa de um adaptador de 1 linha (`spam.source === "postmaster" &&
 * spam.ratePct !== null ? {source:"postmaster", ratePct:spam.ratePct} :
 * {source:"indeterminate", ratePct:null}`), documentado onde ele é usado
 * (`scripts/clarice-envio-risk.ts`). Esse custo pontual compra uma garantia
 * de compilador em vez de defesa em tempo de execução — decisão tomada
 * enquanto este módulo ainda tinha ZERO call sites (o momento mais barato
 * possível pra essa troca), continua carregável/testável sem arrastar a
 * cadeia de render do dashboard (`sections-core` → `render-links` →
 * `sections-kv`) pra dentro de uma task Node que roda todo dia às 19:00.
 *
 * A ÚNICA coisa importada do worker é o objeto de limiares, e de propósito: os
 * números do doc "Parceria Editorial Clarice.ai × Diar.ia" já têm fonte única
 * desde #3078 (`thresholds.ts`), e manter uma 2ª cópia aqui é exatamente a
 * classe de bug que o #3078 apagou — dois números divergindo em silêncio, cada
 * superfície com seu breaker.
 */

import { DEFAULT_HEALTH_THRESHOLDS } from "../../workers/brevo-dashboard/src/thresholds.ts";

// ---------------------------------------------------------------------------
// 1. Janelas de observação
// ---------------------------------------------------------------------------

/**
 * As 3 janelas do motor, cada uma com um PORQUÊ próprio — não são três
 * variações arbitrárias do mesmo número:
 *
 * - `brakeSendDays: 3` — o FREIO olha os últimos **3 dias de envio** (dias com
 *   envio, não dias de calendário; um dia de teste A/B/C conta como 1). Por que
 *   tão curto: bounce e unsub já estão FINAIS em ~T+13h (o ISP responde na
 *   hora; não é como abertura, que sobe por 48h). Uma janela longa aqui
 *   DILUIRIA um pico de hard bounce de hoje entre semanas boas — que é
 *   exatamente o que o freio precisa enxergar pra frear ANTES do ISP reagir.
 *
 * - `accelDays: 30` — o ACELERADOR olha 30 dias corridos. Por que mais longo:
 *   acelerar é uma aposta sobre reputação SUSTENTADA, não sobre o dia bom de
 *   ontem. Escalar +25% em cima de 3 dias bons é como confundir sorte com
 *   tendência; 30 dias já engloba um ciclo de envio inteiro.
 *
 * - `trendDays: 60` — a TENDÊNCIA de abertura (relatório, `openRateTrend`) usa
 *   60 dias corridos porque abertura de base fria se move devagar e em números
 *   pequenos (~1%): abaixo de ~2 meses a metade recente vs a antiga é ruído de
 *   amostra, não sinal. **Esta janela NUNCA alimenta decisão de volume** — é a
 *   consequência direta da decisão 1 do editor lá em cima.
 */
export const SEND_WINDOWS = {
  brakeSendDays: 3,
  accelDays: 30,
  trendDays: 60,
} as const;

// ---------------------------------------------------------------------------
// 2. Utilização de risco — "quanto do limiar já foi gasto"
// ---------------------------------------------------------------------------

/**
 * Métricas de risco de ISP agregadas de uma janela. Percentuais em pontos
 * PERCENTUAIS (2 = 2%), mesma convenção de `HealthAggregate` (weekly-plan.ts) —
 * um `HealthAggregate` NÃO satisfaz este tipo por acidente (nomes diferentes de
 * propósito: `hardBounceRatePct` vs `hardBounceRate`), pra que o call site
 * tenha que mapear conscientemente e não passe um agregado com abertura junto
 * achando que ela conta pra alguma coisa aqui.
 *
 * `delivered` entra pra CONTEXTO/relatório (é o denominador da abertura, que
 * este motor observa mas não usa pra frear) — nenhuma utilização é calculada
 * sobre ele. Os 3 percentuais têm `sent` como denominador, mesma convenção do
 * dashboard inteiro.
 */
export interface RiskMetrics {
  readonly hardBounceRatePct: number;
  readonly bounceRatePct: number;
  readonly unsubRatePct: number;
  readonly sent: number;
  readonly delivered: number;
}

/**
 * Formato estrutural do sinal de spam. `SpamSignal` de
 * `workers/brevo-dashboard/src/thresholds.ts` (`resolveSpamSignal`) satisfaz
 * isto por estrutura — o call site passa direto, sem conversão nem import do
 * worker aqui dentro.
 *
 * A leitura que vale é SEMPRE a do Google Postmaster Tools. O `complaints` da
 * Brevo subconta o spam real em ~50× (só enxerga feedback loop; o "marcar como
 * spam" do Gmail não passa por FBL e 73% da base é Gmail) — #4063. Por isso
 * este tipo não tem um campo "spam da Brevo": ele não existe como entrada
 * legítima deste motor.
 */
/**
 * União discriminada (não um flat `{source, ratePct}`) — achado do
 * type-design-analyzer no review da PR: um shape flat permite os estados
 * IMPOSSÍVEIS `{source:"indeterminate", ratePct: <número>}` e
 * `{source:"postmaster", ratePct: null}`, que o código então precisava
 * "defender em tempo de execução" (ver o comentário de `riskUtilization`
 * sobre `ratePct === null` com `source==="postmaster"`, um estado que o tipo
 * ANTIGO permitia mas `resolveSpamSignal` nunca produzia). Com a união, os
 * dois estados impossíveis não compilam — a defesa em profundidade no código
 * continua (nunca custa mais uma checagem), mas o tipo já não MENTE sobre o
 * que é representável.
 */
export type SpamSignalLike =
  | { readonly source: "postmaster"; readonly ratePct: number }
  | { readonly source: "indeterminate"; readonly ratePct: null };

/** Chaves das métricas de risco — a ordem aqui é o desempate de `worst`. */
export const RISK_METRIC_KEYS = ["hardBounce", "bounce", "unsub", "spam"] as const;
export type RiskMetricKey = (typeof RISK_METRIC_KEYS)[number];

/** Limiar VERMELHO (o breaker) de cada métrica de risco, em pontos percentuais. */
export interface RiskThresholdsPct {
  readonly hardBounce: number;
  readonly bounce: number;
  readonly unsub: number;
  readonly spam: number;
}

/**
 * Os 4 breakers, DERIVADOS de `DEFAULT_HEALTH_THRESHOLDS` — nunca redigitados.
 * A faixa `.yellow` de cada métrica "menor é melhor" É o breaker do doc
 * (`classifyMetric` classifica `>= yellow` como 🔴; ver thresholds.ts): hard
 * bounce ≥2%, bounce total ≥5%, unsub ≥3%, spam ≥0,3% (limiar oficial do
 * Postmaster desde #4154).
 *
 * `openRate` de `DEFAULT_HEALTH_THRESHOLDS` é deliberadamente IGNORADO aqui —
 * é a decisão 1 do editor, e a ausência do campo neste tipo é o que torna
 * impossível reintroduzir a catraca por descuido: não há onde encaixar
 * abertura numa `RiskThresholdsPct`.
 */
export const RED_RISK_THRESHOLDS: RiskThresholdsPct = {
  hardBounce: DEFAULT_HEALTH_THRESHOLDS.hardBounceRate.yellow,
  bounce: DEFAULT_HEALTH_THRESHOLDS.bounceRate.yellow,
  unsub: DEFAULT_HEALTH_THRESHOLDS.unsubRate.yellow,
  spam: DEFAULT_HEALTH_THRESHOLDS.spamRate.yellow,
};

/**
 * Utilização atribuída ao spam quando NÃO há leitura confiável do Postmaster
 * (`source === "indeterminate"`: entry ausente, malformada, stale de gravação,
 * stale de medição ou cobertura baixa — as 5 causas de `resolveSpamSignal`).
 *
 * 0,7 é exatamente `HOLD_UTIL`, e isso é proposital: espelha a semântica que já
 * vale hoje no dashboard (`classifySpamSignal`: indeterminado ⇒ 🟡 ⇒ mantém
 * volume). Histórico até #6888 (01/09/2026): sem leitura, o motor NUNCA
 * acelerava (0,7 zerava `adaptiveStep`) e NUNCA parava (0,7 < 1,0, não virava
 * `stop`, mesmo antes de `decideBrake` perder o freio no #6793). Desde #6888,
 * `adaptiveStep` é incondicional (`FIXED_DAILY_STEP`, sempre) — este valor
 * continua alimentando `decideBrake.reasons`/relatório (spam indeterminado
 * ainda aparece como zona de atenção pra quem lê), só não trava mais nada.
 */
export const INDETERMINATE_SPAM_UTIL = 0.7;

export interface RiskUtilization {
  /** Maior utilização entre as 4 métricas. Não decide mais nada desde #6888
   * (passo) e #6793 (freio) — só alimenta `decideBrake.reasons`/`flagged`
   * (texto de observabilidade pro relatório), nunca uma ação. */
  readonly maxUtil: number;
  /** Utilização por métrica (`valor ÷ limiar vermelho`). */
  readonly byMetric: Readonly<Record<string, number>>;
  /** Métrica que produziu `maxUtil` (empate desempatado por `RISK_METRIC_KEYS`). */
  readonly worst: string;
  /**
   * Métricas cuja utilização é 0 por FALTA DE DADO, não por saúde: denominador
   * zero (`sent === 0`) ou valor não-finito, e spam indeterminado NÃO entra
   * aqui (indeterminado tem tratamento próprio, `INDETERMINATE_SPAM_UTIL`).
   *
   * Existe porque "0% de hard bounce" e "não enviamos nada, logo não sabemos"
   * são estados diferentes que colapsam no mesmo número — e é o segundo que o
   * editor precisa ver no relatório antes de confiar num `ok` (mesmo racional
   * do "—" vs "0.000%" que o #3081 introduziu no dashboard).
   */
  readonly noDataMetrics: readonly string[];
  /**
   * `false` quando a janela de e-mail (hard bounce/bounce/unsub) não teve
   * NENHUM envio (`sent === 0`/não-finito) — achado CRITICAL do
   * silent-failure-hunter no review da PR: com `sent === 0` as 3 métricas de
   * e-mail zeram (nada pra dividir), e se a leitura do Postmaster ESSE DIA
   * calhar de vir saudável (spam é sinal de DOMÍNIO, independente de `sent`
   * desta janela — ver comentário abaixo), `maxUtil` ficava baixo e
   * `decideBrake`/`adaptiveStep` liberavam escalada **sem nenhuma evidência
   * de envio real na janela** — o exato "ok fabricado" que este módulo diz
   * evitar, só que por ausência de dado em vez de `NaN`. Desde #6793
   * (`decideBrake`, nível sempre `ok`) e #6888 (`adaptiveStep`, passo sempre
   * `FIXED_DAILY_STEP`) NENHUM dos dois consumidores AGE mais sobre `false`
   * aqui — `true` só quando `hasSent` é `true` — mas as duas janelas que o
   * consomem hoje diferem em quem ainda REPORTA:
   *   - **janela fresca** (3 dias, `decideBrake`/`freshRisk`): continua
   *     calculado e reportado — `brake.reasons` nomeia "sem NENHUM envio na
   *     janela" quando `false` aqui (ver `decideBrake` acima).
   *   - **janela accel** (30 dias, `accelRisk`): até #6958, NINGUÉM chamava
   *     `riskUtilization(accelRisk, …)` — `adaptiveStep` parou de consumi-la
   *     no #6888 e nada mais a lia, então este campo nem era CALCULADO pra
   *     essa janela, e um canal dormente >30 dias reativado crescia 10%/dia
   *     sem nenhum aviso. #6958 fecha isso: `RiskSnapshot.accelWindow.
   *     utilization` carrega o resultado e `clarice-envio-run.ts` reporta
   *     quando vem `false` — só observabilidade, nenhuma ação nova.
   */
  readonly sufficientData: boolean;
}

/** Divide protegendo contra denominador ≤ 0 / valor não-finito/negativo. `null` = sem dado.
 * Negativo é tratado como SEM DADO (não como "-2,5× o limiar", achado do
 * silent-failure-hunter): um percentual nunca é legitimamente negativo — só
 * corrupção upstream (sinal trocado, unidade errada) produz isso, e aceitar
 * o valor faria essa métrica parecer artificialmente mais saudável que 0%. */
function utilOf(valuePct: number, limitPct: number, hasDenominator: boolean): number | null {
  if (!hasDenominator) return null;
  if (!Number.isFinite(valuePct) || valuePct < 0) return null;
  if (!Number.isFinite(limitPct) || limitPct <= 0) return null;
  return valuePct / limitPct;
}

/**
 * Quanto de cada limiar VERMELHO já foi consumido, em fração (1,0 = está
 * exatamente no breaker). Nenhuma decisão aqui — só a medida que
 * `decideBrake` consome pro relatório (`reasons`/`flagged`). Até #6888,
 * `adaptiveStep` também consumia esta função pra decidir o passo — desde
 * #6888 (01/09/2026) o passo é fixo (`FIXED_DAILY_STEP`) e não chama mais
 * `riskUtilization`; a garantia "2 cálculos paralelos do mesmo fato é a
 * classe de bug do #4658" continua valendo pro que resta consumindo isto.
 *
 * Regras de borda, todas deliberadas:
 * - `sent === 0` (nenhum envio na janela) ⇒ util 0 nas 3 métricas de e-mail, e
 *   as 3 são reportadas em `noDataMetrics`. NUNCA divide por zero, e nunca
 *   deixa um `NaN` vazar pra uma comparação (`NaN >= 1` é `false`, ou seja: um
 *   NaN silencioso viraria um `ok` fabricado — o pior default possível num
 *   motor que decide disparar e-mail).
 * - spam `indeterminate` ⇒ util fixa `INDETERMINATE_SPAM_UTIL` (0,7).
 * - spam `postmaster` com `ratePct === null` (estado que o tipo permite mas
 *   `resolveSpamSignal` nunca produz) é tratado como indeterminado — defesa em
 *   profundidade, nunca como "0% de spam confirmado".
 */
export function riskUtilization(
  m: RiskMetrics,
  spam: SpamSignalLike,
  t: RiskThresholdsPct = RED_RISK_THRESHOLDS,
): RiskUtilization {
  const hasSent = Number.isFinite(m.sent) && m.sent > 0;

  const raw: Record<RiskMetricKey, number | null> = {
    hardBounce: utilOf(m.hardBounceRatePct, t.hardBounce, hasSent),
    bounce: utilOf(m.bounceRatePct, t.bounce, hasSent),
    unsub: utilOf(m.unsubRatePct, t.unsub, hasSent),
    spam: null,
  };

  // Spam: a leitura do Postmaster é independente do nosso `sent` (é uma medida
  // do domínio no ISP, não uma razão sobre esta janela de envio) — por isso não
  // participa do guard `hasSent` acima.
  const spamUsable = spam.source === "postmaster" && spam.ratePct !== null;
  raw.spam = spamUsable ? utilOf(spam.ratePct as number, t.spam, true) : INDETERMINATE_SPAM_UTIL;

  const byMetric: Record<string, number> = {};
  const noDataMetrics: string[] = [];
  for (const k of RISK_METRIC_KEYS) {
    const v = raw[k];
    if (v === null) {
      byMetric[k] = 0;
      noDataMetrics.push(k);
    } else {
      byMetric[k] = v;
    }
  }

  // `worst` = maior utilização; empate resolvido pela ordem de
  // RISK_METRIC_KEYS (hard bounce primeiro — é o breaker mais caro de estourar).
  // Com tudo zerado, `worst` continua sendo uma chave válida (nunca `undefined`),
  // e `noDataMetrics` é quem conta a história real.
  let worst: RiskMetricKey = RISK_METRIC_KEYS[0];
  for (const k of RISK_METRIC_KEYS) {
    if (byMetric[k] > byMetric[worst]) worst = k;
  }

  return { maxUtil: byMetric[worst], byMetric, worst, noDataMetrics, sufficientData: hasSent };
}

// ---------------------------------------------------------------------------
// 3. Freio — só risco de ISP, nunca abertura
// ---------------------------------------------------------------------------

export type BrakeLevel = "ok" | "hold" | "stop";

/** Utilização a partir da qual o motor PARA (não agenda / cancela o agendado). */
export const STOP_UTIL = 1.0;

/** Utilização a partir da qual o motor SEGURA (agenda, mas não escala). */
export const HOLD_UTIL = 0.7;

export interface BrakeDecision {
  readonly level: BrakeLevel;
  /** Explicação pt-BR, legível, citando métrica e valor vs limiar. */
  readonly reasons: readonly string[];
  readonly maxUtil: number;
}

/** "1,40%" — formatação pt-BR determinística (sem ICU, pra teste estável). */
function fmtPct(n: number, decimals = 2): string {
  return `${n.toFixed(decimals).replace(".", ",")}%`;
}

/** Rótulo humano de cada métrica, pros `reasons`. */
const RISK_METRIC_LABEL: Record<RiskMetricKey, string> = {
  hardBounce: "hard bounce",
  bounce: "bounce total (hard+soft)",
  unsub: "descadastro",
  spam: "spam (Postmaster)",
};

/** Valor observado de cada métrica, pro texto do `reason`. `null` = sem leitura. */
function observedValue(
  key: RiskMetricKey,
  m: RiskMetrics,
  spam: SpamSignalLike,
): number | null {
  if (key === "hardBounce") return m.hardBounceRatePct;
  if (key === "bounce") return m.bounceRatePct;
  if (key === "unsub") return m.unsubRatePct;
  return spam.source === "postmaster" ? spam.ratePct : null;
}

/**
 * Decide o FREIO sobre a janela CURTA (`SEND_WINDOWS.brakeSendDays` = últimos 3
 * dias de envio — use `selectLastSendDays` pra montá-la).
 *
 * `stop` (util ≥ 1,0) = não agenda; se já houver onda agendada pra amanhã, o
 * call site cancela. `hold` (util ≥ 0,7, OU sem dado suficiente na janela —
 * ver abaixo) = agenda o MESMO volume do último dia enviado, sem escalar
 * (não necessariamente "ontem" — ver `NextVolumeInput.baseVolume`, mesma
 * terminologia deliberada por causa de gaps de envio). `ok` = livre pra
 * escalar o quanto `adaptiveStep` liberar.
 *
 * **#6793 "Faixa B" item 2 (01/09/2026, decisão do editor): o freio
 * automático foi REMOVIDO — `level` é sempre `"ok"`, `stop`/`hold` nunca
 * mais são produzidos.** `util`/`flagged`/`reasons` continuam calculados
 * e reportados normalmente (observabilidade preservada — o relatório
 * continua nomeando QUAL métrica estouraria o limiar antigo, só não age
 * mais sobre isso). **A proteção contra "crescer sobre dado ausente"
 * também saiu, na mesma data (#6888): `adaptiveStep` cresce
 * `FIXED_DAILY_STEP` mesmo sem NENHUM envio na janela** — até #6888 ela
 * sobrevivia porque `adaptiveStep` (função separada, então fora do escopo
 * do item 2 acima, que nomeava só `decideBrake`) tinha seu próprio guard
 * `sufficientData → passo 0`; a #6888 remove esse guard também, por pedido
 * EXPLÍCITO do editor — decisão consciente registrada na issue, não um
 * efeito colateral de trocar a fórmula do passo.
 *
 * Histórico (#4476/#4705, até 01/09/2026): `sufficientData: false` NUNCA
 * produzia `ok` (achado CRITICAL do silent-failure-hunter) — `sent === 0`
 * na janela zera as 3 métricas de e-mail por falta de denominador, e um
 * Postmaster saudável nesse mesmo dia faria `maxUtil` ficar baixo e o freio
 * liberar `ok` sem nenhuma evidência de envio real. `stop` era alcançável
 * mesmo sem `sent` na janela quando um spam do Postmaster genuinamente ruim
 * (sinal de domínio, independente da janela) cruzava o limiar.
 *
 * ABERTURA NÃO ENTRA AQUI, por decisão do editor (#4705) — e nem tem como
 * entrar: `RiskMetrics` não carrega o número, e `RiskThresholdsPct` não tem
 * campo pra ele. Se alguém um dia quiser reintroduzir a catraca, vai ter que
 * mudar os dois tipos de propósito, não por descuido num `if`.
 */
export function decideBrake(
  freshRisk: RiskMetrics,
  spam: SpamSignalLike,
  t: RiskThresholdsPct = RED_RISK_THRESHOLDS,
): BrakeDecision {
  const util = riskUtilization(freshRisk, spam, t);
  // #6793: level hardcoded pra "ok" — util/flagged/reasons abaixo continuam
  // calculados e reportados por inteiro (observabilidade), só a AÇÃO saiu.
  const level: BrakeLevel = "ok";

  // Uma linha por métrica que já chegou na zona de atenção, da pior pra menos
  // pior — o editor lê o relatório e sabe na hora QUEM segurou a onda.
  const flagged = RISK_METRIC_KEYS.filter((k) => util.byMetric[k] >= HOLD_UTIL).sort(
    (a, b) => util.byMetric[b] - util.byMetric[a],
  );

  const reasons: string[] = [];

  // Sem envio na janela é a razão PRINCIPAL quando é ela que segura o freio
  // em hold (level "hold" mas nenhuma métrica isolada bateu HOLD_UTIL) —
  // reason dedicada em vez de deixar o editor inferir isso só do aviso de
  // noDataMetrics no fim (Finding 1 do review).
  if (!util.sufficientData && flagged.length === 0) {
    reasons.push(
      "sem NENHUM envio na janela do freio — nota informativa só (freio não segura mais nada, #6793); o passo fixo de +10%/dia (#6888) escala mesmo sobre este 'não sabemos'.",
    );
  }

  for (const k of flagged) {
    const value = observedValue(k, freshRisk, spam);
    const pctOfLimit = Math.round(util.byMetric[k] * 100);
    if (k === "spam" && value === null) {
      reasons.push(
        `spam (Postmaster): sem leitura confiável — assume ${pctOfLimit}% do limiar de ${fmtPct(t.spam)} (nunca acelera, nunca para).`,
      );
      continue;
    }
    // Finding 2 (silent-failure-hunter): valor não-finito (NaN/Infinity) nunca
    // vaza pro texto — "NaN% de 2,00%" no relatório automatizado é pior que
    // omitir o número (o objetivo do texto é ser auditável, não garbled).
    const verb = util.byMetric[k] >= STOP_UTIL ? "estourou o limiar" : "está em";
    const valueText = value !== null && Number.isFinite(value) ? fmtPct(value) : "sem leitura válida";
    reasons.push(
      `${RISK_METRIC_LABEL[k]}: ${valueText} ${verb} ${fmtPct(t[k])} (${pctOfLimit}% do limiar).`,
    );
  }

  if (reasons.length === 0) {
    const w = util.worst as RiskMetricKey;
    const value = observedValue(w, freshRisk, spam);
    const detail =
      value === null || !Number.isFinite(value)
        ? ""
        : ` (${fmtPct(value)} de ${fmtPct(t[w])}, ${Math.round(util.maxUtil * 100)}% do limiar)`;
    reasons.push(`risco de ISP dentro dos limiares — pior métrica é ${RISK_METRIC_LABEL[w]}${detail}.`);
  }

  if (util.noDataMetrics.length > 0) {
    reasons.push(
      `sem dado na janela pra: ${util.noDataMetrics.join(", ")} — utilização 0 por AUSÊNCIA de envio/leitura, não por saúde confirmada.`,
    );
  }

  return { level, reasons, maxUtil: util.maxUtil };
}

// ---------------------------------------------------------------------------
// 4. Passo de crescimento diário — FIXO desde #6888 (01/09/2026)
// ---------------------------------------------------------------------------

/**
 * Passo FIXO de crescimento por dia — 10%, sempre, independente de risco.
 *
 * DECISÃO DO EDITOR (#6888, 01/09/2026, NÃO reabrir sem novo pedido
 * explícito): `/diaria-clarice-envio` deve crescer 10% de um dia pro outro
 * SEMPRE, independente da taxa de spam, que também não pode mais bloquear o
 * envio (a metade do freio — `decideBrake` acima — já foi entregue pelo item
 * 2 da #6793; esta constante entrega a outra metade, o PASSO).
 *
 * Substitui a escalada adaptativa por folga do #4705 (histórico:
 * `MAX_DAILY_STEP=0.25 × (1 − maxUtil/HOLD_UTIL)`, zerando em
 * `maxUtil >= HOLD_UTIL` — zona de atenção — OU em `sufficientData: false` —
 * nenhum envio na janela de 30 dias; ver `git log --all --grep=6888` pra
 * reverter). Os dois caminhos que hoje zeravam o passo passam a devolver 10%
 * também, sem exceção — é justamente o que o editor pediu ("crescer sempre").
 *
 * TRADE-OFF que o editor aceitou, avisado explicitamente antes da execução
 * (issue #6888, tabela "estado × passo"): **10% é MENOR que o teto anterior
 * de 25%.** Em dia saudável (risco praticamente zero) isso DESACELERA o
 * crescimento pela metade — de propósito: o pedido não era "crescer mais", é
 * "crescer sempre, a uma taxa previsível". Só nos dois estados que hoje
 * congelavam (zona de atenção, sem dado suficiente) o passo fixo cresce MAIS
 * que o adaptativo (que dava 0 nos dois).
 */
export const FIXED_DAILY_STEP = 0.1;

/**
 * Passo de crescimento do dia. Incondicional desde #6888 — sempre
 * `FIXED_DAILY_STEP`, nunca consulta risco.
 *
 * SEM PARÂMETROS de propósito (#6958, achado do type-design-analyzer): até
 * aqui a assinatura mantinha `accelRisk`/`spam`/`t` ignorados, justificando
 * isso como "barato reverter" — mas a reversão barata deste repo pra esta
 * classe de decisão já É o git history (o parágrafo acima manda rodar `git
 * log --all --grep=6888`; o próprio #6888 aposentou `MAX_DAILY_STEP` de vez,
 * sem guardá-la "por via das dúvidas"). Único call site
 * (`scripts/clarice-envio-risk.ts`) — dropar os 3 parâmetros é 1 linha, não
 * migração. Se algum dia isto voltar a consultar risco, a assinatura muda
 * de novo então; até lá, `()` é o sinal honesto de que não há entrada.
 */
export function adaptiveStep(): number {
  return FIXED_DAILY_STEP;
}

// ---------------------------------------------------------------------------
// 5. Volume proposto — freio, depois passo, depois os tetos REAIS
// ---------------------------------------------------------------------------

export interface NextVolumeInput {
  /**
   * Volume do ÚLTIMO DIA ENVIADO (não um reset, não uma média) — a rampa
   * escala dali. Ver `baseVolumeFromLastSendDay` (weekly-plan.ts), que soma as
   * células A/B/C do último dia; pegar só uma célula subestimaria a base em ~⅓.
   */
  readonly baseVolume: number;
  /** Passo do dia (`adaptiveStep`). */
  readonly step: number;
  /** Freio do dia (`decideBrake().level`). */
  readonly brake: BrakeLevel;
  /** Contatos elegíveis e ainda não comprometidos (fila de 1º envio). */
  readonly queueAvailable: number;
  /**
   * Crédito Brevo restante no ciclo. `null` = NÃO CONSULTADO, não limita
   * (fail-OPEN — a única exceção no módulo à disciplina fail-CLOSED do
   * resto: `queueAvailable`/`baseVolume` inválidos sempre viram 0, nunca
   * "sem limite". Deliberado: falhar fechado aqui faria uma falha de rede ao
   * consultar crédito abortar a onda inteira por padrão; o call site que
   * genuinamente não consultou crédito (ex: `BREVO_CLARICE_API_KEY`
   * ausente) decide, não este motor). `0` é diferente de `null` — `0` É um
   * teto real (crédito esgotado), sempre limita.
   */
  readonly creditAvailable: number | null;
}

export interface NextVolumeDecision {
  readonly volume: number;
  /**
   * O que DETERMINOU o número final — cada valor é um caso distinto, NUNCA
   * colapsado (achado do type-design-analyzer no review da PR: um `"brake"`
   * único para `stop` E `hold` obrigava quem consumisse só `cappedBy` a
   * fazer `note.includes("cancelar")` pra saber qual dos dois era — prosa
   * substring-matched em vez de tipo):
   * - `"stop"`: freio `stop` — volume 0, cancelar onda já agendada;
   * - `"hold"`: freio `hold` — repetiu a base, sem escalar;
   * - `"step"`: caminho normal — o passo fixo (`FIXED_DAILY_STEP`, #6888) definiu o volume;
   * - `"queue"` / `"credit"`: a fila ou o crédito cortaram abaixo do proposto
   *   (quando os DOIS cortam, `cappedBy` é o ÚLTIMO a agir — `"credit"`, já
   *   que crédito é checado depois da fila — mas `note` sempre registra os
   *   dois cortes em ordem, nunca só o último; ver teste "queue E credit
   *   cortam juntos");
   * - `null`: não havia base pra escalar (`baseVolume ≤ 0`).
   */
  readonly cappedBy: "stop" | "hold" | "queue" | "credit" | "step" | null;
  readonly note: string;
}

/** Normaliza um teto: não-finito ou negativo vira 0 (fail-closed). */
function normalizeCap(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Volume da próxima onda. Ordem: freio → passo → tetos REAIS.
 *
 * NÃO EXISTE TETO ABSOLUTO DE VOLUME (decisão do editor, #4705): o que limita é
 * a fila (quantos contatos elegíveis ainda não receberam), o crédito Brevo, e o
 * freio. Um número mágico do tipo "no máximo 5.000/dia" seria uma segunda
 * catraca, agora fixa — o mesmo erro do `openRate` no semáforo, com outra roupa.
 *
 * `baseVolume ≤ 0` (ou não-finito) devolve 0 com nota explicando — nunca `NaN`,
 * porque um `NaN` aqui vira `scheduledAt` de campanha real e só é descoberto
 * depois do disparo.
 */
export function proposeNextVolume(input: NextVolumeInput): NextVolumeDecision {
  const { brake } = input;
  const base = Number.isFinite(input.baseVolume) ? Math.floor(input.baseVolume) : 0;
  const step = Number.isFinite(input.step) ? Math.max(0, input.step) : 0;
  const queue = normalizeCap(input.queueAvailable);
  const hasCredit = input.creditAvailable !== null && input.creditAvailable !== undefined;
  const credit = hasCredit ? normalizeCap(input.creditAvailable as number) : null;

  if (base <= 0) {
    return {
      volume: 0,
      cappedBy: null,
      note: `Sem volume-base do último dia enviado (recebido: ${input.baseVolume}) — nada pra escalar. Definir volume explícito antes de agendar.`,
    };
  }

  if (brake === "stop") {
    return {
      volume: 0,
      cappedBy: "stop",
      note: "Freio em STOP (risco de ISP no limiar ou acima) — não agendar; cancelar onda já agendada.",
    };
  }

  let volume: number;
  let cappedBy: NextVolumeDecision["cappedBy"];
  let note: string;

  if (brake === "hold") {
    volume = base;
    cappedBy = "hold";
    note = `Freio em HOLD — repete o volume do último dia (${base}) sem escalar.`;
  } else {
    volume = Math.round(base * (1 + step));
    cappedBy = "step";
    note = `Base ${base} × (1 + ${step.toFixed(4).replace(".", ",")}) = ${volume}.`;
  }

  if (queue < volume) {
    note += ` Limitado pela fila de 1º envio (${queue} disponíveis, proposto ${volume}).`;
    volume = queue;
    cappedBy = "queue";
  }

  if (credit !== null && credit < volume) {
    note += ` Limitado pelo crédito Brevo (${credit} restantes, proposto ${volume}).`;
    volume = credit;
    cappedBy = "credit";
  }

  if (credit === null) note += " Crédito Brevo não consultado — não limitou.";

  return { volume, cappedBy, note };
}

// ---------------------------------------------------------------------------
// 6. Sunset de não-abridores
// ---------------------------------------------------------------------------

/**
 * Decide se um contato sai da elegibilidade por SUNSET: já recebeu ≥2 envios e
 * nunca abriu nenhum.
 *
 * A #4430 propôs isso e foi fechada sem implementação. Decisão do editor no
 * #4705: cortar de vez — fechada pelo #5041, que ligou esta função em
 * `classifyEligibility` (clarice-db.ts, corte `sunset_non_opener`). Até lá o
 * não-abridor reincidente voltava pra fila a cada onda;
 * `measureNonOpenerExposure` (clarice-wave-plan.ts) segue existindo pós-#5041
 * como canário operacional — deve tender a 0 num store recém-recomputado.
 *
 * O porquê é o LAÇO DE REALIMENTAÇÃO, não a métrica de abertura: quem recebe e
 * nunca abre é o candidato natural a marcar spam; o spam sobe; o spam é uma das
 * 4 métricas que FREIAM o volume (`decideBrake`); o alcance cai. O motor come o
 * próprio alcance alimentando um público que nunca leu. Cortar aqui é o que
 * permite tirar abertura do freio sem ficar cego — a abertura deixa de frear
 * TODO MUNDO e passa a desqualificar INDIVIDUALMENTE quem de fato não lê.
 *
 * Cuidado do call site (#4688): só aplicar a contatos com abertura JÁ MEDIDA
 * (`hasMeasuredOpens`, clarice-segment.ts). Um contato nunca sincronizado tem
 * `opens_count = 0` pelo `DEFAULT 0` do schema, não por comportamento — sem
 * esse guard o sunset cortaria gente que nunca foi medida. Esta função é pura e
 * só olha os dois contadores: o guard de "foi medido?" mora no filtro de quem
 * chega aqui, de propósito (mantém a regra testável sem arrastar `StoreRow`).
 *
 * `sendsCount`/`opensCount` corrompidos (`NaN`/`undefined`/infinito) NUNCA
 * decidem sunset (Finding 3 do silent-failure-hunter no review da PR): a
 * versão anterior tratava `sendsCount` corrompido como `0` (mantém — lado
 * seguro) mas `opensCount` corrompido TAMBÉM como `0` (sunset se
 * `sendsCount ≥ 2` — lado ERRADO: "não sei quantas aberturas teve" virava
 * "confirmado que nunca abriu", cortando de vez um assinante real por dado
 * ruim). Sunset é permanente ("cortar de vez", não um hold reversível) — o
 * único lado seguro pra dado corrompido é NUNCA cortar. */
export function shouldSunsetNonOpener(c: { sendsCount: number; opensCount: number }): boolean {
  if (!Number.isFinite(c.sendsCount) || !Number.isFinite(c.opensCount)) return false;
  const sends = c.sendsCount;
  const opens = c.opensCount;
  return sends >= 2 && opens <= 0;
}

// ---------------------------------------------------------------------------
// 7. Tendência de abertura — SÓ RELATÓRIO
// ---------------------------------------------------------------------------

export interface OpenRateTrendPoint {
  /** Dia-calendário BRT (`YYYY-MM-DD`) — ver `brtDayKey`. */
  readonly dayKey: string;
  readonly delivered: number;
  readonly uniqueViews: number;
}

/**
 * Resultado SÓ-RELATÓRIO — deliberadamente um tipo SEM NENHUMA semelhança
 * estrutural com `RiskMetrics`/`BrakeDecision` (nenhum campo em comum além de
 * nomes genéricos como `current`), então nada aqui passaria despercebido se
 * alguém tentasse enfiar isto em `decideBrake`/`adaptiveStep` — o TypeScript
 * recusaria pela forma, não só pela convenção documentada 3× no módulo.
 */
export interface OpenRateTrendResult {
  /** Abertura % ponderada por `delivered` da metade MAIS RECENTE da janela. */
  readonly current: number;
  /** Idem, da metade MAIS ANTIGA. */
  readonly previous: number;
  /** `current − previous`, em PONTOS PERCENTUAIS. */
  readonly deltaPp: number;
  readonly verdict: "estavel" | "queda" | "alta";
  /** Dias com `delivered > 0` de fato usados na comparação. */
  readonly sampleDays: number;
}

/** Queda relevante: −5 pontos percentuais entre as metades da janela. */
export const OPEN_TREND_DROP_PP = -5;
/** Alta relevante: +5 pontos percentuais. */
export const OPEN_TREND_RISE_PP = 5;
/** Mínimo de dias úteis (2 por metade) pra sequer comparar as metades. */
export const OPEN_TREND_MIN_DAYS = 4;

function weightedOpenRatePct(points: OpenRateTrendPoint[]): { rate: number; delivered: number } {
  let delivered = 0;
  let views = 0;
  for (const p of points) {
    delivered += p.delivered;
    views += p.uniqueViews;
  }
  return { rate: delivered > 0 ? (views / delivered) * 100 : 0, delivered };
}

/**
 * Tendência de abertura na janela de `SEND_WINDOWS.trendDays` (60 dias):
 * compara a metade MAIS RECENTE contra a MAIS ANTIGA, cada uma ponderada por
 * `delivered` (dia grande pesa mais que dia pequeno — média de médias mentiria).
 *
 * **ISTO NUNCA ENTRA EM `decideBrake` NEM EM `adaptiveStep`.** É a decisão 1 do
 * editor no #4705, e é o núcleo da issue: a base de 1º envio é ~96% fria e abre
 * ~1%; usar abertura como freio produziu a catraca 10.014 → 322 → 1.053 → 817.
 * A abertura continua sendo informação valiosa — sobre CONTEÚDO e sobre a
 * qualidade das safras que estão entrando — só não é mais autorizada a cortar
 * volume. Quem cuida de abertura no nível do INDIVÍDUO é
 * `shouldSunsetNonOpener`, não um corte coletivo de 30%.
 *
 * Dias sem `delivered` são descartados (não carregam sinal e distorceriam a
 * divisão das metades). Com número ímpar de dias úteis, o dia do MEIO é
 * descartado — nunca contado nas duas metades, o que inflaria artificialmente a
 * estabilidade.
 *
 * Amostra insuficiente (`< OPEN_TREND_MIN_DAYS` dias úteis, ou uma das metades
 * sem `delivered`) devolve `deltaPp: 0` / `verdict: "estavel"` com
 * `previous === current`: sem base pra comparação, o relatório NUNCA afirma
 * queda nem alta. `sampleDays` é o campo que denuncia a amostra curta.
 */
export function openRateTrend(
  points: OpenRateTrendPoint[],
  opts: { minDays?: number; dropPp?: number; risePp?: number } = {},
): OpenRateTrendResult {
  const minDays = opts.minDays ?? OPEN_TREND_MIN_DAYS;
  const dropPp = opts.dropPp ?? OPEN_TREND_DROP_PP;
  const risePp = opts.risePp ?? OPEN_TREND_RISE_PP;

  const usable = points
    .filter(
      (p) =>
        Number.isFinite(p.delivered) &&
        p.delivered > 0 &&
        Number.isFinite(p.uniqueViews) &&
        p.uniqueViews >= 0,
    )
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const sampleDays = usable.length;
  const overall = weightedOpenRatePct(usable).rate;

  if (sampleDays < minDays) {
    return { current: overall, previous: overall, deltaPp: 0, verdict: "estavel", sampleDays };
  }

  const half = Math.floor(sampleDays / 2);
  const older = usable.slice(0, half);
  const recent = usable.slice(sampleDays - half);

  const prev = weightedOpenRatePct(older);
  const curr = weightedOpenRatePct(recent);
  if (prev.delivered <= 0 || curr.delivered <= 0) {
    return { current: overall, previous: overall, deltaPp: 0, verdict: "estavel", sampleDays };
  }

  const deltaPp = curr.rate - prev.rate;
  const verdict: OpenRateTrendResult["verdict"] =
    deltaPp <= dropPp ? "queda" : deltaPp >= risePp ? "alta" : "estavel";

  return { current: curr.rate, previous: prev.rate, deltaPp, verdict, sampleDays };
}

// ---------------------------------------------------------------------------
// 8. Seleção de janela — dias DE ENVIO vs dias CORRIDOS
// ---------------------------------------------------------------------------

/** Entrada estrutural mínima de uma campanha; `BrevoCampaign` satisfaz. */
export interface SendDayLike {
  sentDate: string | null;
}

/**
 * Chave de dia-calendário BRT (`YYYY-MM-DD`) de um timestamp de envio.
 *
 * Mesma fórmula de `brtDayKey` em `workers/brevo-dashboard/src/weekly-plan.ts`
 * (`toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })`) —
 * reimplementada aqui, e não importada, por 2 motivos: a do worker é privada
 * (não exportada) e `groupByBrtDay`, que a expõe indiretamente, é tipada em
 * `BrevoCampaign` — o que impediria a assinatura genérica que este módulo
 * precisa. `test/clarice-envio-policy.test.ts` TRAVA a paridade comparando o
 * agrupamento das duas implementações sobre as mesmas campanhas; divergir
 * quebra o teste.
 */
export function brtDayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Agrupa por dia-calendário BRT. Sem `sentDate` válido = fora de todo grupo. */
export function groupByBrtDay<T extends SendDayLike>(campaigns: T[]): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const c of campaigns) {
    const day = brtDayKey(c.sentDate);
    if (!day) continue;
    const arr = byDay.get(day);
    if (arr) arr.push(c);
    else byDay.set(day, [c]);
  }
  return byDay;
}

/** `YYYY-MM-DD` deslocado em N dias (aritmética UTC pura, sem ICU). */
function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * JANELA DO FREIO — as campanhas dos últimos `opts.days` **DIAS DE ENVIO**
 * (dias-calendário BRT em que houve envio), não as N campanhas mais recentes.
 *
 * A distinção não é cosmética: um dia de teste A/B/C são 3 campanhas do MESMO
 * dia. "Últimas 3 campanhas" seria 1 único dia de envio disfarçado de 3 —
 * amostra 3× menor que a pretendida bem no cálculo que decide frear. Mesmo
 * critério (e mesmo motivo) do `HEALTH_SAMPLE_DAYS` do worker.
 *
 * Envio com data no FUTURO é excluído (campanha agendada que vazou pro array):
 * métrica de risco de e-mail que ainda não saiu é sempre zero, e incluir isso
 * DILUIRIA a janela — um `hold`/`stop` legítimo viraria `ok` por diluição.
 *
 * Diferente do worker, aqui NÃO há filtro de maturação de 48h: bounce e unsub
 * já estão finais em ~T+13h, e esperar 48h pra reagir a um pico de hard bounce
 * é reagir depois que o ISP já reagiu. Maturação de 48h existia por causa da
 * ABERTURA, que saiu do freio (#4705).
 */
export function selectLastSendDays<T extends SendDayLike>(
  campaigns: T[],
  now: Date,
  opts: { days: number },
): T[] {
  const days = opts.days;
  if (!Number.isInteger(days) || days <= 0) return [];
  const nowMs = now.getTime();

  const past = campaigns.filter((c) => {
    const ms = c.sentDate ? Date.parse(c.sentDate) : NaN;
    return Number.isFinite(ms) && ms <= nowMs;
  });

  const byDay = groupByBrtDay(past);
  const topDays = new Set(
    [...byDay.keys()].sort((a, b) => b.localeCompare(a)).slice(0, days),
  );

  return past.filter((c) => {
    const day = brtDayKey(c.sentDate);
    return day !== null && topDays.has(day);
  });
}

/**
 * JANELA DO ACELERADOR (30d) E DA TENDÊNCIA (60d) — dias CORRIDOS, não dias de
 * envio.
 *
 * Aqui a semântica correta é oposta à de `selectLastSendDays`: acelerar é
 * apostar em reputação SUSTENTADA NO TEMPO. Se o projeto ficou 3 semanas sem
 * enviar, "os últimos 30 dias de envio" abrangeriam meses de histórico e
 * afirmariam uma estabilidade que o calendário não sustenta — enquanto "os
 * últimos 30 dias corridos" corretamente mostram pouca ou nenhuma amostra
 * recente, e o motor não acelera sobre passado distante.
 *
 * `opts.byCalendarDay` alterna a fronteira:
 * - `false` (default): janela ROLANTE de `days × 24h` a partir de `now`;
 * - `true`: dias-calendário BRT — de hoje até `days - 1` dias atrás, inclusive.
 *   Use quando a janela precisar casar exatamente com as chaves de
 *   `OpenRateTrendPoint.dayKey` (relatório por dia).
 *
 * Futuro excluído nos dois modos, pelo mesmo motivo de `selectLastSendDays`.
 */
export function selectWithinDays<T extends SendDayLike>(
  campaigns: T[],
  now: Date,
  opts: { days: number; byCalendarDay?: boolean },
): T[] {
  const days = opts.days;
  if (!Number.isInteger(days) || days <= 0) return [];
  const nowMs = now.getTime();

  if (opts.byCalendarDay) {
    const todayKey = brtDayKey(now.toISOString());
    if (!todayKey) return [];
    const cutoffKey = shiftDayKey(todayKey, -(days - 1));
    return campaigns.filter((c) => {
      const ms = c.sentDate ? Date.parse(c.sentDate) : NaN;
      if (!Number.isFinite(ms) || ms > nowMs) return false;
      const day = brtDayKey(c.sentDate);
      return day !== null && day >= cutoffKey && day <= todayKey;
    });
  }

  const cutoffMs = nowMs - days * 86_400_000;
  return campaigns.filter((c) => {
    const ms = c.sentDate ? Date.parse(c.sentDate) : NaN;
    return Number.isFinite(ms) && ms <= nowMs && ms >= cutoffMs;
  });
}
