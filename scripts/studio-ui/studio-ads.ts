/**
 * studio-ads.ts (#5236 Parte 3, fatia da EPIC "Studio UI" #3554)
 *
 * Camada de leitura pra `GET /api/ads`: a tela que responde as 4 perguntas
 * de 5 segundos da issue #5236 — qual canal traz leitor mais barato (e com
 * que `n`)? a coorte de cada canal lê mais ou menos que a base? quanto do
 * orçamento do mês já foi consumido? algum canal degradou desde o último
 * período? Mesmo padrão de `studio-tasks.ts`/`studio-utms.ts` — `server.ts`
 * só roteia, este arquivo monta o snapshot.
 *
 * **Reuso total do núcleo puro (#5236 requisito explícito).** Nenhuma
 * lógica de agrupamento/ranking é reimplementada aqui — `buildAdsData` só
 * carrega os 3 insumos do disco (mesmos helpers de I/O de
 * `scripts/cac-report.ts`: `loadOrigemIndex`/`loadPreparedSubscribers`) e
 * chama `buildCacReport`/`computeMonthBudgetUsage` de `scripts/lib/cac.ts`.
 *
 * **Sessão cloud (`data/` ausente) renderiza "sem dados" graciosamente,
 * nunca lança** (requisito explícito da issue) — `detectExecMode` decide o
 * eixo, mas o guard REAL é `existsSync` em cada arquivo/diretório
 * individual: mesmo em sessão `local`, `spend.csv` pode não existir ainda
 * (1ª execução antes do seed) e o snapshot Beehiiv pode não ter rodado —
 * cada camada tem seu próprio `error`/estado ausente, igual
 * `studio-utms.ts`/`studio-integrations.ts` (fail-soft por camada).
 *
 * **Cache + TTL** (10 min default — gasto muda ~1×/trimestre por decisão
 * explícita da issue "nenhuma task agendada... o relatório roda sob
 * demanda", então não há necessidade de TTL curto tipo `studio-tasks.ts`).
 * `forceRefresh` bypassa.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";
import { latestSnapshotDate, listSnapshotDates, type BeehiivBackupSubscriber } from "../lib/beehiiv-backup-snapshots.ts";
import { readSpendCsv, type SpendRow, type SpendRowError } from "../lib/aquisicao-spend.ts";
import {
  buildCacReport,
  computeMonthBudgetUsage,
  MONTHLY_BUDGET_FLOOR_BRL,
  filterInternalAndTestSubscribers,
  subscribersForChannel,
  type CacReport,
  type MonthBudgetUsage,
} from "../lib/cac.ts";
import { loadOrigemIndex, loadPreparedSubscribers } from "../cac-report.ts";
import { openDiariaSubscribersDbSafe } from "../lib/diaria-subscribers-db.ts";
import { buildCacCompatibleSubscribersFromStore } from "../lib/leitor-store.ts";
import { assertValidRunState, ADS_TEST_2608_BRACOS, type AdsTestRunState } from "../lib/ads-test-run-state.ts";
import { daysBetween } from "../lib/ads-test-schedule.ts";
import { resolveKitConfig } from "../lib/kit-config.ts";
import {
  fetchCampaignEconomicsSources,
  META_ADS_TESTE_CANAL,
  type CampaignEconomicsSourcesResult,
} from "../lib/ads-campaign-economics-fetch.ts";
import {
  buildCumulativeSeries,
  buildChannelTable,
  buildTestStateTiles,
  computeSourceFreshness,
  computeCampaignPauseStatus,
  effectivePauseIntervals,
  type CumulativeSeriesResult,
  type ChannelSummaryRow,
  type TestStateTiles,
  type CampaignPauseStatus,
  type SourceFreshnessEntry,
  type ChannelActiveCounts,
} from "../lib/ads-campaign-economics.ts";
import { type AdsTestPauseInterval } from "../lib/ads-test-pause-window.ts";
import {
  parseSocialFollowersJsonl,
  computeDailyBalances,
  type DailyFollowerBalanceResult,
} from "../lib/social-followers.ts";

// ─── tipos do snapshot ──────────────────────────────────────────────────

export interface AdsSpendLayer {
  path: string;
  rows: SpendRow[];
  rowErrors: SpendRowError[];
  /** Preenchido quando o arquivo está ausente/ilegível — `rows` fica `[]`. */
  error: string | null;
}

