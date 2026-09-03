/**
 * scripts/lib/metrics/registry.ts (#7172, fatias 3 e 4 — #7175, #7176)
 *
 * A definição operacional de cada métrica do negócio, num lugar só, legível
 * por máquina. Fonte única que #7177 (metas), #7178 (painel) e #7180
 * (alarme) consomem — nenhum redefine fórmula.
 *
 * ## `MetricDef` — o contrato (#7175)
 *
 * Resolve a colisão medida no repo: CTR significa clique ÷ ABERTURA em
 * `scripts/build-link-ctr.ts` e clique ÷ RECEBIDAS em `leitor-v1`
 * (`scripts/lib/leitor.ts`) — mesma palavra, ~7× de diferença. Toda métrica
 * de razão/percentual declara o denominador na própria `definicao`
 * (`assertRegistryValido` recusa quem não o fizer).
 *
 * ## Módulo SEM I/O
 *
 * Nenhuma função deste arquivo lê disco, SQLite ou rede. Todo insumo entra
 * por `args.deps` — os leitores concretos (store do #6464, snapshot Beehiiv,
 * chamada viva do Kit) moram no CHAMADOR (scripts/metrics-*.ts, a rota do
 * Studio de #7178), nunca aqui. É o mesmo par canônico já usado no repo:
 * `buildCacReport` (puro) × `scripts/cac-report.ts` (I/O), ou
 * `scripts/lib/acquisition-health.ts` (puro) × `scripts/check-acquisition-health.ts`
 * (I/O). Sem essa separação, testar as métricas exigiria mock de rede.
 *
 * ## O ponto central desta fatia (leia antes de tocar em qualquer métrica)
 *
 * `subscription` — a dimensão do store do #6464 que carrega `entered_at` e
 * a atribuição do cadastro — está POPULADA NO CÓDIGO (#7229) mas o store
 * REAL ainda não foi reingerido: hoje ela tem zero (ou poucas) linhas. Uma
 * métrica que dependa dela e devolva `0` quando a dimensão está vazia
 * recria, no lugar mais visível do produto, o mesmo defeito que #7182/#7229/
 * #7198 corrigiram em outras camadas nesta mesma rodada: "zero por dado
 * ausente é indistinguível de zero legítimo, e nada no resultado sinaliza".
 *
 * Por isso `MetricResult.qualidade` é obrigatório e `MetricResult.motivo` é
 * obrigatório (e não-vazio) sempre que `valor === null` ou
 * `qualidade !== 'exato'`. Métrica cujo insumo não existe, ou cuja cobertura
 * está baixa demais para confiar (`subscriptionCoverageLow`/
 * `subscriptions_coverage_low`/`subscription_data_coverage_low` do
 * #7229/#7198), devolve `valor: null` + `qualidade: 'indeterminado'` +
 * `motivo` — NUNCA `0` com `qualidade: 'exato'`.
 *
 * ## As 8 métricas (#7176) + 2 de ativação por coorte (#7183)
 *
 * `cadastros-dia`, `cadastros-nao-pago-nao-reativacao-dia` (o placar da meta
 * de 5/dia), `cadastros-organicos-dia` (orgânico estrito, saúde própria),
 * `cadastros-indeterminados-dia` (barra de erro do placar),
 * `doi-confirmacao-dia`, `doi-orfaos`, `base-ativa`, `leitor-v1`,
 * `abertura-1a-edicao`, `primeiro-clique-14d` (#7183 — ativação de latência
 * curta por safra de cadastro, ver `ativacao-coorte.ts`).
 *
 * `doi-confirmacao-dia` devolve SEMPRE `indeterminado` nesta fatia — os 3
 * acréscimos de que ela depende (`EVENT_TYPES` ganhar `"confirm"`, o estado
 * de CRIAÇÃO preservado em `subscription`, a participação no form
 * `KIT_DOI_FORM_ID` capturada) não existem ainda em `EVENT_TYPES`
 * (`scripts/lib/diaria-subscribers-db.ts`) nem em F2 — declarado como
 * dependência dura da própria issue #7176, não uma lacuna desta
 * implementação.
 *
 * ## Fronteira `scripts/lib/` (#2747)
 *
 * `scripts/lib/metrics/` é um domínio NOVO — `test/lib-boundary.test.ts`
 * ganhou a entrada `metrics` (mesma regra de `shared/`: não importa de
 * `diaria/` nem `mensal/`, cruzamento só via `shared/`).
 */

