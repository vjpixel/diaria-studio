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

import {
  normalizeKey,
  resolveGroupKey,
  computeGroupEngagement,
  filterWindow,
  countMissingCreated,
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  type EngagementSubscriber,
  type CohortWindow,
} from "../cohort-engagement.ts";
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
 * Adaptador de reuso de `filterWindow`/`countMissingCreated`
 * (`cohort-engagement.ts`, #5495) para `BeehiivBackupSubscriber[]`.
 *
 * `filterWindow`/`countMissingCreated` são tipados sobre `EngagementSubscriber[]`
 * (campos opcionais). `BeehiivBackupSubscriber` já satisfaz essa forma
 * estruturalmente em TODOS os campos que essas duas funções de fato leem —
 * só `created` — mas o `stats` de cada tipo tem forma ligeiramente diferente
 * (`click_rate` presente/ausente), então o TS recusa a atribuição direta.
 * O cast é seguro porque nenhuma das duas funções toca `stats`; documentado
 * aqui em vez de reimplementar a lógica de janela (requisito explícito da
 * issue: "reusar `filterWindow`, nunca reimplementar").
 * @pure
 */
function filterSubsByWindow<T extends BeehiivBackupSubscriber>(subs: T[], window: CohortWindow): T[] {
  return filterWindow(subs as unknown as EngagementSubscriber[], window) as unknown as T[];
}

/** Mesmo adaptador acima, para `countMissingCreated`. @pure */
function countSubsMissingCreated(subs: BeehiivBackupSubscriber[], window: CohortWindow): number {
  return countMissingCreated(subs as unknown as EngagementSubscriber[], window);
}

/**
 * Um recorte dentro de um canal (#5496) — `utm_source`/`referring_site`
 * (normalizados por `normalizeKey`) que identificam um PAGO MEDIDO no
 * snapshot, opcionalmente restrito a um SUB-canal (`subcanal` casa com
 * `SpendRow.subcanal`; ausente = "o canal inteiro").
 *
 * `ambigua: true` marca uma chave que TAMBÉM é usada por tráfego orgânico
 * (ex: `google.com` — pode ser busca orgânica ou clique de anúncio que
 * perdeu a query string) — nesse caso `janela` é OBRIGATÓRIA
 * (`assertValidChannelKeySpecs` lança se faltar) e só cadastros DENTRO dela
 * contam como pagos. Fora da janela, esses cadastros nunca entram nesta
 * spec (ficam de fora do canal, subestimando por construção — decisão
 * documentada da issue #5493: "conservador, aceitando subestimar cadastros
 * pagos" é preferível a contaminar com orgânico sem aviso).
 */
export interface ChannelKeySpec {
  canal: string;
  subcanal?: string;
  keys: readonly string[];
  /** Obrigatória quando `ambigua: true`; ignorada (mas aceita) em spec não-ambígua. */
  janela?: CohortWindow;
  ambigua?: boolean;
}

/**
 * Specs por (canal, sub-canal) — fonte única de verdade; `CHANNEL_GROUP_KEYS`
 * abaixo é DERIVADO daqui (união por canal, sem specs ambíguas) só para
 * manter compatibilidade com consumidores existentes.
 *
 * Google Ads: `android.googlequicksearchbox`/`googlesyndication`/
 * `googleadservices` (sub-canal "PMax") confirmados em #4466/#5254 (227
 * cadastros da campanha dez/2025-fev/2026 vieram por esses referrers —
 * majoritariamente o app do Google no Android). `google.com` (sub-canal
 * "Search") é AMBÍGUA — pode ser busca orgânica — e só conta dentro da
 * janela da campanha (dez/2025 a fev/2026, pausada ~06/fev/2026, mesma
 * fonte #4466/#5254; achado #5496 mediu 34 dos 41 cadastros `google.com`
 * dentro dessa janela e 7 fora, confirmando que fora da janela é orgânico).
 *
 * LinkedIn: nenhuma campanha rodou até 260814 (spend R$0, linha
 * placeholder) — as chaves abaixo são a convenção já usada pelo próprio
 * projeto pra tráfego de LinkedIn (`LINKEDIN_POST_PIXEL_UTM.source` em
 * `scripts/lib/shared/utm-registry.ts` usa `"linkedin"`) mais os domínios
 * de referrer prováveis se o Ads Manager algum dia rodar. Sem sub-canal —
 * nenhuma segmentação conhecida ainda.
 *
 * **Meta e Microsoft Advertising deliberadamente NÃO têm spec aqui (#5493).**
 * Nomes canônicos já fixados (`"Meta"`, `"Microsoft Advertising"` — usar
 * exatamente essas strings em `spend.csv`/scripts de ingestão), mas as
 * CHAVES de atribuição são bloqueadas por observação real: o navegador
 * embutido da Meta corta a query string com frequência (chega como
 * `l.facebook.com`/`lm.facebook.com`/`l.instagram.com` no `referring_site`,
 * formas nunca vistas no snapshot até agora), e `instagram.com`/
 * `instagram-diaria`/`instagram-pessoal` já são tráfego ORGÂNICO hoje —
 * mapear ingenuamente contaminaria o CAC da Meta com orgânico grátis,
 * exatamente o oposto de medir. Rodar `scripts/observe-channel-keys.ts`
 * contra ≥1 dia de campanha real e colar a saída literal no PR que
 * adicionar essas specs — nunca adivinhar.
 */
export const CHANNEL_KEY_SPECS: readonly ChannelKeySpec[] = [
  {
    canal: "Google Ads",
    subcanal: "PMax",
    keys: ["android.googlequicksearchbox", "googlesyndication", "googlesyndication.com", "googleadservices", "googleadservices.com"],
  },
  {
    canal: "Google Ads",
    subcanal: "Search",
    keys: ["google.com"],
    ambigua: true,
    janela: {
      since: parseSinceToEpochSeconds("2025-12-01"),
      untilExclusive: parseUntilToEpochSecondsExclusive("2026-02-28"),
    },
  },
  {
    canal: "LinkedIn",
    keys: ["linkedin", "linkedin.com", "l.linkedin.com", "www.linkedin.com"],
  },
];

/** Nomes canônicos reservados para Meta/Microsoft Advertising (#5493) —
 *  usar exatamente estas strings na coluna `canal` de `spend.csv`/scripts de
 *  ingestão assim que existir gasto real, MESMO sem spec ainda em
 *  `CHANNEL_KEY_SPECS` (a linha aparece como "canal desconhecido" avisado
 *  até a spec entrar — nunca como `measured` silenciosamente errado). */
export const RESERVED_CHANNEL_NAMES = ["Meta", "Microsoft Advertising"] as const;

/** Lança se alguma spec `ambigua: true` não tiver `janela` — chave ambígua
 *  sem janela é pior que canal desconhecido (produziria um número plausível
 *  e falso, silenciosamente). Chamada no load do módulo: `CHANNEL_KEY_SPECS`
 *  é estático, então um erro de configuração quebra IMEDIATAMENTE (import
 *  falha), nunca em runtime só quando aquele canal específico for
 *  relatado. Exportada pra ser testável com fixtures inválidas sem precisar
 *  quebrar o import do módulo real. @pure */
export function assertValidChannelKeySpecs(specs: readonly ChannelKeySpec[]): void {
  for (const spec of specs) {
    if (spec.ambigua && !spec.janela) {
      throw new Error(
        `[cac] CHANNEL_KEY_SPECS: spec ambígua sem janela obrigatória — canal="${spec.canal}"` +
          `${spec.subcanal ? ` subcanal="${spec.subcanal}"` : ""}. Chave ambígua (colide com tráfego ` +
          `orgânico) só pode contar como paga dentro de uma janela declarada.`,
      );
    }
  }
}
assertValidChannelKeySpecs(CHANNEL_KEY_SPECS);

/** Deriva o mapa legado canal→chaves a partir de `CHANNEL_KEY_SPECS`, EXCLUINDO
 *  specs ambíguas — o caminho sem sub-canal (`spend.subcanal` ausente) precisa
 *  continuar tão conservador quanto hoje (nunca engolir `google.com` sem
 *  janela só porque uma linha de canal inteiro não pediu sub-canal). @pure */
function deriveChannelGroupKeys(specs: readonly ChannelKeySpec[]): Record<string, readonly string[]> {
  const byCanal = new Map<string, string[]>();
  for (const spec of specs) {
    if (spec.ambigua) continue;
    const existing = byCanal.get(spec.canal) ?? [];
    byCanal.set(spec.canal, [...existing, ...spec.keys]);
  }
  return Object.fromEntries(byCanal);
}

/**
 * `utm_source`/`referring_site` (normalizados por `normalizeKey`) que
 * identificam cada canal PAGO MEDIDO no snapshot, união de todos os
 * sub-canais NÃO-ambíguos de `CHANNEL_KEY_SPECS`. Beehiiv Boosts
 * deliberadamente NÃO entra aqui — ver docstring do módulo.
 *
 * DERIVADO — mantido como export próprio (em vez de só `CHANNEL_KEY_SPECS`)
 * para não quebrar `test/cac.test.ts` nem consumidores externos que já
 * indexam por nome de canal (requisito explícito da issue #5496).
 */
export const CHANNEL_GROUP_KEYS: Record<string, readonly string[]> = deriveChannelGroupKeys(CHANNEL_KEY_SPECS);

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
  window?: CohortWindow,
): BeehiivBackupSubscriber[] {
  const keySet = normalizedChannelKeySet(canal);
  if (!keySet) return [];
  const matched = subs.filter((sub) => keySet.has(resolveGroupKey(toEngagementSubscriber(sub))));
  return window ? filterSubsByWindow(matched, window) : matched;
}

