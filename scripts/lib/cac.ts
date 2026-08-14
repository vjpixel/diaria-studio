/**
 * cac.ts (#5236 Parte 2) — núcleo PURO do relatório de custo por leitor por
 * canal. Nenhuma função deste módulo toca disco/rede — `scripts/cac-report.ts`
 * (CLI) e `scripts/studio-ui/studio-ads.ts` (Studio) são os dois callers que
 * fazem I/O (ler snapshot, ler `spend.csv`, ler mapa de origem) e chamam
 * `buildCacReport` com os dados já carregados. Mesmo padrão de
 * `cohort-engagement.ts`/`leitor.ts`/`build-origem-map.ts` — puro e
 * testável sem fixture em disco.
 *
 * **Reuso, não reimplementação (requisito explícito da issue):** o
 * agrupamento por origem, a mediana/média de recebidas e os qualificadores
 * de amostra (instável/pequena/vazia) vêm DIRETO de
 * `scripts/cohort-engagement.ts` (`computeGroupEngagement`, `resolveGroupKey`,
 * `normalizeKey`) — este módulo não reescreve esse cálculo, só o aplica sobre
 * dados vindos de um SNAPSHOT LOCAL (`beehiiv-backup-snapshots.ts`) em vez de
 * um fetch ao vivo da Beehiiv (guard de publicação: nenhum script aqui toca a
 * API Beehiiv).
 *
 * **`leitor-v1` é uma unidade DIFERENTE de "leitor" no sentido de
 * `cohort-engagement.ts`.** `GroupEngagement.leitores` ali é
 * `open_rate >= threshold` — mas `open_rate` por assinante não existe nos
 * snapshots locais (`BeehiivBackupSubscriber.stats` só tem
 * `total_received`/`total_unique_clicked`/`total_unique_opened`/`click_rate`,
 * ver `beehiiv-backup-snapshots.ts`). Por isso este módulo NUNCA lê
 * `GroupEngagement.leitores` — conta leitor-v1 (CTR real, `scripts/lib/leitor.ts`)
 * separadamente via `isLeitorV1`. `abertura_agregada` (Σabertos ÷ Σrecebidas)
 * continua vindo de `computeGroupEngagement` normalmente — esse cálculo não
 * depende de `open_rate` por assinante.
 *
 * **Filtro de contas internas/teste ANTES de agrupar (nota do self-review de
 * #5235, endereçada aqui).** `build-origem-map.ts` não filtra
 * `INTERNAL_EMAILS`/contas de teste nem normaliza email antes de indexar —
 * este módulo faz as duas coisas antes de qualquer agregação por canal
 * (`filterInternalAndTestSubscribers`, `buildNormalizedOrigemIndex`), pra
 * não distorcer custo por canal com o próprio editor/QA misturado nos
 * dados.
 *
 * **O canal Beehiiv Boosts é ESTIMADO, nunca medido por grupo.** Boost
 * (Recommendations pagas da Beehiiv) não tem uma chave de atribuição estável
 * em `utm_source`/`referring_site` no snapshot — ao contrário de Google Ads
 * (`android.googlequicksearchbox` e afins, confirmado em #5254) e LinkedIn
 * (`utm_source`/`referring_site` contendo "linkedin"). Em vez de arriscar um
 * match ambíguo/silencioso, o custo por leitor do boost é uma FAIXA
 * (mín–máx) derivada da proporção `157 faturados / 233 leads totais`
 * (números da análise #4466/#5236 — 157 faturados historicamente viraram
 * ~80 ativos e ~16 leitores) — nunca soma no total "medido" do relatório,
 * e nunca colapsa pra um ponto único (ver `computeBoostRange`).
 */

import { normalizeKey, resolveGroupKey, computeGroupEngagement, type EngagementSubscriber } from "../cohort-engagement.ts";
import { isLeitorV1, LEITOR_V1_THRESHOLDS, type LeitorInput, type LeitorThresholds } from "./leitor.ts";
import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";
import { INTERNAL_EMAILS, isTestAccount } from "./cohorts.ts";
import type { SpendRow } from "./aquisicao-spend.ts";

// ---------------------------------------------------------------------------
// Normalização de email + filtro interno/teste (endereça o achado do
// self-review de #5235 — ver docstring do módulo)
// ---------------------------------------------------------------------------

/** @pure */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const NORMALIZED_INTERNAL_EMAILS = new Set(INTERNAL_EMAILS.map(normalizeEmail));

/** @pure */
export function isInternalOrTestEmail(email: string): boolean {
  if (NORMALIZED_INTERNAL_EMAILS.has(normalizeEmail(email))) return true;
  return isTestAccount(email);
}