import {
  classifyAcquisition,
  type AcquisitionClass,
  type AcquisitionClassInput,
} from "./acquisition-class.ts";
import {
  computeAberturaPrimeiraEdicao,
  computePrimeiroClique14d,
  applyCrossPlatformFloor,
  type AtivacaoCoorteSubscriberInput,
  type AtivacaoCoorteResult,
} from "./ativacao-coorte.ts";
import { hasCaptureOnDay, type CapturaLogEntry } from "./captura-log.ts";
import { filterInternalAndTestSubscribers } from "../cac.ts";
import {
  summarizeLeitores,
  LEITOR_V1_THRESHOLDS,
  MISSING_STATS_WARN_FRACTION,
  type BeehiivSubscriberStatsShape,
} from "../leitor.ts";
import {
  findKitDoiOrphans,
  ORPHAN_THRESHOLD_HOURS,
  type KitDoiOrphan,
} from "../kit-doi-orphan-guard.ts";
import type { KitSubscriberSummary } from "../kit-subscribers.ts";
import { isMainModule } from "../cli-args.ts";

// ---------------------------------------------------------------------------
// O contrato (#7175)
// ---------------------------------------------------------------------------

/**
 * `todos` é somatório declarado, nunca um 5º produto. Não existe valor
 * `vigilia` — Vigil.ia.br é a organização guarda-chuva
 * (`docs/lean-canvas-vigil-ia.md`), não um produto; tratá-la como um faria a
 * soma por produto contar duas vezes.
 */
export type Produto = "diaria" | "clarice" | "apoio" | "cursos-livros" | "todos";

export type Etapa = "aquisicao" | "ativacao" | "retencao" | "receita" | "indicacao" | "saude";

/** `percentual` é 0..100 e renderiza com `%`; `razao` é 0..1 e renderiza sem
 *  `%` — a escolha é pela RENDERIZAÇÃO, não pelo gosto. */
export type Unidade = "contagem" | "percentual" | "brl" | "dias" | "razao";

/** `neutro` para decomposição pura, onde "melhor" não significa nada. */
export type Direcao = "maior-melhor" | "menor-melhor" | "neutro";

export type Qualidade = "exato" | "piso" | "faixa" | "indeterminado";

/** `de`/`ate` em `AAAA-MM-DD`, INCLUSIVOS, fronteira de dia em BRT (decisão
 *  do épico #7172 — BRT move 1-2 cadastros/dia, 20-40% de uma meta de 5). */
export interface Janela {
  de: string;
  ate: string;
  granularidade: "dia" | "semana" | "mes";
  fuso: "BRT";
}

export interface MetricLimites {
  min: number;
  max: number;
}

export interface MetricSeriesPoint {
  chave: string;
  valor: number | null;
}

export interface MetricResult {
  valor: number | null;
  janela: Janela;
  /** ISO 8601 de quando o insumo foi coletado. `null` quando não houve
   *  coleta (`qualidade: 'indeterminado'` por falta de captura). */
  frescor: string | null;
  qualidade: Qualidade;
  /** Obrigatório e NÃO-VAZIO sempre que `valor === null` ou
   *  `qualidade !== 'exato'`. */
  motivo: string | null;
  /** Presente só quando `qualidade === 'faixa'`. */
  limites?: MetricLimites;
  /** Presente quando `args.decomposicao` foi pedida e é válida. */
  series?: MetricSeriesPoint[];
}

export type MetricDeps = Record<string, unknown>;

export interface MetricComputeArgs<D extends MetricDeps = MetricDeps> {
  janela: Janela;
  decomposicao?: string;
  deps: D;
}

export interface MetricDef<D extends MetricDeps = MetricDeps> {
  id: string;
  nome: string;
  produto: Produto;
  etapa: Etapa;
  /** A fórmula em TEXTO, sem ambiguidade — o painel exibe isto junto do
   *  número. Métrica de razão/percentual DECLARA o denominador no texto
   *  (a colisão de CTR é o caso vivo que motivou esta exigência). */
  definicao: string;
  unidade: Unidade;
  direcao: Direcao;
  /** De onde o dado vem — path/endpoint concreto. */
  fonte: string;
  /** As dimensões em que a métrica pode ser destrinchada. */
  decomposicoes: readonly string[];
  computar(args: MetricComputeArgs<D>): Promise<MetricResult>;
}

// ---------------------------------------------------------------------------
// Guard de validade — mesmo padrão de assertValidChannelKeySpecs (cac.ts)
// ---------------------------------------------------------------------------

const RAZAO_UNIDADES: readonly Unidade[] = ["razao", "percentual"];

function definitionNamesDenominator(definicao: string): boolean {
  // Exige que ALGO seja nomeado como denominador (`denominador = ...`),
  // não só a substring "denominador" em qualquer lugar do texto — um texto
  // que literalmente NEGA ter denominador claro ("sem denominador
  // definido") continha a substring e passava no guard sem nomear nada.
  return /denominador\s*=/i.test(definicao);
}

