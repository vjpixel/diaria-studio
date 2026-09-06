/**
 * scripts/lib/ads-campaign-economics.ts (#7536, "Economia da campanha ao
 * vivo" — escopo Google Ads + Microsoft Ads, Meta Ads fora desta unidade)
 *
 * Núcleo PURO/testável do que a tela `/ads` precisa pra responder, 3+ vezes
 * por dia, "o teste de 3 canais pagos (#5524) está indo bem?" sem esperar
 * o custo por leitor amadurecer (~02/10, ver #7536). Nenhuma chamada de
 * rede/disco aqui — `scripts/lib/ads-campaign-economics-fetch.ts` é quem
 * busca os dados (Google Ads GAQL, Microsoft Ads Reporting API, Kit API) e
 * chama estas funções pra transformar em algo renderizável.
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
 */

// ---------------------------------------------------------------------------
// Tipos canônicos — o que os adaptadores Google/Microsoft normalizam pra cá
// ---------------------------------------------------------------------------

/** 1 linha de performance de UM canal em UM dia — já convertida pros
 *  adaptadores (`normalizeGoogleAdsPerformanceRows`/`normalizeMicrosoftAdsPerformanceRows`). */
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
 * Constrói a série acumulada por canal, dia a dia, dentro de
 * `[dateRange.start, dateRange.end]` — dia sem linha em `metrics`/`signups`
 * pra um canal conta como 0 NAQUELE dia, mas o acumulado segue carregando o
 * total anterior (nunca reseta). Canal cujo total de cadastros no período
 * inteiro é 0 é OMITIDO de `series` (requisito 3) — aparece só em
 * `omittedNoSignups` se teve QUALQUER gasto/clique/impressão no período
 * (canal sem NENHUM dado nas duas listas não aparece em lugar nenhum, não
 * há o que reportar).
 *
 * @pure
 */
export function buildCumulativeSeries(
  metrics: ChannelDailyMetric[],
  signups: ChannelDailySignup[],
  dateRange: { start: string; end: string },
): CumulativeSeriesResult {
  const channels = new Set<string>();
  for (const m of metrics) channels.add(m.canal);
  for (const s of signups) channels.add(s.canal);

  const dates = dateRangeInclusive(dateRange.start, dateRange.end);

  const gastoByChannelDate = new Map<string, number>();
  for (const m of metrics) gastoByChannelDate.set(`${m.canal}|${m.date}`, (gastoByChannelDate.get(`${m.canal}|${m.date}`) ?? 0) + m.gastoBrl);

  const cadastrosByChannelDate = new Map<string, number>();
  for (const s of signups) cadastrosByChannelDate.set(`${s.canal}|${s.date}`, (cadastrosByChannelDate.get(`${s.canal}|${s.date}`) ?? 0) + s.cadastros);

  const series: Array<{ canal: string; points: CumulativeSeriesPoint[] }> = [];
  const omittedNoSignups: string[] = [];
  let sharedYAxisMax: number | null = null;

  for (const canal of channels) {
    let gastoAcumulado = 0;
    let cadastrosAcumulados = 0;
    const points: CumulativeSeriesPoint[] = [];
    for (const date of dates) {
      gastoAcumulado = round2(gastoAcumulado + (gastoByChannelDate.get(`${canal}|${date}`) ?? 0));
      cadastrosAcumulados += cadastrosByChannelDate.get(`${canal}|${date}`) ?? 0;
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

  return { series, sharedYAxisMax, omittedNoSignups };
}

// ---------------------------------------------------------------------------
// Requisito 4: tabela por canal (nunca média entre canais)
// ---------------------------------------------------------------------------

export interface ChannelSummaryRow {
  canal: string;
  gastoTotalBrl: number;
  cliquesTotal: number;
  impressoesTotal: number;
  /** `null` sem cliques (divisão por zero evitada explicitamente). */
  cpcMedioBrl: number | null;
  cadastrosTotal: number;
  /** `null` sem cadastros. */
  custoPorCadastroBrl: number | null;
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
export function buildChannelTable(metrics: ChannelDailyMetric[], signups: ChannelDailySignup[]): ChannelSummaryRow[] {
  const channels = new Set<string>();
  for (const m of metrics) channels.add(m.canal);
  for (const s of signups) channels.add(s.canal);

  const rows: ChannelSummaryRow[] = [];
  for (const canal of channels) {
    const own = metrics.filter((m) => m.canal === canal);
    const gastoTotalBrl = round2(own.reduce((sum, m) => sum + m.gastoBrl, 0));
    const cliquesTotal = own.reduce((sum, m) => sum + m.cliques, 0);
    const impressoesTotal = own.reduce((sum, m) => sum + m.impressoes, 0);
    const cadastrosTotal = signups.filter((s) => s.canal === canal).reduce((sum, s) => sum + s.cadastros, 0);
    rows.push({
      canal,
      gastoTotalBrl,
      cliquesTotal,
      impressoesTotal,
      cpcMedioBrl: cliquesTotal > 0 ? round2(gastoTotalBrl / cliquesTotal) : null,
      cadastrosTotal,
      custoPorCadastroBrl: cadastrosTotal > 0 ? round2(gastoTotalBrl / cadastrosTotal) : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Requisito 4 (contraparte): tiles de estado do TESTE, nunca média por canal
// ---------------------------------------------------------------------------

export interface TestStateTiles {
  /** `null` quando não há `run-state.json` (teste ainda não começou). */
  d0: string | null;
  fimJanela: string | null;
  /** `null` fora do período conhecido (sem `run-state.json`). */
  diasDecorridos: number | null;
  diasRestantes: number | null;
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
export function buildTestStateTiles(
  metrics: ChannelDailyMetric[],
  signups: ChannelDailySignup[],
  runState: { d0: string; fim_janela: string } | null,
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

  return {
    d0: runState.d0,
    fimJanela: runState.fim_janela,
    diasDecorridos,
    diasRestantes,
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