/** Mesmo que `subscribersForChannel`, mas casando contra UMA spec específica
 *  (`canal` + `subcanal` opcional) em vez do mapa legado por canal — é o
 *  caminho usado quando `spend.subcanal` está presente. Nunca aplica
 *  `spec.janela` sozinho (isso é responsabilidade de quem orquestra a janela
 *  efetiva — ver `buildCacReport` — pra poder combinar com a janela global
 *  `--desde/--ate` antes de filtrar uma única vez). @pure */
export function subscribersForChannelSpec(
  subs: BeehiivBackupSubscriber[],
  spec: ChannelKeySpec,
): BeehiivBackupSubscriber[] {
  const keySet = new Set(spec.keys.map(normalizeKey));
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
  /** Janela de atribuição EFETIVA aplicada a este canal — combinação da
   *  janela global (`--desde/--ate`, #5495) com a janela própria do
   *  sub-canal ambíguo (`ChannelKeySpec.janela`, #5496), quando houver
   *  qualquer uma das duas. `null` = nenhuma janela aplicada (comportamento
   *  de antes do #5495/#5496, acumulado desde sempre). */
  window: CohortWindow | null;
  /** Quantos assinantes deste canal foram descartados por não terem
   *  `created` sob `window` (#5495 — "descarte nunca silencioso"). `0`
   *  quando `window` é `null`. */
  excludedMissingCreated: number;
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
  opts: { previousChannelSubs?: BeehiivBackupSubscriber[]; window?: CohortWindow } = {},
): CacMeasuredRow {
  const window = opts.window ?? null;
  const excludedMissingCreated = window ? countSubsMissingCreated(channelSubs, window) : 0;
  const effectiveSubs = window ? filterSubsByWindow(channelSubs, window) : channelSubs;

  const engagementSubs = effectiveSubs.map(toEngagementSubscriber);
  const engagement = computeGroupEngagement(engagementSubs, { threshold: ENGAGEMENT_THRESHOLD_UNUSED });
  const leitores = countLeitoresV1(effectiveSubs);

  let aberturaAgregadaAnterior: number | null = null;
  let degradado: boolean | null = null;
  if (opts.previousChannelSubs) {
    const previousEffectiveSubs = window ? filterSubsByWindow(opts.previousChannelSubs, window) : opts.previousChannelSubs;
    const prevEngagement = computeGroupEngagement(previousEffectiveSubs.map(toEngagementSubscriber), {
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
    window,
    excludedMissingCreated,
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
  /** Canais (ou `canal/subcanal`) de `spend.csv` que não bateram com nenhuma
   *  spec de `CHANNEL_KEY_SPECS` nem com a string exata `"Beehiiv Boosts"` —
   *  a linha ainda aparece no relatório (`measured`, n=0/vazio, nunca some),
   *  mas cai aqui pra sinalizar "canal desconhecido, confira o nome exato
   *  em spend.csv" em vez de virar uma linha medida vazia sem aviso
   *  (finding 4 do self-review #5236, PR #5276). */
  unmappedChannels: string[];
  /** Inverso de `unmappedChannels` (#5502 Parte A): canais com assinantes
   *  atribuídos no snapshot mas SEM nenhuma linha em `spend.csv` — a linha
   *  simplesmente não existe no relatório (não há como aparecer "vazia"
   *  como um canal desconhecido aparece), então este é o único sinal de que
   *  o canal foi omitido. Ver `computeChannelsMissingSpend`. */
  channelsMissingSpend: string[];
  /** Janela global aplicada ao relatório inteiro (`--desde/--ate`, #5495) —
   *  `null` = nenhuma (comportamento acumulado desde sempre). Cada linha
   *  `measured` carrega sua PRÓPRIA janela efetiva em `row.window`
   *  (combinação desta com a janela do sub-canal, quando houver) — este
   *  campo é só o insumo global, pra procedência no relatório. */
  window: CohortWindow | null;
  /** Quantos assinantes (de TODA a base, antes de agrupar por canal) foram
   *  descartados por não terem `created` sob `window` — `0` quando `window`
   *  é `null` (#5495, "descarte nunca silencioso"). */
  excludedMissingCreated: number;
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

/** Combina duas janelas por INTERSECÇÃO (a mais restritiva de cada borda
 *  vence) — usada quando a janela global (`--desde/--ate`, #5495) e a janela
 *  própria de um sub-canal ambíguo (`ChannelKeySpec.janela`, #5496) estão
 *  ativas ao mesmo tempo. `undefined` em qualquer lado = "sem borda desse
 *  lado", a outra prevalece. @pure */
function intersectWindows(a: CohortWindow | undefined, b: CohortWindow | undefined): CohortWindow | undefined {
  if (!a) return b;
  if (!b) return a;
  const since = a.since == null ? b.since : b.since == null ? a.since : Math.max(a.since, b.since);
  const untilExclusive =
    a.untilExclusive == null ? b.untilExclusive : b.untilExclusive == null ? a.untilExclusive : Math.min(a.untilExclusive, b.untilExclusive);
  return { since, untilExclusive };
}

/** Rótulo de canal pra mensagens (`unmappedChannels`, warnings) — inclui o
 *  sub-canal quando presente (`"Google Ads/PMax"`), igual ao usado pro guard
 *  de dupla-contagem. @pure */
function spendChannelLabel(spend: SpendRow): string {
  return spend.subcanal ? `${spend.canal}/${spend.subcanal}` : spend.canal;
}

/**
 * Inverso de `unmappedChannels` (#5502 Parte A): canal com assinantes
 * ATRIBUÍDOS no snapshot (via `CHANNEL_KEY_SPECS`) mas SEM nenhuma linha
 * correspondente em `spend.csv` — hoje esse canal simplesmente não aparece
 * no relatório (o loop de `buildCacReport` é `spendRows.map`, dirigido pelo
 * CSV), o que é silencioso do jeito ERRADO pra uma comparação onde o gasto é
 * dado manual (#5502).
 *
 * Verificado no nível de CANAL (não canal/subcanal) — um canal com QUALQUER
 * linha em `spend.csv` (canal inteiro OU algum sub-canal) já conta como
 * "tem gasto", mesmo que outro sub-canal específico dele ainda não tenha
 * linha própria; sinalizar sub-canal ausente individualmente seria ruído
 * (ex: campanha nova ainda sem Search rodando não é a mesma classe de
 * problema que o canal inteiro nunca ter sido importado).
 *
 * Usa `subscribersForChannel` (mesmo caminho não-ambíguo de
 * `CHANNEL_GROUP_KEYS`) — canais ambíguos sem sub-canal explícito (ex: a
 * chave `google.com` de "Search") não entram aqui sozinhos, mesma disciplina
 * conservadora do resto do módulo. @pure
 */
export function computeChannelsMissingSpend(spendRows: SpendRow[], subs: BeehiivBackupSubscriber[]): string[] {
  const spendCanais = new Set(spendRows.map((r) => r.canal));
  const knownCanais = [...new Set(CHANNEL_KEY_SPECS.map((s) => s.canal))];
  const missing: string[] = [];
  for (const canal of knownCanais) {
    if (spendCanais.has(canal)) continue;
    if (subscribersForChannel(subs, canal).length > 0) missing.push(canal);
  }
  return missing;
}

/** Resolve os assinantes de UMA linha de `spend.csv` contra `CHANNEL_KEY_SPECS`
 *  (via sub-canal, quando `spend.subcanal` está presente) ou `CHANNEL_GROUP_KEYS`
 *  (canal inteiro, caminho legado). `subsPool` já deve estar filtrado pela
 *  janela GLOBAL quando houver — este helper só faz o match por chave; quem
 *  chama decide se ainda falta aplicar a janela do sub-canal (`specWindow`
 *  no retorno). @pure */
function resolveChannelSubs(
  spend: SpendRow,
  subsPool: BeehiivBackupSubscriber[],
): { subs: BeehiivBackupSubscriber[]; matched: boolean; specWindow?: CohortWindow } {
  if (spend.subcanal) {
    const spec = CHANNEL_KEY_SPECS.find((s) => s.canal === spend.canal && s.subcanal === spend.subcanal);
    if (!spec) return { subs: [], matched: false };
    return { subs: subscribersForChannelSpec(subsPool, spec), matched: true, specWindow: spec.janela };
  }
  if (CHANNEL_GROUP_KEYS[spend.canal]) {
    return { subs: subscribersForChannel(subsPool, spend.canal), matched: true };
  }
  return { subs: [], matched: false };
}

/** Recusa `spendRows` que misturem, no mesmo `(canal, mes)`, uma linha de
 *  CANAL INTEIRO (sem `subcanal`) com linha(s) de SUB-canal — dupla-contagem
 *  em `totalGastoMedido` (o total teria o gasto do canal inteiro E de suas
 *  partes somados). Lança em vez de somar em silêncio (#5496). @pure */
function assertNoMixedSubcanalRows(spendRows: SpendRow[]): void {
  // Guarda `canal`/`mes` como campos separados (nunca concatenados numa
  // unica string a re-splitar depois) - um `canal` com espaco no nome (ex:
  // "Google Ads") faria um `.replace(" ", ...)` ingenuo casar o espaco
  // ERRADO (entre "Google" e "Ads") em vez do separador entre canal e mes.
  const byCanalMes = new Map<string, { canal: string; mes: string; hasSubcanal: boolean; hasWhole: boolean }>();
  for (const row of spendRows) {
    const key = `${row.canal}\u0000${row.mes}`;
    const entry = byCanalMes.get(key) ?? { canal: row.canal, mes: row.mes, hasSubcanal: false, hasWhole: false };
    if (row.subcanal) entry.hasSubcanal = true;
    else entry.hasWhole = true;
    byCanalMes.set(key, entry);
  }
  const violations = [...byCanalMes.values()]
    .filter((v) => v.hasSubcanal && v.hasWhole)
    .map((v) => `${v.canal} / mês ${v.mes}`);
  if (violations.length > 0) {
    throw new Error(
      `[cac] spend.csv mistura linha de canal inteiro com linha(s) de sub-canal no mesmo canal/mês (dupla contagem): ` +
        `${violations.join(", ")}. Escolha um nível só por canal/mês — OU 1 linha do canal inteiro, OU 1+ linhas por sub-canal, nunca os dois.`,
    );
  }
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
 * `opts.window` (#5495) filtra a base inteira por `created` ANTES de
 * qualquer agregação (base metrics + por canal) — mesma disciplina de
 * `cohort-engagement.ts`: assinante sem `created` é excluído quando a janela
 * está ativa, nunca assumido dentro/fora silenciosamente. Combinada por
 * INTERSECÇÃO com a janela própria de sub-canais ambíguos (`ChannelKeySpec.janela`)
 * quando a linha usa `subcanal` — ver `row.window` em cada `CacMeasuredRow`.
 *
 * @pure
 */
export function buildCacReport(
  spendRows: SpendRow[],
  subs: BeehiivBackupSubscriber[],
  opts: {
    previousSubs?: BeehiivBackupSubscriber[];
    originApplied?: boolean;
    internalFiltered?: number;
    window?: CohortWindow;
  } = {},
): CacReport {
  assertNoMixedSubcanalRows(spendRows);

  const window = opts.window ?? null;
  // Base metrics (comparação "canal vs. base") refletem a janela global —
  // a base inteira é filtrada uma vez aqui. Por CANAL, a filtragem acontece
  // dentro de `computeMeasuredRow` (via `effectiveWindow` abaixo), a partir
  // do pool BRUTO (`subs`, não `windowedSubs`) — assim `row.excludedMissingCreated`
  // reflete o descarte relativo àquele canal especificamente, não já
  // pré-descontado por um filtro global aplicado antes do match por chave.
  const excludedMissingCreated = window ? countSubsMissingCreated(subs, window) : 0;
  const windowedSubs = window ? filterSubsByWindow(subs, window) : subs;

  const unmappedChannels: string[] = [];

  const rows: CacRow[] = spendRows.map((spend) => {
    const resolved = resolveChannelSubs(spend, subs);
    if (resolved.matched) {
      const effectiveWindow = intersectWindows(opts.window, resolved.specWindow);
      const resolvedPrevious = opts.previousSubs ? resolveChannelSubs(spend, opts.previousSubs).subs : undefined;
      return computeMeasuredRow(spend, resolved.subs, { previousChannelSubs: resolvedPrevious, window: effectiveWindow });
    }
    // Canal sem spec conhecida: tratado como boost-estimate SÓ se for
    // literalmente "Beehiiv Boosts" — qualquer outro canal desconhecido
    // ainda assim precisa aparecer (nunca desaparece do relatório por não
    // estar mapeado), então cai como "measured" com 0 assinantes
    // encontrados (honesto: n=0/vazio) em vez de silenciosamente virar uma
    // estimativa que não pediu pra ser.
    if (!spend.subcanal && spend.canal === "Beehiiv Boosts") {
      return computeBoostRow(spend);
    }
    // Nem CHANNEL_KEY_SPECS nem "Beehiiv Boosts" exato: canal (ou
    // canal/subcanal) DESCONHECIDO — ex: typo "Beehiiv Boost" sem "s", ou
    // "Meta"/"Microsoft Advertising" antes da spec entrar (#5493,
    // deliberadamente bloqueado até observação real). Warning explícito —
    // "parser tolerante mas barulhento" (issue #5236) vale pra nome de
    // canal não reconhecido, não só pra coluna faltando. Nunca abortar: a
    // linha entra como measured n=0/vazio de qualquer forma.
    const label = spendChannelLabel(spend);
    unmappedChannels.push(label);
    console.warn(
      `[cac] canal desconhecido "${label}" em spend.csv — linha tratada como measured vazio (n=0), confira o nome exato ` +
        `(esperado: um de ${Object.keys(CHANNEL_GROUP_KEYS).join(", ")}, um sub-canal de CHANNEL_KEY_SPECS, ou exatamente "Beehiiv Boosts").`,
    );
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
    base: computeBaseMetrics(windowedSubs),
    totalGastoMedido,
    internalFiltered: opts.internalFiltered ?? 0,
    originApplied: opts.originApplied ?? false,
    window,
    excludedMissingCreated,
    unmappedChannels,
    channelsMissingSpend: computeChannelsMissingSpend(spendRows, subs),
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
