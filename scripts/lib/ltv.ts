/**
 * scripts/lib/ltv.ts (#8423)
 *
 * Núcleo PURO do LTV de caixa e das métricas de valor (ARPU, churn,
 * conversão em apoiador, LTV÷CAC) — mesmo par canônico já usado no repo:
 * `buildCacReport` (puro, `cac.ts`) × `scripts/cac-report.ts` (I/O), ou
 * `scripts/lib/metrics/registry.ts` (puro) × `scripts/studio-ui/studio-
 * metrics.ts` (I/O). Nenhuma função deste módulo lê disco/rede — os
 * chamadores (`scripts/studio-ui/studio-metrics.ts`, `scripts/cac-
 * report.ts`) resolvem os insumos (cache da apoia.se, snapshots Beehiiv,
 * `data/analysis/descadastrados-manuais-2607.json`, config do valor
 * mensal da Amazon) e injetam aqui já resolvidos.
 *
 * ## Origem (#8423)
 *
 * O LTV foi calculado à mão em sessão de 19/09/2026 (comentário/corpo da
 * issue #8423) — sem registro, o número se perde e ninguém recalcula
 * quando a coorte do teste 2608 amadurecer. Este módulo formaliza a MESMA
 * metodologia (não uma nova) — os números de referência da issue servem
 * de sanity check, não de meta a bater exatamente (o tempo passou, a base
 * mudou).
 *
 * ## Decisões do editor que fixam a definição (citadas na issue)
 *
 * Receita BRUTA, só CAIXA (sem valor indireto de indicação/parceria),
 * Clarice não paga (receita zero), uso principal = teto de CAC (nunca
 * gate de gasto — não reabre o teto revogado em #5235/#5236).
 *
 * ## Fórmula — LTV de caixa (blended)
 *
 * `LTV = ARPU_mensal × min(1/churn_mensal, horizonteMeses)`. O horizonte
 * (default `LTV_DEFAULT_HORIZON_MONTHS` = 24) trunca a vida útil esperada
 * porque só há ~12 meses de história — extrapolar além disso é chute, não
 * projeção (nota da issue). Churn tem DUAS leituras (`computeChurnRate`):
 * orgânica (exclui saídas de limpeza manual conhecida) e "com limpeza"
 * (inclui todas as saídas) — `computeLtvCaixaFaixa` usa as duas pra
 * devolver uma FAIXA nunca um ponto único (churn maior = vida útil menor =
 * LTV menor, então "com limpeza" é o piso da faixa e "orgânico" é o teto).
 *
 * ## Fórmula — LTV por origem (cohort)
 *
 * Não usa churn (a coorte é jovem demais pra medir retenção própria, ver
 * "Armadilhas" da issue) — usa a leitura bottom-up da própria issue:
 * `LTV_origem = (conversaoApoiador × valorMedioApoiadorMensal +
 * outrasFontesPerAtivoMensal) × horizonteMeses`. Verificação com os
 * números da issue (coorte fria/paga): `(0,5% × R$20 + R$50/628) × 18 ≈
 * R$3/ativo` — bate com o "~R$3/ativo" citado.
 *
 * ## Nunca fabricar zero (regra do projeto, #7182/#7229/#7198)
 *
 * Toda função aqui devolve `valor: null` (nunca `0`) quando um insumo
 * necessário está ausente — `motivo` sempre explica por quê. Amostra
 * pequena (`amostra minúscula` — a issue cita 21-23 apoiadores, onde 1 a
 * mais/menos move a taxa em dezenas de %) nunca vira um número seco: sai
 * com `qualidadeAmostra: "pequena"` e o `n` visível ao lado.
 */

