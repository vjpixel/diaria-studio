/**
 * scripts/lib/ads-campaign-economics.ts (#7536, "Economia da campanha ao
 * vivo" — Google Ads + Microsoft Ads + Meta Ads, os 3 canais do teste 2608)
 *
 * Núcleo PURO/testável do que a tela `/ads` precisa pra responder, 3+ vezes
 * por dia, "o teste de 3 canais pagos (#5524) está indo bem?" sem esperar
 * o custo por leitor amadurecer (~02/10, ver #7536). Nenhuma chamada de
 * rede/disco aqui — `scripts/lib/ads-campaign-economics-fetch.ts` é quem
 * busca os dados (Google Ads GAQL, Microsoft Ads Reporting API, Meta Ads
 * Graph API, Kit API) e chama estas funções pra transformar em algo
 * renderizável. Genérico por canal (`ChannelDailyMetric.canal` é uma string
 * livre) — nenhuma mudança foi necessária aqui pra Meta Ads entrar.
 *
 * ## Os 5 requisitos de tela que vieram de MEDIÇÃO, não de gosto (issue)
 *
 * 1. O gráfico plota custo/cadastro ACUMULADO, nunca o diário — 30% dos
 *    dias reais de jan/2026 tiveram zero cadastro (divisão por zero).
 * 2. Escala compartilhada entre os canais no gráfico (não autoescala por
 *    linha) — implementado como `sharedYAxisMax` sobre TODA a série.
 * 3. Canal sem nenhum cadastro no período INTEIRO não ganha linha —
 *    `buildCumulativeSeries` filtra por `totalCadastros > 0` antes de
 *    gerar os pontos, nunca por dia isolado.
 * 4. Nada de média entre canais nos tiles — `buildTestStateTiles` só
 *    reporta estado do TESTE (orçamento, janela, sinal agregado), nunca
 *    uma média de custo/CPC entre braços; métrica por canal só em
 *    `buildChannelTable`.
 * 5. Indicador de idade/frescor por fonte — `computeSourceFreshness`.
 *
 * ## #8210 melhorias 1-2 (residual da issue, PR #8250 já fechou os 4 bugs)
 *
 * 1. **Funil por canal** (cliques → cadastros → ativos) — `ChannelSummaryRow`
 *    ganha `ativosTotal`/`ativosAmostraN`/`pctAtivo`, calculados a partir do
 *    STORE unificado (`data/diaria-subscribers/`, via `leitor-store.ts`/
 *    `subscribersForChannel` de `cac.ts` — `studio-ads.ts` monta o mapa e
 *    passa em `BuildChannelTableOptions.activeCountsByChannel`). Canal
 *    ausente do mapa (store não ingerido ainda nesta máquina) sai com
 *    `ativosTotal: null` — NUNCA `0` (mesmo invariante do Bug 3c).
 * 2. **Badge ativa/pausada por braço** — `computeCampaignPauseStatus` deriva
 *    de `AdsTestRunStateRevisao.pausas`, que é GLOBAL à campanha (os 3
 *    braços pausam/religam juntos — ver docstring de
 *    `AdsTestRunStateRevisao`), então o mesmo status vale pros 3 braços.
 *    `revisao` ausente (infra sem consumidor que a escreva ainda, ver
 *    CLAUDE.md) é `"desconhecido"` — NUNCA `"ativa"` por omissão.
 *
 * ## #8307 — dia sem veiculação não vira ponto no gráfico
 *
 * O requisito 1 acima já evita a leitura falsa no eixo Y (acumulado em vez
 * de diário). O #8307 fecha a mesma classe no eixo X: dia 100% dentro de
 * uma pausa NÃO recebe ponto, porque desenhá-lo produz um trecho horizontal
 * que lê como "o custo/cadastro ficou estável", quando o fato é "não houve
 * veiculação". Só o dia INTEIRAMENTE pausado some — dia parcial veiculou de
 * verdade (ver `isFullyPausedDate`). A acumulação continua atravessando os
 * dias pulados, então nenhum gasto/cadastro residual se perde.
 */

import {
  isDatePaused,
  normalizePauseIntervals,
  pausedFractionOfDay,
  veiculationDaysInRange,
  type AdsTestPauseInterval,
} from "./ads-test-pause-window.ts";
import { addDays } from "./ads-test-schedule.ts";
import type { AdsTestRunStateRevisao } from "./ads-test-run-state.ts";

// ---------------------------------------------------------------------------
// Tipos canônicos — o que os adaptadores Google/Microsoft normalizam pra cá
// ---------------------------------------------------------------------------