/** Remove assinantes internos (editor/equipe, `INTERNAL_EMAILS`) e contas de
 *  teste (`isTestAccount`) ANTES de qualquer agregação por canal. Retorna
 *  também a contagem removida — nunca um filtro silencioso sem rastro.
 *  @pure */
export function filterInternalAndTestSubscribers<T extends { email: string }>(
  subs: T[],
): { kept: T[]; removedCount: number } {
  const kept: T[] = [];
  let removedCount = 0;
  for (const sub of subs) {
    if (isInternalOrTestEmail(sub.email)) {
      removedCount++;
      continue;
    }
    kept.push(sub);
  }
  return { kept, removedCount };
}

// ---------------------------------------------------------------------------
// Mapa de origem recuperada (#5235) — índice normalizado + aplicação
// ---------------------------------------------------------------------------

export interface OrigemEntryFields {
  utm_source: string;
  referring_site: string;
}

/** Índice `email normalizado → origem`, construído 1x a partir do JSON bruto
 *  de `origem-original.json` (que usa email cru, não normalizado — ver
 *  docstring do módulo). @pure */
export function buildNormalizedOrigemIndex(
  origem: Record<string, OrigemEntryFields>,
): Map<string, OrigemEntryFields> {
  const idx = new Map<string, OrigemEntryFields>();
  for (const [email, entry] of Object.entries(origem)) {
    idx.set(normalizeEmail(email), entry);
  }
  return idx;
}

/** Sobrescreve `utm_source`/`referring_site` de cada assinante com a origem
 *  recuperada, quando disponível (match por email normalizado). Assinante
 *  sem entrada no índice mantém os campos do snapshot como estão — o mapa de
 *  origem é aditivo/corretivo, nunca reduz cobertura. @pure */
export function applyOrigemOverride(
  subs: BeehiivBackupSubscriber[],
  origemIndex: Map<string, OrigemEntryFields>,
): BeehiivBackupSubscriber[] {
  if (origemIndex.size === 0) return subs;
  return subs.map((sub) => {
    const entry = origemIndex.get(normalizeEmail(sub.email));
    if (!entry) return sub;
    return { ...sub, utm_source: entry.utm_source, referring_site: entry.referring_site };
  });
}

// ---------------------------------------------------------------------------
// leitor-v1 por canal (NUNCA GroupEngagement.leitores — ver docstring)
// ---------------------------------------------------------------------------