export interface AdsSnapshotLayer {
  root: string;
  date: string | null;
  previousDate: string | null;
  error: string | null;
}

export interface AdsOrigemLayer {
  applied: boolean;
  path: string;
}

export interface AdsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  /** `false` só quando `data/` inteiro está ausente (sessão cloud sem
   *  junction) — sinal de topo pra UI mostrar "sem dados" em vez de tabela
   *  vazia confusa. Camadas individuais (spend/snapshot) têm seus próprios
   *  `error` independente disso. */
  hasDataDir: boolean;
  spend: AdsSpendLayer;
  snapshot: AdsSnapshotLayer;
  origem: AdsOrigemLayer;
  /** `null` quando spend ou snapshot falharam (sem os dois insumos não há
   *  relatório pra montar). */
  report: CacReport | null;
  budget: MonthBudgetUsage | null;
  monthKey: string | null;
  /** Fonte dos SUBSCRIBERS usados em `report` (#8210 Bug 2) — `"store"`
   *  (store unificado, Kit+Beehiiv+Brevo diária via `leitor-store.ts`,
   *  caminho DEFAULT desde 17/09/2026) ou `"beehiiv-snapshot"` (fallback
   *  fail-soft — store ausente/ilegível nesta máquina, ex: nenhuma
   *  ingestão rodou ainda). `null` quando `report` é `null`. */
  subscribersSource: "store" | "beehiiv-snapshot" | null;
  /** Seguidores ganhos por dia — Instagram + Facebook (#8260 Fase 1). `null`
   *  quando `data/metrics/social-followers.jsonl` está ausente (task ainda
   *  não rodou nesta máquina, ou sessão cloud sem `data/`) — nunca uma
   *  série vazia disfarçada de "sem seguidor ganho". */
  followers: AdsFollowersLayer | null;
}

/** Camada "seguidores ganhos por dia" (#8260) — 1 série de saldo por
 *  plataforma + erros de parsing por linha (fail-soft, mesmo padrão de
 *  `AdsSpendLayer.rowErrors`). */
export interface AdsFollowersLayer {
  path: string;
  instagram: DailyFollowerBalanceResult;
  facebook: DailyFollowerBalanceResult;
  parseErrors: Array<{ line: number; reason: string }>;
}

// ─── construção (fail-soft por camada) ──────────────────────────────────

function loadSpendLayer(path: string): AdsSpendLayer {
  try {
    const { rows, errors } = readSpendCsv(path);
    return { path, rows, rowErrors: errors, error: null };
  } catch (e) {
    return { path, rows: [], rowErrors: [], error: (e as Error).message };
  }
}

/** Lê `data/metrics/social-followers.jsonl` e monta as 2 séries de saldo
 *  diário (IG + FB). Fail-soft: arquivo ausente/ilegível devolve `null`
 *  inteiro (nunca lança, nunca uma tabela vazia enganosa — ver docstring de
 *  `AdsSnapshot.followers`). */
function loadFollowersLayer(path: string): AdsFollowersLayer | null {
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { samples, errors } = parseSocialFollowersJsonl(content);
  return {
    path,
    instagram: computeDailyBalances(samples, "instagram"),
    facebook: computeDailyBalances(samples, "facebook"),
    parseErrors: errors,
  };
}

export interface BuildAdsDataOptions {
  now?: () => Date;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  backupRoot?: string;
  spendPath?: string;
  origemPath?: string;
  /** Store unificado (#8210 Bug 2) — default `data/diaria-subscribers/diaria-subscribers.db`. */
  storePath?: string;
  /** Seguidores ganhos por dia (#8260) — default `data/metrics/social-followers.jsonl`. */
  followersPath?: string;
  /** #8292: quando fornecido, usado no lugar de `loadStoreSubscribers(storePath)`
   *  — permite o caller (`handleApiAds`) compartilhar 1 única leitura do
   *  store entre `buildAdsData` e `buildAdsCampaignEconomics` no mesmo
   *  request, em vez de cada função reler o store do zero (era a causa dos
   *  77s×2 medidos em produção — #8283 somou uma 2ª leitura completa sem
   *  reusar a 1ª). Use `makeMemoizedStoreResultProvider` pra montar isto
   *  preguiçosamente (só lê se/quando alguém de fato pedir). */
  storeResultProvider?: () => StoreSubscribersResult | null;
}