/** 1 linha de performance de UM canal em UM dia — já convertida pros
 *  adaptadores (`normalizeGoogleAdsPerformanceRows`/soma de
 *  `normalizeMicrosoftAdsPerformanceRowsByCampaign`, #8256). */
export interface ChannelDailyMetric {
  canal: string;
  /** `YYYY-MM-DD`. */
  date: string;
  gastoBrl: number;
  cliques: number;
  impressoes: number;
}

/** 1 linha de cadastros de UM canal em UM dia (Kit, `fields.utm_source`
 *  mapeado pro rótulo de canal — ver `ads-campaign-economics-fetch.ts`). */
export interface ChannelDailySignup {
  canal: string;
  /** `YYYY-MM-DD`. */
  date: string;
  cadastros: number;
}

// ---------------------------------------------------------------------------
// Requisitos 1-3: série acumulada por canal, escala compartilhada, sem
// canal fantasma
// ---------------------------------------------------------------------------

export interface CumulativeSeriesPoint {
  canal: string;
  date: string;
  gastoAcumuladoBrl: number;
  cadastrosAcumulados: number;
  /** `null` quando `cadastrosAcumulados === 0` (nunca 0/0 nem `Infinity`
   *  silencioso) — requisito 1 da issue. */
  custoPorCadastroAcumulado: number | null;
}

export interface CumulativeSeriesResult {
  /** 1 entrada por canal — SÓ canais com `totalCadastros > 0` no período
   *  inteiro (requisito 3). Ordem preservada da 1ª aparição em `metrics`. */
  series: Array<{ canal: string; points: CumulativeSeriesPoint[] }>;
  /** Maior `custoPorCadastroAcumulado` não-nulo de TODA a série — o eixo Y
   *  do gráfico usa este valor pra TODOS os canais (requisito 2, nunca
   *  autoescala por linha). `null` se nenhum canal tem ponto com custo
   *  calculável (nenhum ponto pra desenhar). */
  sharedYAxisMax: number | null;
  /** Canais que tinham métrica de gasto mas ZERO cadastro no período
   *  inteiro — omitidos de `series` por design (requisito 3), mas listados
   *  aqui pra a UI poder dizer "X gastou e não converteu nenhum cadastro"
   *  em vez de simplesmente não mencionar o canal. */
  omittedNoSignups: string[];
  /** #8475 Parte A — canais excluídos do gráfico por escala (ex.: Microsoft Ads). */
  omittedScale: string[];
  /** #8307 — datas do intervalo que ficaram FORA do gráfico por não terem
   *  tido veiculação nenhuma (dia 100% dentro de uma pausa). A UI usa isto
   *  pra dizer quantos dias sumiram, em vez de comprimir o eixo X em
   *  silêncio. Vazio quando nenhuma pausa foi informada. */
  skippedPausedDates: string[];
  /** As datas de fato plotadas, em ordem — `dateRangeInclusive` menos
   *  `skippedPausedDates`. Todo ponto de todo canal segue este eixo X
   *  comum (as pausas são da campanha inteira, nunca de um braço só). */
  plottedDates: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Todas as datas `YYYY-MM-DD` entre `start` e `end`, inclusive, em ordem
 *  crescente — usa `Date.UTC` só como calculadora de calendário (mesmo
 *  padrão de `ads-test-schedule.ts`, nunca fuso local/`Date.now()`). @pure */
function dateRangeInclusive(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  let cursor = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  while (cursor <= endMs) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60 * 1000;
  }
  return out;
}

/**
 * Dia SEM NENHUMA veiculação — a fração pausada cobre as 24h do dia BRT
 * (#8307).
 *
 * Critério DIFERENTE de `isDatePaused` de propósito, e a diferença é a
 * decisão da issue: `isDatePaused` responde "qualquer fração pausada?",
 * porque quem pergunta lá é ALARME/comparabilidade de janela (#8241/#8262),
 * onde o conservador é suspeitar do dia inteiro. Aqui quem pergunta é um
 * GRÁFICO de série temporal, e o conservador é o oposto: apagar um dia que
 * veiculou 20h (09/09, pausou 16:05; 17/09, religou 00:16) esconderia gasto
 * e cadastros reais daquele dia. Só some o dia em que nada rodou.
 *
 * Tolerância de 1 minuto em 24h (`>= 1 - 1/1440`) porque a fração vem de
 * aritmética de milissegundos sobre timestamps com offset: pausa que cobre
 * o dia inteiro pode sair 0,9999… por arredondamento, e um `>= 1` estrito
 * deixaria o dia plotado por causa de um erro de ponto flutuante.
 *
 * @pure
 */