/**
 * Lança se algum `MetricDef` do array estiver malformado — `id` vazio ou
 * duplicado, `definicao` vazia, ou métrica de razão/percentual cuja
 * `definicao` não nomeia o denominador. Roda sobre `METRICAS` no load do
 * módulo (aceita array como parâmetro pelo mesmo motivo de
 * `assertValidChannelKeySpecs(specs)`: testável com fixture inválida sem
 * quebrar o import do módulo real).
 */
export function assertRegistryValido(metrics: readonly MetricDef[] = METRICAS): void {
  const seen = new Set<string>();
  for (const m of metrics) {
    if (!m.id || !m.id.trim()) {
      throw new Error("[metrics/registry] métrica com id vazio");
    }
    if (seen.has(m.id)) {
      throw new Error(`[metrics/registry] id duplicado: "${m.id}"`);
    }
    seen.add(m.id);
    if (!m.definicao || !m.definicao.trim()) {
      throw new Error(`[metrics/registry] "${m.id}": definicao vazia`);
    }
    if (RAZAO_UNIDADES.includes(m.unidade) && !definitionNamesDenominator(m.definicao)) {
      throw new Error(
        `[metrics/registry] "${m.id}": métrica ${m.unidade} precisa nomear o denominador na definicao`,
      );
    }
    const decompSeen = new Set<string>();
    for (const key of m.decomposicoes) {
      if (!key || !key.trim()) {
        throw new Error(`[metrics/registry] "${m.id}": decomposicao vazia declarada`);
      }
      if (decompSeen.has(key)) {
        throw new Error(`[metrics/registry] "${m.id}": decomposicao "${key}" declarada duas vezes`);
      }
      decompSeen.add(key);
    }
  }
}

/** Lança se `decomposicao` for pedida mas não estiver em `def.decomposicoes`
 *  — "erro em tempo de carga", nunca resultado agregado silenciosamente. */