/** Retorno de `loadStoreSubscribers` — nomeado pra ser reusável como tipo
 *  de `storeResultProvider` (#8292). */
export interface StoreSubscribersResult {
  subs: BeehiivBackupSubscriber[];
  internalFiltered: number;
}

/**
 * Carrega subscribers pro "custo por leitor" a partir do STORE UNIFICADO
 * (#8210 Bug 2) — caminho DEFAULT desde 17/09/2026, decisão do editor: o
 * store (`data/diaria-subscribers/`, Kit+Beehiiv+Brevo diária) substitui o
 * snapshot Beehiiv NESTA TELA, porque com `publishing.newsletter.backend =
 * "kit"` cadastro novo não passa pela Beehiiv — o snapshot ficava "cego"
 * aos braços de aquisição que mandam pro Kit. Nunca lança: store
 * ausente/ilegível (nenhuma ingestão rodou ainda nesta máquina) devolve
 * `null`, e o caller cai fail-soft pro snapshot Beehiiv antigo — degradado,
 * nunca uma tela vazia.
 *
 * Exportada (desde #8292) pra permitir que `handleApiAds` (`server.ts`)
 * monte um `storeResultProvider` memoizado compartilhado entre
 * `buildAdsData`/`buildAdsCampaignEconomics` — ver `BuildAdsDataOptions.storeResultProvider`. */