function isFullyPausedDate(dateStr: string, intervals: readonly AdsTestPauseInterval[]): boolean {
  return pausedFractionOfDay(dateStr as Parameters<typeof pausedFractionOfDay>[0], intervals) >= 1 - 1 / 1440;
}

/**
 * Constrói a série acumulada por canal, dia a dia, dentro de
 * `[dateRange.start, dateRange.end]` — dia sem linha em `metrics`/`signups`
 * pra um canal conta como 0 NAQUELE dia, mas o acumulado segue carregando o
 * total anterior (nunca reseta). Canal cujo total de cadastros no período
 * inteiro é 0 é OMITIDO de `series` (requisito 3) — aparece só em
 * `omittedNoSignups` se teve QUALQUER gasto/clique/impressão no período
 * (canal sem NENHUM dado nas duas listas não aparece em lugar nenhum, não
 * há o que reportar).
 *
 * `opts.pauseIntervals` (#8307, normalizados por `normalizePauseIntervals`)
 * tira do gráfico as datas 100% pausadas — as datas efetivamente plotadas
 * saem em `plottedDates` e as puladas em `skippedPausedDates`. Omitir o
 * campo preserva o comportamento anterior (todo dia do intervalo vira
 * ponto), que é o que os callers sem pausa conhecida devem fazer.
 *
 * @pure
 */
export function buildCumulativeSeries(
  metrics: ChannelDailyMetric[],
  signups: ChannelDailySignup[],
  dateRange: { start: string; end: string },
  opts: { pauseIntervals?: readonly AdsTestPauseInterval[]; excludeChannels?: readonly string[] } = {},
): CumulativeSeriesResult {
  const channels = new Set<string>();
  for (const m of metrics) channels.add(m.canal);
  for (const s of signups) channels.add(s.canal);

  const dates = dateRangeInclusive(dateRange.start, dateRange.end);

  const gastoByChannelDate = new Map<string, number>();
  for (const m of metrics) gastoByChannelDate.set(`${m.canal}|${m.date}`, (gastoByChannelDate.get(`${m.canal}|${m.date}`) ?? 0) + m.gastoBrl);

  const cadastrosByChannelDate = new Map<string, number>();
  for (const s of signups) cadastrosByChannelDate.set(`${s.canal}|${s.date}`, (cadastrosByChannelDate.get(`${s.canal}|${s.date}`) ?? 0) + s.cadastros);

  // #8307: datas SEM NENHUMA veiculação (dia 100% dentro de uma pausa E sem
  // nenhum lançamento de gasto/cadastro) não viram ponto.
  //
  // A 2ª condição não é zelo (achado 2 do review da PR #8312): sem ela, um
  // lançamento em dia pausado só reaparece se existir um dia veiculado
  // DEPOIS dele — numa pausa em andamento (que cobre o fim do intervalo) não
  // existe, e gasto/cadastro real sumia do gráfico em silêncio. Dia em que
  // algo foi cobrado não é "nada aconteceu": é dado, e dado aparece.
  const hasActivityOnDate = (date: string): boolean => {
    for (const canal of channels) {
      if ((gastoByChannelDate.get(`${canal}|${date}`) ?? 0) !== 0) return true;
      if ((cadastrosByChannelDate.get(`${canal}|${date}`) ?? 0) !== 0) return true;
    }
    return false;
  };
  const skippedPausedDates =
    (opts.pauseIntervals?.length ?? 0) > 0
      ? dates.filter((d) => isFullyPausedDate(d, opts.pauseIntervals!) && !hasActivityOnDate(d))
      : [];
  const skippedSet = new Set(skippedPausedDates);
  const plottedDates = dates.filter((d) => !skippedSet.has(d));

  const excluded = new Set(opts.excludeChannels ?? []);
  const omittedScale: string[] = [];
  for (const c of Array.from(channels)) {
    if (excluded.has(c) && !omittedScale.includes(c)) omittedScale.push(c);
  }
  const series: Array<{ canal: string; points: CumulativeSeriesPoint[] }> = [];
  const omittedNoSignups: string[] = [];
  let sharedYAxisMax: number | null = null;

  for (const canal of Array.from(channels).sort()) {
    if (excluded.has(canal)) continue;
    let gastoAcumulado = 0;
    let cadastrosAcumulados = 0;
    const points: CumulativeSeriesPoint[] = [];
    for (const date of dates) {
      gastoAcumulado = round2(gastoAcumulado + (gastoByChannelDate.get(`${canal}|${date}`) ?? 0));
      cadastrosAcumulados += cadastrosByChannelDate.get(`${canal}|${date}`) ?? 0;
      // Dia pulado acumula (acima) mas não é plotado. Ele nunca carrega
      // lançamento nenhum (ver `hasActivityOnDate`), então pular não pode
      // esconder gasto/cadastro de ninguém.
      if (skippedSet.has(date)) continue;
      const custoPorCadastroAcumulado = cadastrosAcumulados > 0 ? round2(gastoAcumulado / cadastrosAcumulados) : null;
      points.push({ canal, date, gastoAcumuladoBrl: gastoAcumulado, cadastrosAcumulados, custoPorCadastroAcumulado });
      if (custoPorCadastroAcumulado !== null && (sharedYAxisMax === null || custoPorCadastroAcumulado > sharedYAxisMax)) {
        sharedYAxisMax = custoPorCadastroAcumulado;
      }
    }
    if (cadastrosAcumulados > 0) {
      series.push({ canal, points });
    } else if (gastoAcumulado > 0) {
      omittedNoSignups.push(canal);
    }
  }

  return { series, sharedYAxisMax, omittedNoSignups, omittedScale, skippedPausedDates, plottedDates };
}