import { BRT_TIMEZONE, datePartsInTz } from "./next-edition-date.ts";
import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Horizonte default de LTV, em meses — só há ~12 meses de história
 *  (medição de 19/09/2026); extrapolar além disso é chute (nota da issue
 *  #8423). Tunável por chamador para recalcular com outro teto. */
// Medição de 19/09/2026 (data da issue #8423) — "só ~12 meses de história"
// é uma leitura datada, não um fato perene; revisar o horizonte quando a
// história acumulada crescer o bastante pra sustentar um teto maior.
export const LTV_DEFAULT_HORIZON_MONTHS = 24;

/** Piso de amostra abaixo do qual uma taxa de conversão em apoiador não é
 *  "seca" — mesmo piso de `DOI_CONFIRMACAO_MIN_N` em `registry.ts` (n<5,
 *  1 caso a mais/menos move a taxa em dezenas de %, nota da issue). */
export const CONVERSAO_APOIADOR_MIN_N = 5;

// ---------------------------------------------------------------------------
// ARPU
// ---------------------------------------------------------------------------

export interface ArpuInput {
  /** Receita bruta mensal por fonte (BRL) — `null` EXPLÍCITO quando a
   *  fonte não tem dado confiável pro período (cache congelado no dia 1º,
   *  #4490; fonte nunca consultada). NUNCA `0` fabricado por ausência. */
  revenueBySource: Readonly<Record<string, number | null>>;
  /** Base ativa do período — denominador. `null`/`<=0` faz a métrica cair
   *  em `indeterminado`. */
  activeBase: number | null;
}

export interface ArpuResult {
  /** BRL/ativo/mês. `null` quando `activeBase` é inválido OU nenhuma fonte
   *  tem dado no período. */
  valor: number | null;
  /** Soma das fontes COM dado — `null` quando nenhuma fonte tem dado. */
  totalRevenueBrl: number | null;
  fontesComDado: readonly string[];
  /** Fonte(s) sem dado no período — presença aqui rebaixa o resultado a
   *  PISO (subestimativa), nunca invalida o cálculo por completo enquanto
   *  ao menos 1 fonte tiver dado. */
  fontesSemDado: readonly string[];
  motivo: string | null;
}

export interface RevenueSourcesSummary {
  /** Soma das fontes COM dado — `null` quando nenhuma fonte tem dado. */
  totalRevenueBrl: number | null;
  fontesComDado: readonly string[];
  fontesSemDado: readonly string[];
}

/** Soma bruta por fonte, sem dividir por base — núcleo compartilhado por
 *  `computeArpu` (que divide) e pelo `MetricDef` `receita-mensal` (que só
 *  soma). Fonte com valor `null` NUNCA entra na soma como `0`. @pure */
export function sumRevenueBySource(revenueBySource: Readonly<Record<string, number | null>>): RevenueSourcesSummary {
  const fontesComDado: string[] = [];
  const fontesSemDado: string[] = [];
  let total = 0;
  for (const [fonte, valor] of Object.entries(revenueBySource)) {
    if (valor == null) {
      fontesSemDado.push(fonte);
    } else {
      fontesComDado.push(fonte);
      total += valor;
    }
  }
  return { totalRevenueBrl: fontesComDado.length > 0 ? total : null, fontesComDado, fontesSemDado };
}

/** @pure */
export function computeArpu(input: ArpuInput): ArpuResult {
  const { totalRevenueBrl, fontesComDado, fontesSemDado } = sumRevenueBySource(input.revenueBySource);
  const total = totalRevenueBrl ?? 0;

  if (input.activeBase == null || input.activeBase <= 0) {
    return {
      valor: null,
      totalRevenueBrl: fontesComDado.length > 0 ? total : null,
      fontesComDado,
      fontesSemDado,
      motivo: `base ativa ausente ou <= 0 (${String(input.activeBase)})`,
    };
  }

  if (fontesComDado.length === 0) {
    return {
      valor: null,
      totalRevenueBrl: null,
      fontesComDado,
      fontesSemDado,
      motivo: `nenhuma fonte de receita com dado no período (${fontesSemDado.join(", ") || "nenhuma fonte declarada"})`,
    };
  }

  return {
    valor: total / input.activeBase,
    totalRevenueBrl: total,
    fontesComDado,
    fontesSemDado,
    motivo:
      fontesSemDado.length > 0
        ? `PISO — fonte(s) sem dado no período, excluída(s) da soma: ${fontesSemDado.join(", ")}`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Churn
// ---------------------------------------------------------------------------

export interface ChurnExitEvent {
  /** E-mail normalizado (trim + lowercase) — mesma disciplina de
   *  `normalizeEmail` em `cac.ts`/`apoia-se.ts`. */
  email: string;
}

export interface ChurnRateInput {
  /** TODAS as saídas observadas no período — inclui as de limpeza manual. */
  exits: readonly ChurnExitEvent[];
  /** E-mails normalizados conhecidos como limpeza manual do editor — NUNCA
   *  desinteresse orgânico do leitor (ex: `data/analysis/descadastrados-
   *  manuais-2607.json`, ver `curated-batch-import.ts`). Saída cujo e-mail
   *  está neste set é excluída do churn ORGÂNICO mas conta no churn "com
   *  limpeza". */
  manualCleanupEmails: ReadonlySet<string>;
  /** Duração do período observado, em meses (pode ser fracionário — ex:
   *  30 dias entre 2 snapshots ≈ 1 mês). */
  periodMonths: number;
  /** Base ativa média do período — denominador de ambas as leituras. */
  avgActiveBase: number | null;
}

/** Par "ambos ou nenhum" — orgânico e com-limpeza só existem juntos (#8968,
 *  mesmo idioma de `MetricLimites` em `scripts/lib/metrics/registry.ts`). */
export interface ChurnRateMonthly {
  /** Saídas ÷ período ÷ base, EXCLUINDO limpeza manual conhecida —
   *  desinteresse "puro" do leitor. */
  organico: number;
  /** Mesma razão, mas INCLUINDO todas as saídas (mesmo as de limpeza
   *  manual) — sempre >= `organico`. */
  comLimpeza: number;
}

export interface ChurnRateResult {
  /** `null` quando `avgActiveBase`/`periodMonths` são inválidos ou o churn é
   *  implausível — caso contrário sempre as duas leituras juntas. */
  monthly: ChurnRateMonthly | null;
  totalExits: number;
  manualCleanupExits: number;
  organicExits: number;
  periodMonths: number;
  avgActiveBase: number | null;
  motivo: string | null;
}

/** @pure */
export function computeChurnRate(input: ChurnRateInput): ChurnRateResult {
  const manualCleanupExits = input.exits.filter((e) => input.manualCleanupEmails.has(e.email)).length;
  const totalExits = input.exits.length;
  const organicExits = totalExits - manualCleanupExits;

  if (input.avgActiveBase == null || input.avgActiveBase <= 0 || !(input.periodMonths > 0)) {
    return {
      monthly: null,
      totalExits,
      manualCleanupExits,
      organicExits,
      periodMonths: input.periodMonths,
      avgActiveBase: input.avgActiveBase,
      motivo: `base ativa média ou duração do período inválida (avgActiveBase=${String(input.avgActiveBase)}, periodMonths=${input.periodMonths})`,
    };
  }

  const denom = input.avgActiveBase * input.periodMonths;
  const organicMonthly = organicExits / denom;
  const comLimpezaMonthly = totalExits / denom;

  // Churn > 100%/mês não é um dado real (nem toda a base sai num mês) — é
  // sintoma de snapshot suspeito (base ativa mal medida, diff entre
  // snapshots incomparáveis, etc). Nunca reportado como número seco: cai em
  // indeterminado com motivo explícito (#8423 fleet review item 6).
  if (organicMonthly > 1 || comLimpezaMonthly > 1) {
    return {
      monthly: null,
      totalExits,
      manualCleanupExits,
      organicExits,
      periodMonths: input.periodMonths,
      avgActiveBase: input.avgActiveBase,
      motivo: `churn implausível (>100%/mês) — snapshot suspeito (organico=${(organicMonthly * 100).toFixed(1)}%, com_limpeza=${(comLimpezaMonthly * 100).toFixed(1)}%)`,
    };
  }

  return {
    monthly: { organico: organicMonthly, comLimpeza: comLimpezaMonthly },
    totalExits,
    manualCleanupExits,
    organicExits,
    periodMonths: input.periodMonths,
    avgActiveBase: input.avgActiveBase,
    motivo: null,
  };
}

// ---------------------------------------------------------------------------
// LTV de caixa (blended) — ARPU × vida útil truncada no horizonte
// ---------------------------------------------------------------------------

export interface LtvCaixaInput {
  arpuMonthlyBrl: number | null;
  churnMonthly: number | null;
  horizonMonths: number;
}

export interface LtvCaixaResult {
  /** BRL/ativo — `null` quando ARPU ou churn são indisponíveis. */
  valor: number | null;
  /** Meses de vida útil esperada usados no cálculo (`min(1/churn,
   *  horizonMonths)`), já truncados — `null` quando `valor` é `null`. */
  vidaUtilEsperadaMeses: number | null;
  horizonMonths: number;
  motivo: string | null;
}

/** @pure */
export function computeLtvCaixa(input: LtvCaixaInput): LtvCaixaResult {
  if (input.arpuMonthlyBrl == null) {
    return { valor: null, vidaUtilEsperadaMeses: null, horizonMonths: input.horizonMonths, motivo: "ARPU mensal indisponível" };
  }
  if (input.churnMonthly == null) {
    return { valor: null, vidaUtilEsperadaMeses: null, horizonMonths: input.horizonMonths, motivo: "churn mensal indisponível" };
  }
  if (input.churnMonthly <= 0) {
    // Churn zero/negativo não vira vida útil infinita — trunca no
    // horizonte (mesma disciplina de "nunca extrapolar além do que os
    // dados sustentam").
    const vidaUtil = input.horizonMonths;
    return {
      valor: input.arpuMonthlyBrl * vidaUtil,
      vidaUtilEsperadaMeses: vidaUtil,
      horizonMonths: input.horizonMonths,
      motivo: `churn <= 0 (${input.churnMonthly}) — vida útil truncada no horizonte de ${input.horizonMonths} meses, nunca tratada como infinita`,
    };
  }
  const vidaUtilBruta = 1 / input.churnMonthly;
  const vidaUtil = Math.min(vidaUtilBruta, input.horizonMonths);
  const truncado = vidaUtilBruta > input.horizonMonths;
  return {
    valor: input.arpuMonthlyBrl * vidaUtil,
    vidaUtilEsperadaMeses: vidaUtil,
    horizonMonths: input.horizonMonths,
    motivo: truncado
      ? `vida útil bruta de ${vidaUtilBruta.toFixed(1)} meses truncada no horizonte de ${input.horizonMonths} meses (só há história recente o bastante pra sustentar o horizonte, não a vida útil bruta)`
      : null,
  };
}

export interface LtvCaixaFaixaInput {
  arpuMonthlyBrl: number | null;
  churnOrganicoMonthly: number | null;
  churnComLimpezaMonthly: number | null;
  horizonMonths: number;
}

export interface LtvCaixaFaixaResult {
  /** `null` quando não computável — caso contrário `min` (piso, churn "com
   *  limpeza", vida útil menor) e `max` (teto, churn orgânico, vida útil
   *  maior, sujeita ao mesmo truncamento de horizonte) sempre juntos, mesmo
   *  idioma de `MetricLimites` em `scripts/lib/metrics/registry.ts` (#8968). */
  faixa: { min: number; max: number } | null;
  motivo: string | null;
}

/**
 * LTV de caixa como FAIXA (nunca um ponto único) — usa as duas leituras de
 * churn de `computeChurnRate`. Churn "com limpeza" é sempre >= orgânico,
 * então produz o PISO da faixa (vida útil menor); churn orgânico produz o
 * TETO (vida útil maior, mesmo truncamento de horizonte). @pure
 */
export function computeLtvCaixaFaixa(input: LtvCaixaFaixaInput): LtvCaixaFaixaResult {
  const min = computeLtvCaixa({
    arpuMonthlyBrl: input.arpuMonthlyBrl,
    churnMonthly: input.churnComLimpezaMonthly,
    horizonMonths: input.horizonMonths,
  });
  const max = computeLtvCaixa({
    arpuMonthlyBrl: input.arpuMonthlyBrl,
    churnMonthly: input.churnOrganicoMonthly,
    horizonMonths: input.horizonMonths,
  });
  if (min.valor == null || max.valor == null) {
    return { faixa: null, motivo: min.motivo ?? max.motivo ?? "faixa indisponível" };
  }
  return { faixa: { min: min.valor, max: max.valor }, motivo: null };
}

// ---------------------------------------------------------------------------
// Conversão em apoiador
// ---------------------------------------------------------------------------

export interface ConversaoApoiadorInput {
  /** Contagem de apoiadores confirmados no grupo. */
  apoiadores: number;
  /** Denominador — assinantes confirmados no grupo (ver `definicao` da
   *  métrica no registry pra deixar o denominador nomeado). */
  confirmados: number;
  /** Piso de amostra abaixo do qual a taxa é "pequena" (nunca escondida,
   *  só marcada) — default `CONVERSAO_APOIADOR_MIN_N`. */
  minN?: number;
}

export interface ConversaoApoiadorResult {
  /** Razão 0..1 — `null` quando `confirmados <= 0`. */
  valor: number | null;
  /** Tamanho da amostra usado pra decidir `qualidadeAmostra` — a contagem
   *  de apoiadores (numerador), não o denominador: é o numerador pequeno
   *  que faz 1 caso a mais/menos mover a taxa em dezenas de % (nota da
   *  issue). */
  n: number;
  qualidadeAmostra: "ok" | "pequena";
  motivo: string | null;
}

/** @pure */
export function computeConversaoApoiador(input: ConversaoApoiadorInput): ConversaoApoiadorResult {
  const minN = input.minN ?? CONVERSAO_APOIADOR_MIN_N;
  if (input.confirmados <= 0) {
    return { valor: null, n: input.apoiadores, qualidadeAmostra: "pequena", motivo: "denominador (confirmados) é zero" };
  }
  const valor = input.apoiadores / input.confirmados;
  const qualidadeAmostra: "ok" | "pequena" = input.apoiadores < minN ? "pequena" : "ok";
  return {
    valor,
    n: input.apoiadores,
    qualidadeAmostra,
    motivo:
      qualidadeAmostra === "pequena"
        ? `amostra de apoiadores pequena (n=${input.apoiadores} < ${minN}) — 1 caso a mais/menos move a taxa em dezenas de %`
        : null,
  };
}

// ---------------------------------------------------------------------------
// LTV por origem (cohort) — bottom-up: conversão × ticket, sem churn
// ---------------------------------------------------------------------------

export interface LtvPorOrigemInput {
  /** Taxa de conversão em apoiador desta origem/classe (razão 0..1) —
   *  `null` quando não observável (`computeConversaoApoiador` com
   *  denominador zero). */
  conversaoApoiador: number | null;
  /** Valor médio mensal pago por um apoiador CONVERTIDO desta origem (BRL/
   *  mês) — `null` quando não há apoiador pagante confirmado pra tirar
   *  média (nunca `0` fabricado — ver docstring de `apoiador-link.ts`
   *  sobre `currentMonthlyValue` `null`). */
  valorMedioApoiadorMensal: number | null;
  /** Receita mensal de fontes SEM vínculo por conversão (ex: Amazon —
   *  não tem "apoiador" identificável), já dividida pela base ativa TOTAL
   *  (não só desta origem — a issue trata Amazon como não-alocável por
   *  canal, distribuída igualmente). `null`/ausente é tratado como 0 (a
   *  fonte simplesmente não contribui pra este componente), nunca faz a
   *  métrica inteira cair em indeterminado — a conversão em apoiador é o
   *  insumo que manda aqui. */
  outrasFontesPerAtivoMensal?: number | null;
  horizonMonths: number;
}

export interface LtvPorOrigemResult {
  /** BRL/ativo desta origem — `null` quando conversão ou valor médio são
   *  indisponíveis. */
  valor: number | null;
  horizonMonths: number;
  motivo: string | null;
}

/** @pure */
export function computeLtvPorOrigem(input: LtvPorOrigemInput): LtvPorOrigemResult {
  if (input.conversaoApoiador == null) {
    return { valor: null, horizonMonths: input.horizonMonths, motivo: "conversão em apoiador indisponível pra esta origem" };
  }
  if (input.valorMedioApoiadorMensal == null) {
    return {
      valor: null,
      horizonMonths: input.horizonMonths,
      motivo: "valor médio mensal do apoiador indisponível pra esta origem (nenhum apoiador pagante confirmado)",
    };
  }
  const outrasFontes = input.outrasFontesPerAtivoMensal ?? 0;
  const expectedMonthlyPerActive = input.conversaoApoiador * input.valorMedioApoiadorMensal + outrasFontes;
  return { valor: expectedMonthlyPerActive * input.horizonMonths, horizonMonths: input.horizonMonths, motivo: null };
}

// ---------------------------------------------------------------------------
// LTV ÷ CAC
// ---------------------------------------------------------------------------

export interface LtvCacRatioInput {
  ltvBrl: number | null;
  /** Custo por leitor/cadastro do canal (CAC) — denominador. */
  custoPorLeitorBrl: number | null;
}

export interface LtvCacRatioResult {
  /** `null` quando LTV ou CAC são indisponíveis, ou CAC <= 0 (razão contra
   *  custo zero/negativo não é "infinitamente eficiente", é sem dado). */
  valor: number | null;
  motivo: string | null;
}

/** @pure */
export function computeLtvCacRatio(input: LtvCacRatioInput): LtvCacRatioResult {
  if (input.ltvBrl == null) return { valor: null, motivo: "LTV indisponível" };
  if (input.custoPorLeitorBrl == null) return { valor: null, motivo: "custo por leitor (CAC) indisponível" };
  if (input.custoPorLeitorBrl <= 0) {
    return { valor: null, motivo: `custo por leitor <= 0 (${input.custoPorLeitorBrl}) — razão indefinida, nunca "infinita"` };
  }
  return { valor: input.ltvBrl / input.custoPorLeitorBrl, motivo: null };
}

// ---------------------------------------------------------------------------
// apoia.se — agregação de receita a partir do cache por mês-competência
// ---------------------------------------------------------------------------

/** Mesmo shape de `Record<string, BackerStatus>` (`apoia-se.ts`) — não
 *  importa o tipo de lá pra manter este módulo sem qualquer dependência de
 *  I/O (nem indireta via import de um módulo que faz fetch). */
export interface ApoiaSeMonthCacheEntry {
  isBacker: boolean;
  isPaidThisMonth: boolean;
  thisMonthPaidValue?: number;
}

export interface ApoiaSeMonthRevenueSummary {
  /** Soma de `thisMonthPaidValue` entre quem tem `isPaidThisMonth: true` E
   *  `thisMonthPaidValue` numérico — entradas `isPaidThisMonth: true` SEM
   *  valor não entram aqui (ver `paidWithoutValueCount`, #8423 fleet review
   *  item 5 — nunca fabricar R$0 pra quem pagou mas cujo valor não veio). */
  grossRevenueBrl: number;
  /** Contagem de pagantes este mês COM valor confirmado (n do valor médio
   *  abaixo) — exclui `paidWithoutValueCount`. */
  payingBackersCount: number;
  /** Contagem de `isBacker: true`, pagante ou não. */
  totalBackersCount: number;
  /** `grossRevenueBrl / payingBackersCount` — `null` quando não há
   *  pagante nenhum (nunca `0`/`NaN`). */
  avgPaidValueBrl: number | null;
  /** Contagem de entradas `isPaidThisMonth: true` mas SEM `thisMonthPaidValue`
   *  numérico — inconsistência de dado da apoia.se (paga mas sem valor
   *  reportado). Excluídas de `grossRevenueBrl`/`payingBackersCount` (nunca
   *  contadas como R$0 pagante); o caller deve citar esta contagem no motivo
   *  quando > 0. */
  paidWithoutValueCount: number;
}

// ---------------------------------------------------------------------------
// Amazon — config manual (sem fonte automatizada, #8423)
// ---------------------------------------------------------------------------

export interface AmazonRevenueConfig {
  /** BRL/mês — constante informada pelo editor (nunca derivada). */
  valorMensalBrl: number;
  /** ISO 8601 — quando o editor atualizou este número pela última vez,
   *  visível no painel (nunca um valor "mudo" sem data ao lado). */
  atualizadoEm: string;
}

/**
 * Parse PURO do config manual da receita Amazon (ex:
 * `data/ltv/amazon-revenue.json`, editor edita à mão — a issue #8423 é
 * explícita: "não hardcode", "config ou arquivo em data/, com data de
 * atualização visível no painel"). `null` quando o shape não bate — NUNCA
 * lança, nunca fabrica um valor (o chamador trata `null` como "fonte sem
 * dado", mesma disciplina do resto do módulo). @pure
 */
export function parseAmazonRevenueConfig(raw: unknown): AmazonRevenueConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.valorMensalBrl !== "number" || !Number.isFinite(obj.valorMensalBrl)) return null;
  if (typeof obj.atualizadoEm !== "string" || obj.atualizadoEm.trim() === "") return null;
  return { valorMensalBrl: obj.valorMensalBrl, atualizadoEm: obj.atualizadoEm };
}

/** @pure */
export function summarizeApoiaSeMonthRevenue(
  cache: Readonly<Record<string, ApoiaSeMonthCacheEntry>>,
): ApoiaSeMonthRevenueSummary {
  let grossRevenueBrl = 0;
  let payingBackersCount = 0;
  let totalBackersCount = 0;
  let paidWithoutValueCount = 0;
  for (const entry of Object.values(cache)) {
    if (entry.isBacker) totalBackersCount++;
    if (entry.isPaidThisMonth) {
      if (typeof entry.thisMonthPaidValue === "number") {
        payingBackersCount++;
        grossRevenueBrl += entry.thisMonthPaidValue;
      } else {
        // Paga mas sem valor reportado — inconsistência de dado, nunca
        // contada como R$0 pagante (#8423 fleet review item 5).
        paidWithoutValueCount++;
      }
    }
  }
  return {
    grossRevenueBrl,
    payingBackersCount,
    totalBackersCount,
    avgPaidValueBrl: payingBackersCount > 0 ? grossRevenueBrl / payingBackersCount : null,
    paidWithoutValueCount,
  };
}

// ---------------------------------------------------------------------------
// Janela de competência + diff de snapshots — compartilhado por
// `scripts/studio-ui/studio-metrics.ts` e `scripts/cac-report.ts` (#8423)
// ---------------------------------------------------------------------------

/**
 * Nome da campanha apoia.se pra LEITURA do cache já gravado (nunca lança
 * por env ausente — diferente de `readApoiaSeEnv`, que EXIGE as 3 env vars
 * pra ESCREVER/consultar a API ao vivo). A apoia.se hoje só tem a campanha
 * "diaria" (docstring de `apoia-se.ts`, `defaultCacheDir`) — mesmo default
 * de fallback. `env` injetável (default `process.env`), mesmo padrão de
 * `resolveKitConfig`. @pure o suficiente pra teste (leitura de env, não de
 * disco/rede).
 */
export function resolveApoiaSeCampaignName(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = (env.APOIA_SE_CAMPAIGN ?? "").trim();
  return raw || "diaria";
}

/** Não reimporta `competenceMonth`/`readApoiaSeEnv` de `apoia-se.ts`
 *  (evitaria puxar `RateLimiter`/fetch pra dentro deste módulo puro) — usa
 *  direto `datePartsInTz` (`next-edition-date.ts`, sem import de rede),
 *  MESMA fórmula (ano/mês BRT). @pure */
function competenceMonthBrt(now: Date): string {
  const { year, month } = datePartsInTz(now, BRT_TIMEZONE);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Mês de competência (BRT) FECHADO anterior ao corrente — o mês corrente
 * pode estar incompleto/congelado perto da virada (cache da apoia.se,
 * #4490), então "Valor" sempre lê o mês anterior, nunca o corrente. @pure
 */
export function previousCompetenceMonth(now: Date): string {
  const current = competenceMonthBrt(now);
  const [y, m] = current.split("-").map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

/**
 * Escolhe, entre `dates` (qualquer ordem), a data mais próxima de
 * `targetDays` ANTES de `latestDate` — baseline do diff de churn. Exige
 * pelo menos `minDays` de distância (default 14) pra não medir "churn"
 * sobre um período curto demais pra ser mensal. `null` quando nenhuma data
 * serve (só 1 snapshot, ou todos os outros snapshots grudados no mais
 * recente). @pure
 */
export function findChurnBaselineDate(
  dates: readonly string[],
  latestDate: string,
  targetDays = 30,
  minDays = 14,
): string | null {
  const latestMs = Date.parse(latestDate);
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const d of dates) {
    if (d === latestDate) continue;
    const diffDays = (latestMs - Date.parse(d)) / 86_400_000;
    if (!(diffDays >= minDays)) continue; // precisa vir ANTES, com folga mínima
    const diff = Math.abs(diffDays - targetDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}

/** Mesma disciplina de `normalizeEmail` (`cac.ts`/`apoia-se.ts`) —
 *  reimplementada aqui (não importada de `cac.ts`) porque a cadeia de
 *  import de `cac.ts` carrega `cohort-engagement.ts`, que tem
 *  `import "dotenv/config"` como efeito colateral — poluiria
 *  `process.env` só por importar este módulo PURO (mesmo cuidado já
 *  documentado em `acquisition-class.ts`). @pure */
function normalizeEmailLocal(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Diff de 2 snapshots Beehiiv (por e-mail normalizado) — quem estava
 * `active` no baseline e não está `active` (ou sumiu) no mais recente é
 * uma saída. `avgActiveBase` = média das 2 contagens ativas (denominador
 * do churn). @pure
 */
export function computeChurnExitsBetweenSnapshots(
  baselineSubs: readonly Pick<BeehiivBackupSubscriber, "email" | "status">[],
  latestSubs: readonly Pick<BeehiivBackupSubscriber, "email" | "status">[],
): { exits: ChurnExitEvent[]; avgActiveBase: number } {
  const baselineActive = new Set<string>();
  for (const s of baselineSubs) if (s.status === "active") baselineActive.add(normalizeEmailLocal(s.email));
  const latestActive = new Set<string>();
  for (const s of latestSubs) if (s.status === "active") latestActive.add(normalizeEmailLocal(s.email));
  const exits: ChurnExitEvent[] = [];
  for (const email of baselineActive) {
    if (!latestActive.has(email)) exits.push({ email });
  }
  return { exits, avgActiveBase: (baselineActive.size + latestActive.size) / 2 };
}