export function loadStoreSubscribers(
  storePath: string,
): StoreSubscribersResult | null {
  const db = openDiariaSubscribersDbSafe(storePath);
  if (!db) return null;
  try {
    const raw = buildCacCompatibleSubscribersFromStore(db);
    const { kept, removedCount } = filterInternalAndTestSubscribers(raw);
    return { subs: kept, internalFiltered: removedCount };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Monta um provider LAZY + MEMOIZADO de `StoreSubscribersResult` pra 1
 * `storePath` — chama `loadStoreSubscribers` no máximo 1 vez, na primeira
 * vez que algum caller de fato pedir o resultado (nunca eager: se os 2
 * caches de `buildAdsData`/`buildAdsCampaignEconomics` estiverem quentes,
 * nenhum dos dois chama o provider, e o store nunca é lido — preserva o
 * caminho rápido de cache-hit). Usado por `handleApiAds` (#8292) pra
 * compartilhar 1 única leitura do store entre as 2 funções no mesmo
 * request, em vez de cada uma reler o store do zero. */
export function makeMemoizedStoreResultProvider(
  storePath: string,
): () => StoreSubscribersResult | null {
  let called = false;
  let result: StoreSubscribersResult | null = null;
  return () => {
    if (!called) {
      result = loadStoreSubscribers(storePath);
      called = true;
    }
    return result;
  };
}

interface CacheEntry {
  data: AdsSnapshot;
  expiresAt: number;
}

/** Cache em memória por `rootDir` — mesmo espírito de `studio-tasks.ts`/`studio-utms.ts`. */
const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearAdsCache(): void {
  cacheByRoot.clear();
}

/**
 * Monta o snapshot completo pra `GET /api/ads`. Nunca lança — qualquer
 * falha de insumo vira campo `error` da camada correspondente (fail-soft,
 * mesmo padrão de `buildTasksData`/`buildUtmsData`).
 */
export function buildAdsData(rootDir: string, opts: BuildAdsDataOptions = {}): AdsSnapshot {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  const execMode = detectExecMode({ projectRoot: rootDir });
  const generatedAt = new Date(nowMs).toISOString();
  const hasDataDir = existsSync(resolve(rootDir, "data"));

  const backupRoot = opts.backupRoot ?? resolve(rootDir, "data", "beehiiv-backup");
  const spendPath = opts.spendPath ?? resolve(rootDir, "data", "aquisicao", "spend.csv");
  const origemPath = opts.origemPath ?? resolve(rootDir, "data", "aquisicao", "origem-original.json");
  const followersPath = opts.followersPath ?? resolve(rootDir, "data", "metrics", "social-followers.jsonl");

  const spendLayer = loadSpendLayer(spendPath);
  const followersLayer = loadFollowersLayer(followersPath);

  const dates = listSnapshotDates(backupRoot);
  const snapshotDate = latestSnapshotDate(backupRoot);
  const idx = snapshotDate ? dates.indexOf(snapshotDate) : -1;
  const previousDate = idx > 0 ? dates[idx - 1] : null;

  const snapshotLayer: AdsSnapshotLayer = {
    root: backupRoot,
    date: snapshotDate,
    previousDate,
    error: snapshotDate ? null : `nenhum snapshot encontrado em ${backupRoot}`,
  };

  const { index: origemIndex, applied: origemApplied } = loadOrigemIndex(origemPath);
  const origemLayer: AdsOrigemLayer = { applied: origemApplied, path: origemPath };

  let report: CacReport | null = null;
  let budget: MonthBudgetUsage | null = null;
  let monthKey: string | null = null;
  let subscribersSource: "store" | "beehiiv-snapshot" | null = null;

  if (spendLayer.error == null && spendLayer.rows.length > 0) {
    // Mesmo padrão de `backupRoot`/`spendPath`/`origemPath` acima — deriva de
    // `rootDir`, nunca do path absoluto default de `diaria-subscribers-db.ts`
    // (que é fixo no CHECKOUT, não no `rootDir` recebido — importante pra
    // teste com `rootDir` de tmpdir, e pra sessão que passa um root não-padrão).
    const storePath = opts.storePath ?? resolve(rootDir, "data", "diaria-subscribers", "diaria-subscribers.db");
    const storeResult = opts.storeResultProvider ? opts.storeResultProvider() : loadStoreSubscribers(storePath);
    if (storeResult) {
      // #8210 Bug 2: caminho DEFAULT — não depende de snapshot Beehiiv nem
      // de `previousDate` (o store não tem o conceito de "snapshot
      // anterior"; a tile de degradação some pra `null` quando este caminho
      // roda — ver docstring de `loadStoreSubscribers`).
      report = buildCacReport(spendLayer.rows, storeResult.subs, {
        originApplied: true, // atribuição já resolvida cross-plataforma — o mecanismo de "origem recuperada" é Beehiiv-específico, não se aplica aqui.
        internalFiltered: storeResult.internalFiltered,
      });
      subscribersSource = "store";
    } else if (snapshotDate) {
      // Fail-soft (#8210): store ainda não ingerido nesta máquina — volta
      // ao caminho antigo em vez de deixar a tela sem relatório nenhum.
      const { subs, internalFiltered } = loadPreparedSubscribers(backupRoot, snapshotDate, origemIndex);
      const previousSubs = previousDate ? loadPreparedSubscribers(backupRoot, previousDate, origemIndex).subs : undefined;
      report = buildCacReport(spendLayer.rows, subs, { previousSubs, originApplied: origemApplied, internalFiltered });
      subscribersSource = "beehiiv-snapshot";
    }
  }
  // #8210 Bug 4c: o tile "Orçamento" é sempre do MÊS CORRENTE (`now`), nunca
  // do mês do snapshot Beehiiv — um snapshot do mês anterior (ex: rodando
  // no dia 1º antes do snapshot semanal atualizar) mostrava o orçamento do
  // mês ERRADO. Independente de `report`/`snapshotDate` existirem — o
  // orçamento só precisa de `spend.csv`, nunca do snapshot.
  if (spendLayer.error == null && spendLayer.rows.length > 0) {
    monthKey = new Date(nowMs).toISOString().slice(0, 7);
    budget = computeMonthBudgetUsage(spendLayer.rows, monthKey, MONTHLY_BUDGET_FLOOR_BRL);
  }

  const data: AdsSnapshot = {
    execMode,
    generatedAt,
    cached: false,
    hasDataDir,
    spend: spendLayer,
    snapshot: snapshotLayer,
    origem: origemLayer,
    report,
    budget,
    monthKey,
    subscribersSource,
    followers: followersLayer,
  };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}

/** Nome da FONTE em `sourcesResult.sources` (chave fixa de
 *  `fetchCampaignEconomicsSources`) → nome do CANAL do teste 2608 em
 *  `spend.csv`/`ChannelSummaryRow.canal` — precisa pra traduzir "a fonte
 *  Google Ads falhou" em "o canal 'Google Ads (teste 2608)' tem gasto
 *  desconhecido" (#8210 Bug 3). */
const SOURCE_TO_TESTE_2608_CANAL: Readonly<Record<string, string>> = {
  "Google Ads": "Google Ads (teste 2608)",
  "Microsoft Ads": "Microsoft Ads (teste 2608)",
  "Meta Ads": META_ADS_TESTE_CANAL,
};

/** Último gasto reconciliado à mão por canal, lido de `spend.csv` — só
 *  usado como FALLBACK quando a fonte ao vivo daquele canal falhou (nunca
 *  sobrepõe dado ao vivo real, inclusive zero real). `asOfDate` é a data de
 *  modificação do PRÓPRIO `spend.csv` (proxy de "até quando esse número foi
 *  conferido" — o CSV não carrega uma data de reconciliação por linha;
 *  decisão pragmática registrada aqui, não uma garantia forte). Quando o
 *  canal tem mais de 1 linha (meses diferentes), usa o `mes` mais recente —
 *  é o número mais provável de ainda ser relevante. Nunca lança: arquivo
 *  ausente/ilegível vira mapa vazio (todo canal falho cai em "unknown"). */
function loadManualSpendFallback(
  spendPath: string,
): Record<string, { totalBrl: number; asOfDate: string }> {
  if (!existsSync(spendPath)) return {};
  let rows: SpendRow[];
  let asOfDate: string;
  try {
    rows = readSpendCsv(spendPath).rows;
    asOfDate = statSync(spendPath).mtime.toISOString().slice(0, 10);
  } catch {
    return {};
  }
  const latestByCanal = new Map<string, SpendRow>();
  for (const row of rows) {
    const current = latestByCanal.get(row.canal);
    if (!current || row.mes > current.mes) latestByCanal.set(row.canal, row);
  }
  const out: Record<string, { totalBrl: number; asOfDate: string }> = {};
  for (const [canal, row] of latestByCanal) out[canal] = { totalBrl: row.valor, asOfDate };
  return out;
}

// ─── #7536: "Economia da campanha ao vivo" (teste 2608) — Google Ads +
// Microsoft Ads + Meta Ads, os 3 canais (ver docstring de
// scripts/lib/ads-campaign-economics-fetch.ts) ─────────────────────────

export interface AdsCampaignEconomicsSnapshot {
  generatedAt: string;
  cached: boolean;
  hasDataDir: boolean;
  /** `null` quando `run-state.json` não existe (teste ainda não começou) —
   *  `buildTestStateTiles` já é fail-soft pra esse caso (datas/janela
   *  `null`, totais ainda reportados). */
  runState: AdsTestRunState | null;
  runStateError: string | null;
  cumulative: CumulativeSeriesResult;
  channels: ChannelSummaryRow[];
  testState: TestStateTiles;
  freshness: SourceFreshnessEntry[];
}

/** Lê `data/aquisicao/teste-2608/run-state.json` — fail-soft: arquivo
 *  ausente/corrompido nunca lança, só reporta `runStateError` (mesma
 *  disciplina de `loadRunState` em `scripts/ads-daily-digest.ts`, mas sem
 *  logar no console — quem consome é uma página HTTP, não um CLI). */
function loadRunStateFailSoft(path: string): { runState: AdsTestRunState | null; error: string | null } {
  if (!existsSync(path)) return { runState: null, error: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assertValidRunState(raw);
    return { runState: raw, error: null };
  } catch (e) {
    return { runState: null, error: (e as Error).message };
  }
}

export interface BuildAdsCampaignEconomicsOptions {
  now?: () => Date;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  runStatePath?: string;
  /** Fallback manual de gasto (#8210 Bug 3c) — default
   *  `data/aquisicao/spend.csv`, mesmo arquivo de `buildAdsData`. */
  spendPath?: string;
  /** Store unificado pro funil por canal (#8210 melhoria 1) — default
   *  `data/diaria-subscribers/diaria-subscribers.db`, mesmo arquivo de
   *  `buildAdsData`. */
  storePath?: string;
  /** #8292 — ver `BuildAdsDataOptions.storeResultProvider`: mesmo
   *  mecanismo, pra compartilhar 1 única leitura do store com
   *  `buildAdsData` no mesmo request em vez de reler do zero. */
  storeResultProvider?: () => StoreSubscribersResult | null;
  /** Injetáveis pra teste — default `fetch`/`process.env` reais. */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface CampaignEconomicsCacheEntry {
  data: AdsCampaignEconomicsSnapshot;
  expiresAt: number;
}

/** Cache SEPARADO do de `buildAdsData` (#7536) — fontes e TTL diferentes:
 *  este bate em 2 APIs de ads + Kit ao vivo (custoso, TTL curto, 10min
 *  default — a issue recomenda 5-15min pro requisito de "3+ consultas/dia
 *  com botão de atualizar"), aquele só lê arquivo local (barato, TTL de
 *  10min histórico do #5236 por motivo diferente — gasto muda pouco). */
const campaignEconomicsCacheByRoot = new Map<string, CampaignEconomicsCacheEntry>();

/** Usado só por testes, mesmo padrão de `clearAdsCache`. */
export function clearAdsCampaignEconomicsCache(): void {
  campaignEconomicsCacheByRoot.clear();
}

/**
 * Monta o snapshot de "Economia da campanha ao vivo" pra `GET /api/ads`
 * (#7536) — Google Ads + Microsoft Ads + Meta Ads via REST ao vivo (nunca
 * via `spend.csv`, que só agrega por MÊS) + cadastros por canal via Kit API.
 * **Assíncrona** (diferente de `buildAdsData`) — bate em rede de verdade;
 * mesmo padrão de `buildMetricsData` (`studio-metrics.ts`). Nunca lança:
 * cada fonte é fail-soft por conta própria
 * (`fetchCampaignEconomicsSources`), e a ausência de `run-state.json` só
 * degrada `runState`/`testState`, nunca aborta o cálculo dos outros campos.
 */
export async function buildAdsCampaignEconomics(
  rootDir: string,
  opts: BuildAdsCampaignEconomicsOptions = {},
): Promise<AdsCampaignEconomicsSnapshot> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;

  if (!opts.forceRefresh) {
    const cached = campaignEconomicsCacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  const generatedAt = new Date(nowMs).toISOString();
  const hasDataDir = existsSync(resolve(rootDir, "data"));
  const runStatePath = opts.runStatePath ?? resolve(rootDir, "data", "aquisicao", "teste-2608", "run-state.json");
  const { runState, error: runStateError } = loadRunStateFailSoft(runStatePath);

  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const kitConfigResult = resolveKitConfig(env);
  const kitConfig = kitConfigResult.ok ? kitConfigResult.config : null;

  // O lookback do GAQL/Reporting API precisa cobrir DO D0 até hoje, nunca um
  // fixo 30 dias (achado do self-review, #7536): a série acumulada começa em
  // `runState.d0` — se a página for aberta mais de 30 dias depois do D0 (ex:
  // revisitando o teste 2608 já em cauda, ~dia 35-40), um lookback fixo
  // perderia os primeiros dias de gasto e SUBESTIMARIA o acumulado em
  // silêncio, sem nenhum sinal de erro. `+1` inclusivo (D0..hoje). Sem
  // `run-state.json`, cai no default de 30 dias de `fetchGoogleAdsChannelMetrics`/
  // `fetchMicrosoftAdsChannelMetrics` (teste ainda não começou, nada a cobrir).
  const todayIsoForLookback = generatedAt.slice(0, 10);
  const lookbackDays = runState ? Math.max(daysBetween(runState.d0, todayIsoForLookback) + 1, 1) : undefined;

  const sourcesResult: CampaignEconomicsSourcesResult = await fetchCampaignEconomicsSources(
    (opts.fetchImpl ?? fetch) as typeof fetch,
    kitConfig,
    { env, now: now(), kitDateRangeStart: runState?.d0, lookbackDays },
  );
  // `fetchCampaignEconomicsSources` já reporta um erro genérico quando
  // `kitConfig` é `null` — sobrescreve com o motivo mais específico de
  // `resolveKitConfig` (ex: aponta pro `.env.example`), sem duplicar lógica.
  if (!kitConfigResult.ok) sourcesResult.sources.Kit = { fetchedAt: null, error: kitConfigResult.reason };

  const todayIso = generatedAt.slice(0, 10);
  const dateRange = {
    start: runState?.d0 ?? todayIso,
    end: runState?.fim_janela && runState.fim_janela < todayIso ? runState.fim_janela : todayIso,
  };

  // #8307 — os dias 100% pausados saem do gráfico. A leitura de
  // `revisao.pausa` mora no MESMO `try` degradante do `pauseStatus` abaixo
  // (mesmo motivo: `run-state.json` com timestamp invertido faz
  // `ads-test-pause-window.ts` lançar de propósito, e isso não pode derrubar
  // `GET /api/ads` inteiro). Pausa ilegível → `[]` → gráfico volta ao
  // comportamento pré-#8307 (plota todo dia do intervalo), nunca 500 e
  // nunca em silêncio: o motivo vai pro `runStateError` que a página
  // renderiza.
  let pauseIntervals: AdsTestPauseInterval[] = [];
  let pauseStatus: CampaignPauseStatus;
  let testState: TestStateTiles;
  let pauseReadError: string | null = null;
  try {
    pauseIntervals = effectivePauseIntervals(runState?.revisao);
    pauseStatus = computeCampaignPauseStatus(runState?.revisao, todayIso);
    testState = buildTestStateTiles(sourcesResult.metrics, sourcesResult.signups, runState, todayIso);
  } catch (e) {
    pauseReadError = `revisao.pausa inválida em run-state.json: ${(e as Error).message}`;
    pauseIntervals = [];
    pauseStatus = "desconhecido";
    // `null` no lugar de `runState`: os totais de gasto/cadastro continuam
    // reportados (mesmo invariante do `runState` ausente), só a janela do
    // teste sai `null` — nunca um número derivado de dado que não dá pra
    // interpretar.
    testState = buildTestStateTiles(sourcesResult.metrics, sourcesResult.signups, null, todayIso);
  }

  const cumulative = buildCumulativeSeries(sourcesResult.metrics, sourcesResult.signups, dateRange, { pauseIntervals });

  // #8210 Bug 3c: gasto desconhecido nunca vira 0 — canal cuja fonte ao vivo
  // falhou (`sourcesResult.sources[fonte].error`) cai pro último gasto
  // reconciliado em `spend.csv` (selo `gastoFonte: "manual"`), ou `null`
  // (`"unknown"`) se nem isso existir — nunca soma silenciosamente com 0.
  const channelsWithUnknownLiveSpend = new Set<string>();
  for (const [source, info] of Object.entries(sourcesResult.sources)) {
    if (!info.error) continue;
    const canal = SOURCE_TO_TESTE_2608_CANAL[source];
    if (canal) channelsWithUnknownLiveSpend.add(canal);
  }
  const manualFallback =
    channelsWithUnknownLiveSpend.size > 0
      ? loadManualSpendFallback(opts.spendPath ?? resolve(rootDir, "data", "aquisicao", "spend.csv"))
      : {};

  // #8210 melhoria 1 — funil cliques→cadastros→ativos: ativos vêm do STORE
  // unificado (mesmo caminho de `buildAdsData`/`loadStoreSubscribers`),
  // filtrado pelas MESMAS `CHANNEL_KEY_SPECS` que já casam os 3 nomes de
  // canal "(teste 2608)" (`ADS_TEST_2608_BRACOS`). Store ausente/ilegível
  // nesta máquina (nenhuma ingestão rodou ainda) deixa o mapa vazio — cada
  // linha sai com `ativosTotal: null`, nunca `0` (mesmo invariante do gasto
  // desconhecido, `buildChannelTable` acima).
  const storePath = opts.storePath ?? resolve(rootDir, "data", "diaria-subscribers", "diaria-subscribers.db");
  const storeResult = opts.storeResultProvider ? opts.storeResultProvider() : loadStoreSubscribers(storePath);
  const activeCountsByChannel: Record<string, ChannelActiveCounts> = {};
  if (storeResult) {
    for (const canal of ADS_TEST_2608_BRACOS) {
      const channelSubs = subscribersForChannel(storeResult.subs, canal);
      activeCountsByChannel[canal] = {
        ativos: channelSubs.filter((s) => s.status === "active").length,
        totalNoStore: channelSubs.length,
      };
    }
  }

  const channels = buildChannelTable(sourcesResult.metrics, sourcesResult.signups, {
    channelsWithUnknownLiveSpend,
    manualFallback,
    activeCountsByChannel,
    pauseStatus,
  });
  const freshness = computeSourceFreshness(sourcesResult.sources, nowMs);

  const data: AdsCampaignEconomicsSnapshot = {
    generatedAt,
    cached: false,
    hasDataDir,
    runState,
    // `pauseReadError` entra pelo mesmo campo que o erro de leitura do
    // arquivo (#8288): pra quem lê a página, "o run-state não deu pra
    // usar" é a mesma informação, venha de JSON malformado ou de
    // timestamp de pausa incoerente. Concatena em vez de sobrescrever —
    // os dois podem coexistir.
    runStateError: [runStateError, pauseReadError].filter(Boolean).join(" | ") || null,
    cumulative,
    channels,
    testState,
    freshness,
  };
  campaignEconomicsCacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}