// ---------------------------------------------------------------------------
// Requisito 4: tabela por canal (nunca média entre canais)
// ---------------------------------------------------------------------------

/** Origem do `gastoTotalBrl` de uma linha (#8210 Bug 3c) — nunca inferida
 *  implicitamente, sempre explícita na linha:
 *  - `"live"` — soma de `ChannelDailyMetric[]` da própria chamada (API
 *    respondeu, gasto real, inclusive quando o valor É zero).
 *  - `"manual"` — API falhou; caiu pro último gasto reconciliado à mão
 *    (`spend.csv`), com `gastoAsOf` marcando até quando esse valor é bom.
 *  - `"unknown"` — API falhou E não há fallback manual pra este canal.
 *    `gastoTotalBrl` é `null` aqui — NUNCA `0` (era o bug: canal com API
 *    fora do ar aparecia com "gasto R$ 0,00", parecendo o canal mais barato
 *    quando na verdade o dado é ausente). */
export type ChannelSpendSource = "live" | "manual" | "unknown";

export interface ChannelSummaryRow {
  canal: string;
  /** `null` quando `gastoFonte === "unknown"` — ver `ChannelSpendSource`. */
  gastoTotalBrl: number | null;
  gastoFonte: ChannelSpendSource;
  /** Data (`YYYY-MM-DD`) até quando o valor de `spend.csv` é conhecido bom
   *  — só preenchido quando `gastoFonte === "manual"`. */
  gastoAsOf: string | null;
  cliquesTotal: number;
  impressoesTotal: number;
  /** `null` sem cliques OU gasto desconhecido (divisão por zero/indefinida
   *  evitada explicitamente). */
  cpcMedioBrl: number | null;
  cadastrosTotal: number;
  /** `null` sem cadastros OU gasto desconhecido — NUNCA `0` quando o gasto
   *  é `unknown` (#8210 Bug 3c: "custo/cadastro R$ 0,00" enganava o canal
   *  como o mais barato quando a API só tinha falhado). */
  custoPorCadastroBrl: number | null;
  /** #8210 melhoria 1 — ativos no STORE unificado atribuídos a este canal.
   *  `null` quando o canal não está em `activeCountsByChannel` (store ainda
   *  não ingerido nesta máquina) — NUNCA `0` nesse caso (mesmo invariante do
   *  gasto desconhecido acima). */
  ativosTotal: number | null;
  /** "n" do `pctAtivo` — total de subscribers do canal no STORE. `0` quando
   *  `ativosTotal` é `null` (só pra não deixar `undefined` na resposta;
   *  quem consome já sabe checar `ativosTotal` primeiro). */
  ativosAmostraN: number;
  /** `ativosTotal / ativosAmostraN`, fração 0-1 — `null` sem amostra
   *  (`ativosAmostraN === 0`) ou sem dado (`ativosTotal === null`). Nunca
   *  exibir sem `ativosAmostraN` ao lado (requisito da issue — taxa sem `n`
   *  visível engana). */
  pctAtivo: number | null;
  /** #8210 melhoria 2 — mesmo valor pros 3 braços (pausas são da campanha
   *  inteira). */
  pauseStatus: CampaignPauseStatus;
}

/** Contagem de ativos por canal vinda do STORE unificado (#8210 melhoria 1)
 *  — `studio-ads.ts` monta isto filtrando o store pelas mesmas
 *  `CHANNEL_KEY_SPECS` de `cac.ts`/`subscribersForChannel`. */