export function validarDecomposicao(def: Pick<MetricDef, "id" | "decomposicoes">, decomposicao: string | undefined): void {
  if (decomposicao === undefined) return;
  if (!def.decomposicoes.includes(decomposicao)) {
    throw new Error(
      `[metrics/registry] "${def.id}": decomposicao "${decomposicao}" não declarada — válidas: ${def.decomposicoes.join(", ") || "(nenhuma)"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Superfície de consumo
// ---------------------------------------------------------------------------

export function getMetric(id: string): MetricDef | undefined {
  return METRICAS.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// Helpers de resultado
// ---------------------------------------------------------------------------

function indeterminado(janela: Janela, motivo: string, frescor: string | null = null): MetricResult {
  return { valor: null, janela, frescor, qualidade: "indeterminado", motivo };
}

function exato(valor: number, janela: Janela, frescor: string | null, series?: MetricSeriesPoint[]): MetricResult {
  return { valor, janela, frescor, qualidade: "exato", motivo: null, ...(series ? { series } : {}) };
}

function faixa(min: number, max: number, janela: Janela, frescor: string | null, motivo: string): MetricResult {
  return { valor: min, janela, frescor, qualidade: "faixa", motivo, limites: { min, max } };
}

function piso(valor: number, janela: Janela, frescor: string | null, motivo: string): MetricResult {
  return { valor, janela, frescor, qualidade: "piso", motivo };
}

// ---------------------------------------------------------------------------
// Fuso/dia — enumeração AAAA-MM-DD inclusiva (strings já em BRT)
// ---------------------------------------------------------------------------

function addDaysToYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** @pure */
export function enumerarDiasInclusive(de: string, ate: string): string[] {
  const dias: string[] = [];
  let cur = de;
  let guard = 0;
  while (cur <= ate && guard < 10000) {
    dias.push(cur);
    cur = addDaysToYmd(cur, 1);
    guard++;
  }
  return dias;
}

function latestCapturedAtForDays(entries: readonly CapturaLogEntry[], dias: readonly string[]): string | null {
  let latest: string | null = null;
  const diaSet = new Set(dias);
  for (const e of entries) {
    const day = e.captured_at.slice(0, 10);
    if (!diaSet.has(day)) continue;
    if (!latest || e.captured_at > latest) latest = e.captured_at;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Aquisição — 4 métricas compartilham a mesma agregação (#7176)
// ---------------------------------------------------------------------------

/** Import em massa vindo da Beehiiv (24/08/2026, 590 de 649 registros do
 *  Kit) — excluído de propósito, nunca contado como cadastro do dia. */
export const KIT_IMPORT_DAY = "2026-08-24";

/** Piso da série instrumentada do Kit — antes disso a fonte é o snapshot
 *  Beehiiv (F7, fora desta fatia). Documentado no `motivo`, não um filtro
 *  silencioso: o CHAMADOR decide quais registros passa para `registros()`. */
export const KIT_SERIES_FLOOR = "2026-08-25";

export interface AcquisitionRecordInput {
  email: string;
  /** Dia BRT (`AAAA-MM-DD`) já resolvido pelo chamador — `brtDayKey`
   *  (`clarice-envio-policy.ts`) ou `unixSecondsToBrtDate`
   *  (`beehiiv-publish-date.ts`), nunca `toISOString().slice(0,10)`. */
  dia: string;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_channel?: string | null;
  referring_site?: string | null;
  /** Epoch em segundos — exigido por `classifyAcquisition` (specs
   *  `ambigua: true` precisam da data pra respeitar a janela). */
  created: number;
}

export interface AcquisitionMetricDeps extends MetricDeps {
  /** Registros do(s) dia(s) pedidos — o chamador resolve a fonte (store do
   *  #6464 via F2, snapshot Beehiiv, leitura viva do Kit). SEM I/O aqui. */
  registros(janela: Janela): AcquisitionRecordInput[] | Promise<AcquisitionRecordInput[]>;
  /** Linhas de `data/metrics/captura-log.jsonl` (F2) — usadas só para
   *  decidir INDETERMINADO por dia sem coleta, nunca para contar cadastro. */
  capturaLog: readonly CapturaLogEntry[];
  /** `true` quando a dimensão `subscription` do store está pouco populada
   *  demais para confiar (`subscriptions_coverage_low`/
   *  `subscription_data_coverage_low`, #7229/#7198). Vem do CHAMADOR — este
   *  módulo nunca infere cobertura sozinho, só reage ao sinal. */
  subscriptionCoverageLow?: boolean;
  subscriptionCoverageMotivo?: string;
}

interface AcquisitionAggregate {
  total: number;
  porClasse: Record<AcquisitionClass, number>;
  frescor: string | null;
}

/** Núcleo compartilhado pelas 4 métricas de aquisição: 2 exclusões (email +
 *  dia de import em massa) + classificação via `classifyAcquisition`. Nunca
 *  por subtração — é exatamente o erro que F1 existe para impedir. */
async function aggregateAcquisition(
  janela: Janela,
  deps: AcquisitionMetricDeps,
): Promise<{ aggregate: AcquisitionAggregate } | { indeterminado: MetricResult }> {
  const dias = enumerarDiasInclusive(janela.de, janela.ate);
  const diasFaltando = dias.filter((d) => !hasCaptureOnDay(deps.capturaLog, d));
  if (diasFaltando.length > 0) {
    return {
      indeterminado: indeterminado(janela, `sem coleta em ${diasFaltando.join(", ")}`),
    };
  }
  if (deps.subscriptionCoverageLow) {
    return {
      indeterminado: indeterminado(
        janela,
        deps.subscriptionCoverageMotivo ??
          "dimensão subscription do store pouco populada (subscriptionCoverageLow) — cadastros não confiáveis",
      ),
    };
  }
  const raw = await deps.registros(janela);
  const { kept } = filterInternalAndTestSubscribers(raw);
  const filtered = kept.filter((r) => r.dia !== KIT_IMPORT_DAY);
  const porClasse: Record<AcquisitionClass, number> = {
    pago: 0,
    reativacao: 0,
    iniciativa: 0,
    organico: 0,
    indeterminado: 0,
  };
  for (const r of filtered) {
    const input: AcquisitionClassInput = {
      utm_source: r.utm_source,
      utm_medium: r.utm_medium,
      utm_channel: r.utm_channel,
      referring_site: r.referring_site,
      created: r.created,
    };
    porClasse[classifyAcquisition(input)]++;
  }
  return {
    aggregate: { total: filtered.length, porClasse, frescor: latestCapturedAtForDays(deps.capturaLog, dias) },
  };
}

function classeSeries(porClasse: Record<AcquisitionClass, number>): MetricSeriesPoint[] {
  return (Object.keys(porClasse) as AcquisitionClass[]).map((chave) => ({ chave, valor: porClasse[chave] }));
}

const cadastrosDiaDef: MetricDef<AcquisitionMetricDeps> = {
  id: "cadastros-dia",
  nome: "Cadastros por dia",
  produto: "diaria",
  etapa: "aquisicao",
  definicao:
    "COUNT(DISTINCT assinante) com created_at no dia D em BRT, excluindo conta interna/teste " +
    "(filterInternalAndTestSubscribers) e excluindo created_at no dia " +
    KIT_IMPORT_DAY +
    " BRT (import em massa vindo da Beehiiv). Série instrumentada do Kit começa em " +
    KIT_SERIES_FLOOR +
    " — dias anteriores vêm do snapshot Beehiiv (F7, fora desta fatia); o CHAMADOR decide quais " +
    "registros passa para registros(), este texto só documenta o piso, nunca filtra sozinho. " +
    "decomposicao 'classe' devolve as 5 classes de #7173.",
  unidade: "contagem",
  direcao: "maior-melhor",
  fonte: "store do #6464 (data/diaria-subscribers/diaria-subscribers.db, subscriber/subscription) + data/metrics/captura-log.jsonl (F2)",
  decomposicoes: ["classe"],
  async computar(args) {
    validarDecomposicao(cadastrosDiaDef, args.decomposicao);
    const result = await aggregateAcquisition(args.janela, args.deps);
    if ("indeterminado" in result) return result.indeterminado;
    const { total, porClasse, frescor } = result.aggregate;
    if (args.decomposicao === "classe") {
      return exato(total, args.janela, frescor, classeSeries(porClasse));
    }
    return exato(total, args.janela, frescor);
  },
};

const cadastrosNaoPagoNaoReativacaoDiaDef: MetricDef<AcquisitionMetricDeps> = {
  id: "cadastros-nao-pago-nao-reativacao-dia",
  nome: "Placar da meta de ativação (não-pago e não-reativação)",
  produto: "diaria",
  etapa: "aquisicao",
  definicao:
    "cadastros-dia restrito às classes organico + iniciativa de #7173 (o placar da meta de 5/dia). " +
    "Piso = organico + iniciativa; teto = piso + indeterminado do dia (não distribuído entre classes). " +
    "Nunca por subtração do total.",
  unidade: "contagem",
  direcao: "maior-melhor",
  fonte: "mesma fonte de cadastros-dia",
  decomposicoes: [],
  async computar(args) {
    validarDecomposicao(cadastrosNaoPagoNaoReativacaoDiaDef, args.decomposicao);
    const result = await aggregateAcquisition(args.janela, args.deps);
    if ("indeterminado" in result) return result.indeterminado;
    const { porClasse, frescor } = result.aggregate;
    const min = porClasse.organico + porClasse.iniciativa;
    const max = min + porClasse.indeterminado;
    return faixa(
      min,
      max,
      args.janela,
      frescor,
      "faixa: piso = organico+iniciativa; teto soma os cadastros indeterminados do período, nunca distribuídos entre classes",
    );
  },
};

const cadastrosOrganicosDiaDef: MetricDef<AcquisitionMetricDeps> = {
  id: "cadastros-organicos-dia",
  nome: "Cadastros orgânicos (estrito)",
  produto: "diaria",
  etapa: "aquisicao",
  definicao:
    "cadastros-dia restrito à classe organico ESTRITA de #7173 (SEO, direct atribuível, social orgânico " +
    "recorrente, indicação de leitor) — métrica de saúde de descoberta pura, exibida ao lado do placar, " +
    "nunca no lugar dele. Piso = organico; teto = organico + indeterminado do período.",
  unidade: "contagem",
  direcao: "maior-melhor",
  fonte: "mesma fonte de cadastros-dia",
  decomposicoes: [],
  async computar(args) {
    validarDecomposicao(cadastrosOrganicosDiaDef, args.decomposicao);
    const result = await aggregateAcquisition(args.janela, args.deps);
    if ("indeterminado" in result) return result.indeterminado;
    const { porClasse, frescor } = result.aggregate;
    const min = porClasse.organico;
    const max = min + porClasse.indeterminado;
    return faixa(
      min,
      max,
      args.janela,
      frescor,
      "faixa: piso = organico estrito; teto soma os cadastros indeterminados do período",
    );
  },
};

const cadastrosIndeterminadosDiaDef: MetricDef<AcquisitionMetricDeps> = {
  id: "cadastros-indeterminados-dia",
  nome: "Fração de cadastros indeterminados",
  produto: "diaria",
  etapa: "aquisicao",
  definicao:
    "razão: cadastros classificados 'indeterminado' por #7173 ÷ cadastros-dia (denominador = cadastros-dia, " +
    "já com as 2 exclusões aplicadas) — a barra de erro do placar da meta, sempre exibida ao lado dele.",
  unidade: "razao",
  direcao: "menor-melhor",
  fonte: "mesma fonte de cadastros-dia",
  decomposicoes: [],
  async computar(args) {
    validarDecomposicao(cadastrosIndeterminadosDiaDef, args.decomposicao);
    const result = await aggregateAcquisition(args.janela, args.deps);
    if ("indeterminado" in result) return result.indeterminado;
    const { total, porClasse, frescor } = result.aggregate;
    if (total <= 0) return exato(0, args.janela, frescor);
    return exato(porClasse.indeterminado / total, args.janela, frescor);
  },
};

// ---------------------------------------------------------------------------
// doi-confirmacao-dia — SEMPRE indeterminado nesta fatia (dependência dura)
// ---------------------------------------------------------------------------

const doiConfirmacaoDiaDef: MetricDef<MetricDeps> = {
  id: "doi-confirmacao-dia",
  nome: "Taxa de confirmação do double opt-in",
  produto: "diaria",
  etapa: "ativacao",
  definicao:
    "razão: quantos da safra de D (created com state inactive vinculado ao form KIT_DOI_FORM_ID) " +
    "registraram confirmação até a maturação de 48h ÷ tamanho da safra (denominador = safra do dia D, " +
    "fixado na criação, nunca encolhe). Nunca renderiza com n<5.",
  unidade: "razao",
  direcao: "maior-melhor",
  fonte: "listAllFormSubscribers(KIT_DOI_FORM_ID) cruzado com subscription.entered_at + evento de confirmação",
  decomposicoes: [],
  async computar(args) {
    validarDecomposicao(doiConfirmacaoDiaDef, args.decomposicao);
    // Dependência dura declarada em #7176: EVENT_TYPES ainda não tem
    // "confirm", subscription não preserva o estado de CRIAÇÃO (status é
    // sobrescrito por ON CONFLICT DO UPDATE), e F2 não captura participação
    // no form KIT_DOI_FORM_ID. Os 3 acréscimos são de F2, não desta fatia —
    // enquanto não existirem, esta métrica nunca calcula uma taxa.
    return indeterminado(
      args.janela,
      "F2 ainda não grava confirmação de DOI (EVENT_TYPES sem 'confirm', subscription não preserva estado de criação, participação no form KIT_DOI_FORM_ID não capturada)",
    );
  },
};

// ---------------------------------------------------------------------------
// doi-orfaos — reusa findKitDoiOrphans, zero reimplementação do predicado
// ---------------------------------------------------------------------------

export interface DoiOrfaosDeps extends MetricDeps {
  inactiveSubscribers: readonly Pick<KitSubscriberSummary, "id" | "email_address" | "state" | "created_at">[];
  formSubscriberIds: ReadonlySet<number>;
  /** ISO 8601 — instante da checagem, injetável para teste determinístico. */
  now: string;
}

const doiOrfaosDef: MetricDef<DoiOrfaosDeps> = {
  id: "doi-orfaos",
  nome: "Órfãos do double opt-in",
  produto: "diaria",
  etapa: "ativacao",
  definicao:
    `Kit subscribers em state='inactive' com created_at com idade >= ${ORPHAN_THRESHOLD_HOURS}h e ausentes ` +
    "do form KIT_DOI_FORM_ID (findKitDoiOrphans) — perda de ativação por defeito, nunca somada a desinteresse.",
  unidade: "contagem",
  direcao: "menor-melhor",
  fonte: "listAllKitSubscribers({status:'inactive'}) + listAllFormSubscribers(doiFormId, {status:'all'})",
  decomposicoes: [],
  async computar(args) {
    validarDecomposicao(doiOrfaosDef, args.decomposicao);
    const now = new Date(args.deps.now);
    if (Number.isNaN(now.getTime())) {
      return indeterminado(args.janela, `deps.now inválido: "${args.deps.now}"`);
    }
    const orphans: KitDoiOrphan[] = findKitDoiOrphans(args.deps.inactiveSubscribers, args.deps.formSubscriberIds, now);
    return exato(orphans.length, args.janela, args.deps.now);
  },
};

// ---------------------------------------------------------------------------
// base-ativa
// ---------------------------------------------------------------------------

export interface BaseAtivaDeps extends MetricDeps {
  /** Snapshot mais recente da Beehiiv (`data/beehiiv-backup/{data}/`),
   *  `null` quando não há nenhum. */
  beehiiv: { date: string; active: number } | null;
  /** Contagem viva do Kit (`state='active'`), `null` quando indisponível. */
  kitActive: number | null;
  /** `AAAA-MM-DD` BRT — "hoje" injetado pelo chamador (testável). */
  hoje: string;
}

const baseAtivaDef: MetricDef<BaseAtivaDeps> = {
  id: "base-ativa",
  nome: "Base ativa",
  produto: "diaria",
  etapa: "saude",
  definicao:
    "Beehiiv: COUNT(status='active') no snapshot mais recente (frescor = data do snapshot). " +
    "Kit: COUNT(state='active') via leitura viva — enum diferente, predicado NÃO compartilhado com Beehiiv. " +
    "decomposicao 'plataforma' devolve as duas separadas.",
  unidade: "contagem",
  direcao: "maior-melhor",
  fonte: "data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl + leitura viva do Kit",
  decomposicoes: ["plataforma"],
  async computar(args) {
    validarDecomposicao(baseAtivaDef, args.decomposicao);
    const { beehiiv, kitActive, hoje } = args.deps;
    if (beehiiv === null && kitActive === null) {
      return indeterminado(args.janela, "nenhum snapshot Beehiiv nem leitura Kit disponível");
    }
    const total = (beehiiv?.active ?? 0) + (kitActive ?? 0);
    const series: MetricSeriesPoint[] | undefined =
      args.decomposicao === "plataforma"
        ? [
            { chave: "beehiiv", valor: beehiiv?.active ?? null },
            { chave: "kit", valor: kitActive },
          ]
        : undefined;
    if (beehiiv && beehiiv.date !== hoje) {
      const result = piso(
        total,
        args.janela,
        beehiiv.date,
        `snapshot Beehiiv de ${beehiiv.date}, "hoje" é ${hoje} — a base só cai entre snapshots, este número é um PISO`,
      );
      if (series) result.series = series;
      return result;
    }
    const result = exato(total, args.janela, beehiiv?.date ?? hoje);
    if (series) result.series = series;
    return result;
  },
};

// ---------------------------------------------------------------------------
// leitor-v1 — só Beehiiv (docstring de leitor.ts proíbe somar com Kit)
// ---------------------------------------------------------------------------

export interface LeitorV1Deps extends MetricDeps {
  subscribers: readonly BeehiivSubscriberStatsShape[];
  snapshotDate: string;
}

const leitorV1Def: MetricDef<LeitorV1Deps> = {
  id: "leitor-v1",
  nome: "Leitores (v1)",
  produto: "diaria",
  etapa: "saude",
  definicao:
    "summarizeLeitores sobre o snapshot Beehiiv mais recente: status=active AND total_received>=20 AND " +
    "(total_unique_clicked / total_received) >= 2% (denominador = total_received, NUNCA stats.click_rate, " +
    "que é clique÷abertura). Só Beehiiv — Kit fica de fora (contadores zeram no cutover, decisão do editor).",
  unidade: "contagem",
  direcao: "maior-melhor",
  fonte: "data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl",
  decomposicoes: [],
  async computar(args) {
    validarDecomposicao(leitorV1Def, args.decomposicao);
    const { subscribers, snapshotDate } = args.deps;
    if (subscribers.length === 0) {
      return indeterminado(args.janela, `snapshot ${snapshotDate} sem subscribers`);
    }
    const summary = summarizeLeitores(
      subscribers as unknown as Parameters<typeof summarizeLeitores>[0],
      LEITOR_V1_THRESHOLDS,
      snapshotDate,
    );
    if (summary.subscribers_missing_stats / summary.total_subscribers >= MISSING_STATS_WARN_FRACTION) {
      return indeterminado(
        args.janela,
        `snapshot ${snapshotDate}: ${summary.subscribers_missing_stats}/${summary.total_subscribers} sem "stats" — sem dado de engajamento confiável`,
        snapshotDate,
      );
    }
    return exato(summary.leitores_v1, args.janela, snapshotDate);
  },
};

// ---------------------------------------------------------------------------
// abertura-1a-edicao / primeiro-clique-14d — ativação por coorte (#7183)
// ---------------------------------------------------------------------------

export interface AtivacaoCoorteMetricDeps extends MetricDeps {
  /** Registros já resolvidos (identidade, `created` mais antigo entre
   *  snapshots, denominador, abertura/clique) — o chamador resolve a fonte
   *  (store do #6464). SEM I/O aqui. */
  registros(janela: Janela): AtivacaoCoorteSubscriberInput[] | Promise<AtivacaoCoorteSubscriberInput[]>;
  /** Epoch seconds UTC — "agora" injetado (testável), usado só pra maturação
   *  de `primeiro-clique-14d`. */
  now: number;
  /** `true` quando o resultado depende de casamento de identidade
   *  cross-plataforma do store (#6464) ainda incerto — rebaixa a
   *  `qualidade` pra `piso` com `CROSS_PLATFORM_FLOOR_NOTE`. */
  crossPlatformFloor?: boolean;
}

function toMetricResult(r: AtivacaoCoorteResult, janela: Janela, frescor: string | null): MetricResult {
  if (r.qualidade === "indeterminado") {
    return indeterminado(janela, r.motivo ?? "indeterminado", frescor);
  }
  const result: MetricResult =
    r.qualidade === "piso"
      ? piso(r.valor as number, janela, frescor, r.motivo ?? "piso")
      : exato(r.valor as number, janela, frescor);
  return result;
}

function porClasseSeries(r: AtivacaoCoorteResult): MetricSeriesPoint[] {
  return (Object.keys(r.porClasse) as AcquisitionClass[]).map((chave) => {
    const c = r.porClasse[chave];
    return { chave, valor: c.denom > 0 ? c.numeradorResolvido / c.denom : null };
  });
}

const aberturaPrimeiraEdicaoDef: MetricDef<AtivacaoCoorteMetricDeps> = {
  id: "abertura-1a-edicao",
  nome: "Abertura da 1ª edição recebida (por coorte)",
  produto: "diaria",
  etapa: "ativacao",
  definicao:
    "razão: safra de cadastro D que abriu a 1ª edição recebida (status ∈ {opened,clicked} OU total_opened>0, " +
    "deriveBeehiivEventTypes) ÷ safra de D que recebeu ≥1 edição (denominador = recebeuAoMenosUma, mesmo " +
    "denominador de primeiro-clique-14d). Membro com 1º post 100% stub (#7181 F9) fica fora do numerador " +
    "resolvido mas dentro do denominador — qualidade cai pra piso (algum não-resolvido) ou indeterminado " +
    "(todos não-resolvidos). decomposicao 'classe' devolve a taxa por classe de aquisição de #7173.",
  unidade: "razao",
  direcao: "maior-melhor",
  fonte: "store do #6464 (subscriber/subscription/event, platform=beehiiv) via deriveBeehiivEventTypes",
  decomposicoes: ["classe"],
  async computar(args) {
    validarDecomposicao(aberturaPrimeiraEdicaoDef, args.decomposicao);
    const registros = await args.deps.registros(args.janela);
    let r = computeAberturaPrimeiraEdicao(registros);
    if (args.deps.crossPlatformFloor) r = applyCrossPlatformFloor(r);
    const result = toMetricResult(r, args.janela, null);
    if (args.decomposicao === "classe" && result.qualidade !== "indeterminado") {
      result.series = porClasseSeries(r);
    }
    return result;
  },
};

const primeiroClique14dDef: MetricDef<AtivacaoCoorteMetricDeps> = {
  id: "primeiro-clique-14d",
  nome: "1º clique em até 14 dias (por coorte)",
  produto: "diaria",
  etapa: "ativacao",
  definicao:
    "razão: safra de cadastro D com ≥1 clique (status='clicked' OU total_clicked>0, deriveBeehiivEventTypes) " +
    "com ts ≤ created + 14 dias ÷ safra de D que recebeu ≥1 edição (denominador = recebeuAoMenosUma, mesmo " +
    "denominador de abertura-1a-edicao). Coorte com qualquer membro do denominador ainda a menos de 14 dias " +
    "de casa devolve indeterminado — nunca uma taxa parcial que sobe sozinha. decomposicao 'classe' devolve " +
    "a taxa por classe de aquisição de #7173.",
  unidade: "razao",
  direcao: "maior-melhor",
  fonte: "store do #6464 (subscriber/subscription/event, platform=beehiiv) via deriveBeehiivEventTypes",
  decomposicoes: ["classe"],
  async computar(args) {
    validarDecomposicao(primeiroClique14dDef, args.decomposicao);
    const registros = await args.deps.registros(args.janela);
    let r = computePrimeiroClique14d(registros, args.deps.now);
    if (args.deps.crossPlatformFloor) r = applyCrossPlatformFloor(r);
    const result = toMetricResult(r, args.janela, null);
    if (args.decomposicao === "classe" && result.qualidade !== "indeterminado") {
      result.series = porClasseSeries(r);
    }
    return result;
  },
};

// ---------------------------------------------------------------------------
// O registry
// ---------------------------------------------------------------------------

/**
 * Fonte única — nasce com as 8 métricas de #7176 + as 2 de ativação por
 * coorte de #7183. `getMetric`/`METRICAS` são a superfície que F5 (#7177),
 * F6 (#7178) e F8 (#7180) importam.
 */
export const METRICAS: readonly MetricDef[] = [
  cadastrosDiaDef as MetricDef,
  cadastrosNaoPagoNaoReativacaoDiaDef as MetricDef,
  cadastrosOrganicosDiaDef as MetricDef,
  cadastrosIndeterminadosDiaDef as MetricDef,
  doiConfirmacaoDiaDef as MetricDef,
  doiOrfaosDef as MetricDef,
  baseAtivaDef as MetricDef,
  leitorV1Def as MetricDef,
  aberturaPrimeiraEdicaoDef as MetricDef,
  primeiroClique14dDef as MetricDef,
];

assertRegistryValido(METRICAS);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printTable(): void {
  const rows = METRICAS.map((m) => ({
    id: m.id,
    produto: m.produto,
    etapa: m.etapa,
    unidade: m.unidade,
    direcao: m.direcao,
  }));
  console.table(rows);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  if (argv.includes("--json")) {
    console.log(JSON.stringify(METRICAS.map(({ computar: _computar, ...rest }) => rest), null, 2));
    return;
  }
  printTable();
}

if (isMainModule(import.meta.url)) {
  main();
}