/** @pure */
export function countLeitoresV1(
  subs: BeehiivBackupSubscriber[],
  thresholds: LeitorThresholds = LEITOR_V1_THRESHOLDS,
): number {
  let n = 0;
  for (const sub of subs) {
    const input: LeitorInput = {
      status: sub.status,
      totalReceived: sub.stats?.total_received ?? 0,
      totalUniqueClicked: sub.stats?.total_unique_clicked ?? 0,
    };
    if (isLeitorV1(input, thresholds)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Conversão pro shape de `cohort-engagement.ts` (reuso de computeGroupEngagement)
// ---------------------------------------------------------------------------

/** @pure */
export function toEngagementSubscriber(sub: BeehiivBackupSubscriber): EngagementSubscriber {
  return {
    status: sub.status,
    created: sub.created,
    utm_source: sub.utm_source,
    referring_site: sub.referring_site,
    stats: sub.stats
      ? {
          total_received: sub.stats.total_received,
          total_unique_opened: sub.stats.total_unique_opened,
          total_unique_clicked: sub.stats.total_unique_clicked,
        }
      : null,
  };
}

/** open_rate por-assinante não existe no snapshot local — `threshold` é
 *  irrelevante pro que este módulo lê de `computeGroupEngagement` (só
 *  `abertura_agregada`/qualificadores de amostra, nunca `.leitores`), mas a
 *  assinatura da função exige um valor; mantido explícito aqui em vez de
 *  mágico dentro de cada call site. */
const ENGAGEMENT_THRESHOLD_UNUSED = 40;

// ---------------------------------------------------------------------------
// Chaves de grupo conhecidas por canal (Google Ads, LinkedIn — medidos)
// ---------------------------------------------------------------------------

/**
 * `utm_source`/`referring_site` (normalizados por `normalizeKey`) que
 * identificam cada canal PAGO MEDIDO no snapshot. Beehiiv Boosts
 * deliberadamente NÃO entra aqui — ver docstring do módulo.
 *
 * Google Ads: `android.googlequicksearchbox`/`googlesyndication`/
 * `googleadservices` confirmados em #4466/#5254 (227 cadastros da campanha
 * dez/2025-fev/2026 vieram por esses referrers — majoritariamente o app do
 * Google no Android).
 *
 * LinkedIn: nenhuma campanha rodou até 260814 (spend R$0, linha
 * placeholder) — as chaves abaixo são a convenção já usada pelo próprio
 * projeto pra tráfego de LinkedIn (`LINKEDIN_POST_PIXEL_UTM.source` em
 * `scripts/lib/shared/utm-registry.ts` usa `"linkedin"`) mais os domínios
 * de referrer prováveis se o Ads Manager algum dia rodar.
 */
export const CHANNEL_GROUP_KEYS: Record<string, readonly string[]> = {
  "Google Ads": ["android.googlequicksearchbox", "googlesyndication", "googlesyndication.com", "googleadservices", "googleadservices.com"],
  LinkedIn: ["linkedin", "linkedin.com", "l.linkedin.com", "www.linkedin.com"],
};

/** @pure */
function normalizedChannelKeySet(canal: string): Set<string> | null {
  const keys = CHANNEL_GROUP_KEYS[canal];
  if (!keys) return null;
  return new Set(keys.map(normalizeKey));
}

/** @pure */
export function subscribersForChannel(
  subs: BeehiivBackupSubscriber[],
  canal: string,
): BeehiivBackupSubscriber[] {
  const keySet = normalizedChannelKeySet(canal);
  if (!keySet) return [];
  return subs.filter((sub) => keySet.has(resolveGroupKey(toEngagementSubscriber(sub))));
}

// ---------------------------------------------------------------------------
// Estimativa do Beehiiv Boosts — faixa mín/máx, nunca ponto
// ---------------------------------------------------------------------------

export interface BoostEstimateAnchor {
  /** Leads CONFIRMADOS faturados pela Beehiiv (base mais conservadora). */
  billedLeads: number;
  /** Total de leads referidos observados (inclui leads cujo faturamento não
   *  está confirmado — base mais otimista). */
  totalLeads: number;
  /** Ativos observados historicamente entre os `billedLeads` faturados. */
  ativosAnchor: number;
  /** Leitores-v1 observados historicamente entre os `billedLeads` faturados. */
  leitoresAnchor: number;
}

/** Âncoras da análise #4466 (03/ago/2026) + proporção 157/233 citada em
 *  #5236: 157 leads faturados confirmados historicamente viraram ~80 ativos
 *  e ~16 leitores-v1; 233 é o total de leads referidos observados (inclui
 *  leads cujo faturamento não está confirmado). A faixa mín-máx escala os
 *  dois âncoras (ativos, leitores) pela razão `totalLeads / billedLeads` —
 *  o limite MÁXIMO assume que todo lead referido (faturado ou não) se
 *  comporta como os já confirmados; o MÍNIMO usa só o que está confirmado. */
export const BOOST_ESTIMATE_ANCHOR: BoostEstimateAnchor = {
  billedLeads: 157,
  totalLeads: 233,
  ativosAnchor: 80,
  leitoresAnchor: 16,
};

export interface BoostRange {
  ativosMin: number;
  ativosMax: number;
  leitoresMin: number;
  leitoresMax: number;
  /** Custo por leitor no cenário MAIS BARATO (leitoresMax no denominador). */
  custoPorLeitorMin: number | null;
  /** Custo por leitor no cenário MAIS CARO (leitoresMin no denominador). */
  custoPorLeitorMax: number | null;
}

/** @pure */
export function computeBoostRange(
  spendValor: number,
  anchor: BoostEstimateAnchor = BOOST_ESTIMATE_ANCHOR,
): BoostRange {
  const scaleUp = anchor.totalLeads / anchor.billedLeads;
  const ativosMin = anchor.ativosAnchor;
  const ativosMax = Math.round(anchor.ativosAnchor * scaleUp);
  const leitoresMin = anchor.leitoresAnchor;
  const leitoresMax = Math.round(anchor.leitoresAnchor * scaleUp);
  return {
    ativosMin,
    ativosMax,
    leitoresMin,
    leitoresMax,
    custoPorLeitorMin: leitoresMax > 0 ? spendValor / leitoresMax : null,
    custoPorLeitorMax: leitoresMin > 0 ? spendValor / leitoresMin : null,
  };
}

// ---------------------------------------------------------------------------
// Linha do relatório — canal medido
// ---------------------------------------------------------------------------

export interface CacMeasuredRow {
  kind: "measured";
  canal: string;
  spend: SpendRow;
  cadastros: number;
  ativos: number;
  leitores: number;
  /** `null` quando `leitores === 0` (sem dado, nunca "custo infinito" silencioso). */
  custoPorLeitor: number | null;
  aberturaAgregada: number | null;
  /** "n" — sempre visível (requisito da issue). */
  amostraConsiderada: number;
  amostraInstavel: boolean;
  amostraVazia: boolean;
  amostraPequena: boolean;
  /** Abertura agregada do MESMO canal num snapshot anterior, quando
   *  disponível — `null` sem histórico suficiente pra comparar. */
  aberturaAgregadaAnterior: number | null;
  /** `true` se a abertura caiu em relação ao snapshot anterior; `null` sem
   *  histórico suficiente pra decidir (nunca `false` por omissão). */
  degradado: boolean | null;
}

export interface CacBoostRow {
  kind: "boost-estimate";
  canal: string;
  spend: SpendRow;
  range: BoostRange;
  note: string;
}

export type CacRow = CacMeasuredRow | CacBoostRow;

/** Limiar de queda de abertura (pontos percentuais) a partir do qual um
 *  canal é sinalizado como "degradado" em relação ao snapshot anterior. */
export const DEGRADATION_THRESHOLD_PCT = 5;

/** @pure */
export function computeMeasuredRow(
  spend: SpendRow,
  channelSubs: BeehiivBackupSubscriber[],
  opts: { previousChannelSubs?: BeehiivBackupSubscriber[] } = {},
): CacMeasuredRow {
  const engagementSubs = channelSubs.map(toEngagementSubscriber);
  const engagement = computeGroupEngagement(engagementSubs, { threshold: ENGAGEMENT_THRESHOLD_UNUSED });
  const leitores = countLeitoresV1(channelSubs);

  let aberturaAgregadaAnterior: number | null = null;
  let degradado: boolean | null = null;
  if (opts.previousChannelSubs) {
    const prevEngagement = computeGroupEngagement(opts.previousChannelSubs.map(toEngagementSubscriber), {
      threshold: ENGAGEMENT_THRESHOLD_UNUSED,
    });
    aberturaAgregadaAnterior = prevEngagement.abertura_agregada;
    if (engagement.abertura_agregada != null && prevEngagement.abertura_agregada != null) {
      const deltaPct = (engagement.abertura_agregada - prevEngagement.abertura_agregada) * 100;
      degradado = deltaPct <= -DEGRADATION_THRESHOLD_PCT;
    }
  }

  return {
    kind: "measured",
    canal: spend.canal,
    spend,
    cadastros: engagement.cadastros,
    ativos: engagement.ativos,
    leitores,
    custoPorLeitor: leitores > 0 ? spend.valor / leitores : null,
    aberturaAgregada: engagement.abertura_agregada,
    amostraConsiderada: engagement.amostra_considerada,
    amostraInstavel: engagement.amostra_instavel,
    amostraVazia: engagement.amostra_vazia,
    amostraPequena: engagement.amostra_pequena,
    aberturaAgregadaAnterior,
    degradado,
  };
}

/** @pure */
export function computeBoostRow(spend: SpendRow): CacBoostRow {
  return {
    kind: "boost-estimate",
    canal: spend.canal,
    spend,
    range: computeBoostRange(spend.valor),
    note:
      "estimado pela proporção 157 leads faturados / 233 leads totais (análise #4466/#5236) — " +
      "não medido diretamente no snapshot (Boosts não tem chave de atribuição estável em " +
      "utm_source/referring_site) e não soma no total medido do relatório.",
  };
}

// ---------------------------------------------------------------------------
// Relatório completo
// ---------------------------------------------------------------------------

export interface CacBaseMetrics {
  aberturaAgregada: number | null;
  amostraConsiderada: number;
}

export interface CacReport {
  rows: CacRow[];
  base: CacBaseMetrics;
  totalGastoMedido: number;
  internalFiltered: number;
  originApplied: boolean;
}

/** Métricas de abertura/amostra sobre a BASE inteira (todos os ativos com
 *  stats, independente de canal) — o denominador contra o qual cada canal é
 *  comparado ("aprova ou reprova", regra de saída do #4466). @pure */
export function computeBaseMetrics(subs: BeehiivBackupSubscriber[]): CacBaseMetrics {
  const engagement = computeGroupEngagement(subs.map(toEngagementSubscriber), {
    threshold: ENGAGEMENT_THRESHOLD_UNUSED,
  });
  return { aberturaAgregada: engagement.abertura_agregada, amostraConsiderada: engagement.amostra_considerada };
}

/**
 * Monta o relatório completo: 1 linha por linha de `spend.csv`, ranqueada
 * por custo por leitor (canais medidos usam o valor direto; Boost usa o
 * limite MÁXIMO/mais caro — decisão conservadora pra não posicionar uma
 * estimativa otimista acima de um canal medido; documentado aqui pra
 * self-review). Canais sem `custoPorLeitor` (measured, leitores=0) vão pro
 * fim da lista.
 *
 * `subs`/`previousSubs` já devem estar filtrados de internos/teste e com o
 * mapa de origem aplicado — este é o núcleo de composição, não quem faz
 * esse trabalho (ver `filterInternalAndTestSubscribers`/`applyOrigemOverride`
 * acima, chamados pelo caller antes de passar pra cá).
 *
 * @pure
 */
export function buildCacReport(
  spendRows: SpendRow[],
  subs: BeehiivBackupSubscriber[],
  opts: { previousSubs?: BeehiivBackupSubscriber[]; originApplied?: boolean; internalFiltered?: number } = {},
): CacReport {
  const rows: CacRow[] = spendRows.map((spend) => {
    if (CHANNEL_GROUP_KEYS[spend.canal]) {
      const channelSubs = subscribersForChannel(subs, spend.canal);
      const previousChannelSubs = opts.previousSubs ? subscribersForChannel(opts.previousSubs, spend.canal) : undefined;
      return computeMeasuredRow(spend, channelSubs, { previousChannelSubs });
    }
    // Canal sem chave de grupo conhecida: tratado como boost-estimate SÓ se
    // for literalmente "Beehiiv Boosts" — qualquer outro canal desconhecido
    // ainda assim precisa aparecer (nunca desaparece do relatório por não
    // estar mapeado), então cai como "measured" com 0 assinantes
    // encontrados (honesto: n=0/vazio) em vez de silenciosamente virar uma
    // estimativa que não pediu pra ser.
    if (spend.canal === "Beehiiv Boosts") {
      return computeBoostRow(spend);
    }
    return computeMeasuredRow(spend, []);
  });

  const rankValue = (row: CacRow): number => {
    if (row.kind === "measured") return row.custoPorLeitor ?? Number.POSITIVE_INFINITY;
    return row.range.custoPorLeitorMax ?? Number.POSITIVE_INFINITY;
  };
  rows.sort((a, b) => rankValue(a) - rankValue(b));

  const totalGastoMedido = rows
    .filter((r): r is CacMeasuredRow => r.kind === "measured")
    .reduce((sum, r) => sum + r.spend.valor, 0);

  return {
    rows,
    base: computeBaseMetrics(subs),
    totalGastoMedido,
    internalFiltered: opts.internalFiltered ?? 0,
    originApplied: opts.originApplied ?? false,
  };
}

// ---------------------------------------------------------------------------
// Orçamento mensal — "quanto do orçamento do mês já foi consumido?"
// ---------------------------------------------------------------------------

/** R$ 4.000/mês+ — piso do orçamento de aquisição (CLAUDE.md, decisão
 *  260814: teto de CAC revogado, "crescer o mais rápido possível dentro do
 *  orçamento"). Mantido como "piso conhecido", não teto rígido — o
 *  orçamento pode crescer; este número nunca deveria reprovar gasto
 *  sozinho (ver issue #5236: "o custo ranqueia, não reprova"). */
export const MONTHLY_BUDGET_FLOOR_BRL = 4000;

export interface MonthBudgetUsage {
  monthKey: string;
  spentBrl: number;
  budgetFloorBrl: number;
  /** Fração 0-1+ (pode passar de 1 se o gasto exceder o piso conhecido). */
  fractionUsed: number;
}

/** Soma `valor` de todas as linhas de `spendRows` cujo `mes` bate com
 *  `monthKey` (comparação de string direta — `mes` já é convenção `AAAA-MM`
 *  nas linhas atuais). Moeda não é convertida (assume tudo BRL — as 3 linhas
 *  seed são BRL; um canal em outra moeda exigiria conversão que este helper
 *  não faz, e sinalizar isso é responsabilidade do caller). @pure */
export function computeMonthBudgetUsage(
  spendRows: SpendRow[],
  monthKey: string,
  budgetFloorBrl: number = MONTHLY_BUDGET_FLOOR_BRL,
): MonthBudgetUsage {
  const spentBrl = spendRows.filter((r) => r.mes === monthKey).reduce((sum, r) => sum + r.valor, 0);
  return {
    monthKey,
    spentBrl,
    budgetFloorBrl,
    fractionUsed: budgetFloorBrl > 0 ? spentBrl / budgetFloorBrl : 0,
  };
}