export interface ChannelActiveCounts {
  ativos: number;
  /** Total de subscribers do STORE atribuídos a este canal — é o "n" do %
   *  ativo. Pode divergir de `cadastrosTotal` (que vem da API do Kit via
   *  `ads-campaign-economics-fetch.ts`, fonte diferente) — as duas contagens
   *  não são forçadas a bater. */
  totalNoStore: number;
}

/** ativa/pausada/desconhecido — ver `computeCampaignPauseStatus`. */
export type CampaignPauseStatus = "ativa" | "pausada" | "desconhecido";

export interface BuildChannelTableOptions {
  /** Canais cuja fonte de gasto AO VIVO falhou nesta chamada (a API do
   *  canal reportou `error`, não "gasto zero real") — vem de
   *  `sources`/`fetchCampaignEconomicsSources`, mapeado canal→erro pelo
   *  caller (`studio-ads.ts`). Canal aqui SEM entrada em `manualFallback`
   *  sai com `gastoFonte: "unknown"`, `gastoTotalBrl: null`. */
  channelsWithUnknownLiveSpend?: ReadonlySet<string>;
  /** Último gasto reconciliado à mão (`spend.csv`) por canal, usado só
   *  quando o canal está em `channelsWithUnknownLiveSpend` E não tem
   *  métricas ao vivo — nunca sobrepõe dado AO VIVO real (inclusive
   *  zero real, que é `gastoFonte: "live"`, não fallback). */
  manualFallback?: Readonly<Record<string, { totalBrl: number; asOfDate: string }>>;
  /** #8210 melhoria 1 — canal ausente daqui (store não ingerido nesta
   *  máquina) sai com `ativosTotal: null`/`pctAtivo: null`, nunca `0`. */
  activeCountsByChannel?: Readonly<Record<string, ChannelActiveCounts>>;
  /** #8210 melhoria 2 — aplicado uniformemente a TODAS as linhas (pausas
   *  são da campanha inteira, não por braço). Default `"desconhecido"`. */
  pauseStatus?: CampaignPauseStatus;
}

/**
 * 1 linha por canal, cada métrica calculada SÓ com os dados daquele canal
 * — nunca uma média/soma cruzando canais (requisito 4: os tiles são estado
 * do teste, a métrica por canal mora só aqui). Canal presente em `metrics`
 * mas ausente de `signups` ainda aparece, com `cadastrosTotal: 0` e
 * `custoPorCadastroBrl: null`.
 *
 * @pure
 */
export function buildChannelTable(
  metrics: ChannelDailyMetric[],
  signups: ChannelDailySignup[],
  opts: BuildChannelTableOptions = {},
): ChannelSummaryRow[] {
  const channelsWithUnknownLiveSpend = opts.channelsWithUnknownLiveSpend ?? new Set<string>();
  const manualFallback = opts.manualFallback ?? {};
  const activeCountsByChannel = opts.activeCountsByChannel ?? {};
  const pauseStatus = opts.pauseStatus ?? "desconhecido";

  const channels = new Set<string>();
  for (const m of metrics) channels.add(m.canal);
  for (const s of signups) channels.add(s.canal);
  // Canal só conhecido por ter uma fonte de gasto que FALHOU (sem nenhuma
  // métrica ao vivo e sem cadastro registrado ainda) também precisa
  // aparecer — senão a falha fica invisível em vez de virar linha "unknown".
  for (const canal of channelsWithUnknownLiveSpend) channels.add(canal);

  const rows: ChannelSummaryRow[] = [];
  for (const canal of Array.from(channels).sort()) {
    if (excluded.has(canal)) continue;
    const own = metrics.filter((m) => m.canal === canal);
    const cliquesTotal = own.reduce((sum, m) => sum + m.cliques, 0);
    const impressoesTotal = own.reduce((sum, m) => sum + m.impressoes, 0);
    const cadastrosTotal = signups.filter((s) => s.canal === canal).reduce((sum, s) => sum + s.cadastros, 0);

    let gastoTotalBrl: number | null;
    let gastoFonte: ChannelSpendSource;
    let gastoAsOf: string | null = null;
    if (own.length > 0 || !channelsWithUnknownLiveSpend.has(canal)) {
      // Dado AO VIVO real — inclusive quando `own` está vazio mas o canal
      // não está marcado como falho (ex: API respondeu, gasto genuinamente
      // zero no período): soma de `[]` é 0, e É um zero real.
      gastoTotalBrl = round2(own.reduce((sum, m) => sum + m.gastoBrl, 0));
      gastoFonte = "live";
    } else {
      const fallback = manualFallback[canal];
      if (fallback) {
        gastoTotalBrl = round2(fallback.totalBrl);
        gastoFonte = "manual";
        gastoAsOf = fallback.asOfDate;
      } else {
        gastoTotalBrl = null;
        gastoFonte = "unknown";
      }
    }

    const activeEntry = activeCountsByChannel[canal];
    const ativosTotal = activeEntry ? activeEntry.ativos : null;
    const ativosAmostraN = activeEntry ? activeEntry.totalNoStore : 0;

    rows.push({
      canal,
      gastoTotalBrl,
      gastoFonte,
      gastoAsOf,
      cliquesTotal,
      impressoesTotal,
      cpcMedioBrl: gastoTotalBrl != null && cliquesTotal > 0 ? round2(gastoTotalBrl / cliquesTotal) : null,
      cadastrosTotal,
      custoPorCadastroBrl: gastoTotalBrl != null && cadastrosTotal > 0 ? round2(gastoTotalBrl / cadastrosTotal) : null,
      ativosTotal,
      ativosAmostraN,
      pctAtivo: ativosTotal != null && ativosAmostraN > 0 ? round2(ativosTotal / ativosAmostraN) : null,
      pauseStatus,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// #8210 melhoria 2: badge ativa/pausada (aplicado uniformemente aos 3 braços
// — pausas são registradas pra campanha inteira, ver docstring de
// `AdsTestRunStateRevisao` em `ads-test-run-state.ts`)
// ---------------------------------------------------------------------------

/**
 * `revisao` ausente (nenhuma pausa jamais registrada, OU infra sem
 * consumidor que a escreva ainda — ver CLAUDE.md sobre `revisao.pausas`)
 * devolve `"desconhecido"`, NUNCA `"ativa"` — decisão explícita do editor
 * (#8210): dado ausente não vira presunção otimista.
 *
 * `revisao` aceita os DOIS formatos (hotfix desta função — #8283/#8284
 * combinados quebraram a leitura do formato real de produção, ver PR do
 * hotfix): o ATUAL `revisao.pausa` (singular, com hora — interpretado por
 * `normalizePauseIntervals`/`isDatePaused` de `ads-test-pause-window.ts`,
 * a ÚNICA fonte de verdade pra esse shape — nunca duplicar o parser aqui)
 * tem precedência quando presente; o formato ANTIGO `revisao.pausas`
 * (plural, só data) segue aceito por retrocompatibilidade quando `pausa`
 * está ausente. Nenhum dos dois presente → `"desconhecido"` (mesma leitura
 * de `revisao` ausente — dado insuficiente não vira presunção). `todayIso`
 * dentro de alguma pausa (qualquer fração do dia, formato atual; `desde`/
 * `ate` inclusivos, formato antigo) → `"pausada"`; caso contrário, com
 * pausa(s) conhecida(s), → `"ativa"`.
 *
 * @pure
 */
export function computeCampaignPauseStatus(
  revisao: AdsTestRunStateRevisao | undefined,
  todayIso: string,
): CampaignPauseStatus {
  if (!revisao) return "desconhecido";

  const currentFormatIntervals = normalizePauseIntervals(revisao.pausa);
  if (currentFormatIntervals.length > 0) {
    return isDatePaused(todayIso, currentFormatIntervals) ? "pausada" : "ativa";
  }

  if (revisao.pausas && revisao.pausas.length > 0) {
    const paused = revisao.pausas.some((p) => todayIso >= p.desde && todayIso <= p.ate);
    return paused ? "pausada" : "ativa";
  }

  return "desconhecido";
}

// ---------------------------------------------------------------------------
// Requisito 4 (contraparte): tiles de estado do TESTE, nunca média por canal
// ---------------------------------------------------------------------------

export interface TestStateTiles {
  /** `null` quando não há `run-state.json` (teste ainda não começou). */
  d0: string | null;
  fimJanela: string | null;
  /** `null` fora do período conhecido (sem `run-state.json`). Dias
   *  CORRIDOS desde `d0` — inclui dias de pausa (#8210 Bug 4b). */
  diasDecorridos: number | null;
  diasRestantes: number | null;
  /** Dias de veiculação REAL (`diasDecorridos` menos os dias/frações
   *  pausados de `runState.revisao.pausa` — formato ATUAL, com precedência
   *  — ou `runState.revisao.pausas` — formato ANTIGO, fallback; ver
   *  `effectivePauseIntervals`) — `null` quando `runState` ausente OU sem
   *  `revisao` registrada (nesse caso, ver `diasDecorridos`; #8210 Bug 4b —
   *  antes desta revisão existir, calendário e veiculação real eram
   *  indistinguíveis). Nunca negativo. */
  diasVeiculacaoReal: number | null;
  emAndamento: boolean;
  gastoAcumuladoTotalBrl: number;
  cadastrosAcumuladosTotal: number;
  /** Nº de canais (dentre os passados em `metrics`/`signups`) com pelo
   *  menos 1 cadastro no período — "sinal" no sentido do protocolo, nunca
   *  uma média de custo entre eles. */
  canaisComSinal: number;
  canaisTotal: number;
}

/**
 * `todayIso` no formato `YYYY-MM-DD` (mesma convenção de `ads-test-schedule.ts`).
 * `runState` é `null` quando `run-state.json` não existe — todos os campos
 * de data/janela saem `null`/`false`, mas os totais de gasto/cadastro ainda
 * são reportados (o teste pode ter dado registrado sem `run-state.json`
 * ainda sincronizado via OneDrive, #7083 — nunca esconder gasto real por
 * causa de um arquivo companheiro ausente).
 *
 * @pure
 */
/** Converte `revisao.pausas` (formato ANTIGO, só por DATA, inclusive nas
 *  duas pontas) em intervalos de INSTANTE (00:00 BRT do dia seguinte ao
 *  `ate`, exclusivo) — a mesma convenção semi-aberta que
 *  `AdsTestPauseInterval` usa em todo `ads-test-pause-window.ts`. Permite
 *  reusar `veiculationDaysInRange` (que só entende instantes) também pro
 *  formato antigo, em vez de manter uma 2ª aritmética paralela por string
 *  de data — foi justamente essa 2ª aritmética (baseline `diasDecorridos`,
 *  EXCLUSIVO na ponta inicial porque é "dias que já se passaram desde
 *  d0", contra um desconto somado sobre `[d0, todayIso]` INCLUSIVO) que
 *  cobrava o mesmo `d0` duas vezes quando ele caía dentro de uma pausa
 *  (#8293). @pure */
function legacyPausasToIntervals(pausas: readonly { desde: string; ate: string }[]): AdsTestPauseInterval[] {
  return pausas.map((p) => ({
    inicio: `${p.desde}T00:00:00-03:00`,
    fim: `${addDays(p.ate, 1)}T00:00:00-03:00`,
  }));
}

/** Intervalos de pausa efetivos de `revisao` pra fins de desconto de
 *  veiculação — formato ATUAL (`revisao.pausa`, singular, com hora) tem
 *  precedência quando presente; o formato ANTIGO (`revisao.pausas`,
 *  plural, só data) segue aceito por retrocompatibilidade quando `pausa`
 *  está ausente. Mesma precedência de `computeCampaignPauseStatus` acima
 *  — ambos delegam a `normalizePauseIntervals`/`ads-test-pause-window.ts`
 *  pra nunca duplicar o parser de pausa (ver docstring do topo do
 *  arquivo). @pure */
export function effectivePauseIntervals(revisao: AdsTestRunStateRevisao | undefined | null): AdsTestPauseInterval[] {
  if (!revisao) return [];
  const current = normalizePauseIntervals(revisao.pausa);
  if (current.length > 0) return current;
  return legacyPausasToIntervals(revisao.pausas ?? []);
}

export function buildTestStateTiles(
  metrics: ChannelDailyMetric[],
  signups: ChannelDailySignup[],
  runState: { d0: string; fim_janela: string; revisao?: AdsTestRunStateRevisao } | null,
  todayIso: string,
): TestStateTiles {
  const gastoAcumuladoTotalBrl = round2(metrics.reduce((sum, m) => sum + m.gastoBrl, 0));
  const cadastrosAcumuladosTotal = signups.reduce((sum, s) => sum + s.cadastros, 0);

  const channels = new Set<string>();
  for (const m of metrics) channels.add(m.canal);
  for (const s of signups) channels.add(s.canal);
  const cadastrosPorCanal = new Map<string, number>();
  for (const s of signups) cadastrosPorCanal.set(s.canal, (cadastrosPorCanal.get(s.canal) ?? 0) + s.cadastros);
  const canaisComSinal = [...channels].filter((c) => (cadastrosPorCanal.get(c) ?? 0) > 0).length;

  if (!runState) {
    return {
      d0: null,
      fimJanela: null,
      diasDecorridos: null,
      diasRestantes: null,
      diasVeiculacaoReal: null,
      emAndamento: false,
      gastoAcumuladoTotalBrl,
      cadastrosAcumuladosTotal,
      canaisComSinal,
      canaisTotal: channels.size,
    };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const toUtcMs = (iso: string): number => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const diasDecorridos = Math.round((toUtcMs(todayIso) - toUtcMs(runState.d0)) / dayMs);
  const diasRestantes = Math.round((toUtcMs(runState.fim_janela) - toUtcMs(todayIso)) / dayMs);
  const emAndamento = todayIso >= runState.d0 && todayIso <= runState.fim_janela;
  // `diasDecorridos` é EXCLUSIVO na ponta inicial — conta os dias na
  // janela `(d0, todayIso]`, não `[d0, todayIso]` (o próprio `d0` ainda
  // não "decorreu"). O contrato deste campo é "`diasDecorridos` menos os
  // dias pausados" (ver docstring de `diasVeiculacaoReal` acima) — mudar
  // esse baseline pra dias de CALENDÁRIO é decisão de produto separada
  // (fora de escopo, #8293), então o desconto de pausa usa a MESMA janela
  // exclusiva-no-início: `[addDays(d0, 1), todayIso]`. Antes deste fix, o
  // desconto rodava sobre `[d0, todayIso]` inclusivo — 1 dia maior do que
  // `diasDecorridos` — então uma pausa cobrindo o próprio `d0` descontava
  // um dia que `diasDecorridos` nunca tinha contado, cobrando-o 2x (o
  // off-by-one do #8293). Com a janela alinhada, `veiculationDaysInRange`
  // já devolve `diasDecorridos - pausa` diretamente — não precisa de uma
  // subtração separada. `revisao` presente sem nenhuma pausa registrada em
  // qualquer formato é "sem pausa" — `effectivePauseIntervals` devolve
  // lista vazia e o resultado cai de volta a `diasDecorridos` sem desconto
  // (nunca `null` nem exceção; `assertValidRunState` deixou de exigir
  // `pausas` em #8242 — antes disso `runState` nunca chegava aqui de
  // verdade). `revisao` AUSENTE (nenhuma pausa jamais registrada, infra
  // sem consumidor ainda) segue `null`, nunca uma presunção.
  const diasVeiculacaoReal = runState.revisao
    ? Math.max(0, veiculationDaysInRange(addDays(runState.d0, 1), todayIso, effectivePauseIntervals(runState.revisao)))
    : null;

  return {
    d0: runState.d0,
    fimJanela: runState.fim_janela,
    diasDecorridos,
    diasRestantes,
    diasVeiculacaoReal,
    emAndamento,
    gastoAcumuladoTotalBrl,
    cadastrosAcumuladosTotal,
    canaisComSinal,
    canaisTotal: channels.size,
  };
}

// ---------------------------------------------------------------------------
// Requisito 5: frescor por fonte
// ---------------------------------------------------------------------------

export type SourceFreshnessStatus = "ok" | "stale" | "error" | "unavailable";

export interface SourceFreshnessEntry {
  source: string;
  /** ISO, `null` quando a fonte nunca respondeu com sucesso nesta chamada
   *  (`status` já reflete isso — `"error"`/`"unavailable"`). */
  fetchedAt: string | null;
  ageMinutes: number | null;
  status: SourceFreshnessStatus;
  error: string | null;
}

/**
 * Classifica o frescor de cada fonte (`Google Ads`, `Microsoft Ads`, `Kit`)
 * — requisito 5 da issue ("com múltiplas APIs, frescuras divergem, e
 * ingestão pode simplesmente não rodar"). `staleAfterMinutes` default 30
 * (o dobro do TTL de cache mais curto sugerido pela issue, 15min) — uma
 * fonte que respondeu há mais que isso provavelmente está presa, não só
 * "última chamada bem-sucedida foi há um cache hit".
 *
 * @pure
 */
export function computeSourceFreshness(
  sources: Record<string, { fetchedAt: string | null; error: string | null }>,
  nowMs: number,
  staleAfterMinutes = 30,
): SourceFreshnessEntry[] {
  const out: SourceFreshnessEntry[] = [];
  for (const [source, info] of Object.entries(sources)) {
    if (info.error) {
      out.push({ source, fetchedAt: info.fetchedAt, ageMinutes: null, status: "error", error: info.error });
      continue;
    }
    if (!info.fetchedAt) {
      out.push({ source, fetchedAt: null, ageMinutes: null, status: "unavailable", error: null });
      continue;
    }
    const ageMinutes = Math.round((nowMs - new Date(info.fetchedAt).getTime()) / 60_000);
    out.push({
      source,
      fetchedAt: info.fetchedAt,
      ageMinutes,
      status: ageMinutes > staleAfterMinutes ? "stale" : "ok",
      error: null,
    });
  }
  return out;
}
