/**
 * scripts/lib/ads-campaign-economics-fetch.ts (#7536, "Economia da
 * campanha ao vivo" — Google Ads + Microsoft Ads + Meta Ads, os 3 canais do
 * teste 2608).
 *
 * Orquestração de I/O (rede) por trás de `scripts/lib/ads-campaign-economics.ts`
 * (núcleo puro) — busca ao vivo, sob demanda, nunca via `spend.csv` (que só
 * agrega por MÊS): Google Ads GAQL diário + Microsoft Ads Reporting API
 * diária + Meta Ads Graph API (`insights`) diária + cadastros por canal via
 * Kit API. Fail-soft POR FONTE — uma fonte falhando (credencial ausente,
 * rede, quota) nunca derruba as outras; o caller (`studio-ads.ts`) decide
 * como apresentar `error`/`fetchedAt` de cada uma (ver `computeSourceFreshness`).
 *
 * **Meta Ads entrou como só mais um caso na mesma tabela/loop** (requisito
 * explícito da issue, cumprido em 09/09/2026 quando o editor criou o
 * System User token — ver comentário da issue #7536) — `fetchMetaAdsChannelMetrics`
 * usa REST puro (Graph API `act_{id}/insights`, `META_ADS_ACCESS_TOKEN`),
 * igual Google/Microsoft: nenhum MCP, nenhuma sessão Claude no caminho.
 * Distinto de `scripts/lib/meta-ads-ingest.ts` (aquele normaliza um
 * envelope JÁ CAPTURADO via MCP pro caminho MENSAL de `spend.csv` — mantido
 * como está, fora de escopo desta unidade; este módulo é o caminho DIÁRIO
 * ao vivo do `/ads`, que não precisa do MCP porque o System User token dá
 * acesso REST direto).
 */

import {
  refreshGoogleAdsAccessToken,
  fetchGoogleAdsSpendRows,
  buildGoogleAdsPerformanceQuery,
  normalizeGoogleAdsPerformanceRows,
  type GoogleAdsAuthConfig,
  type GaqlPerformanceApiRow,
  type FetchLike as GoogleFetchLike,
} from "./google-ads-ingest.ts";
import {
  refreshMicrosoftAdsAccessToken,
  fetchMicrosoftAdsPerformanceRows,
  normalizeMicrosoftAdsPerformanceRows,
  ADS_DASHBOARD_PERFORMANCE_COLUMNS,
  type MicrosoftAdsAuthConfig,
  type FetchLike as MicrosoftFetchLike,
} from "./microsoft-ads-ingest.ts";
import { listKitSubscribersPage, type KitSubscriberSummary } from "./kit-subscribers.ts";
import type { KitConfig } from "./kit-config.ts";
import { META_ADS_AD_ACCOUNT_ID } from "./meta-ads-ingest.ts";
import type { ChannelDailyMetric, ChannelDailySignup } from "./ads-campaign-economics.ts";

export interface ChannelFetchResult {
  metrics: ChannelDailyMetric[];
  fetchedAt: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Resolução de credencial a partir do ambiente — mesmos nomes de variável
// dos CLIs de ingestão (`google-ads-ingest-spend.ts`/`microsoft-ads-ingest-spend.ts`),
// duplicado aqui (não importado deles) de propósito: aqueles arquivos são
// CLIs com `main()`/`isMainModule` — este módulo é consumido por um SERVIDOR
// long-running (`studio-ads.ts`), então resolve o env por conta própria em
// vez de acoplar a um script com efeitos colaterais de processo.
// ---------------------------------------------------------------------------

const GOOGLE_ADS_REQUIRED_ENV_VARS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const;

/** Espelha `authConfigFromEnv` de `scripts/google-ads-ingest-spend.ts` —
 *  ver a docstring de lá sobre `GOOGLE_PROJECT_ID` NÃO entrar aqui
 *  (é do servidor MCP/ADC, não deste caminho REST). Nunca lança. */
export function googleAdsAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { auth: GoogleAdsAuthConfig } | { missing: string[] } {
  const missing = GOOGLE_ADS_REQUIRED_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) return { missing };
  return {
    auth: {
      clientId: env.GOOGLE_ADS_CLIENT_ID!,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN!,
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN!,
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
      customerId: env.GOOGLE_ADS_CUSTOMER_ID!,
    },
  };
}

const MICROSOFT_ADS_ALWAYS_REQUIRED_ENV_VARS = ["MICROSOFT_ADS_DEVELOPER_TOKEN", "MICROSOFT_ADS_CUSTOMER_ID", "MICROSOFT_ADS_ACCOUNT_ID"] as const;
const MICROSOFT_ADS_AZURE_ENV_VARS = ["MICROSOFT_ADS_CLIENT_ID", "MICROSOFT_ADS_REFRESH_TOKEN"] as const;
const MICROSOFT_ADS_GOOGLE_ENV_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN"] as const;

/** Espelha `authConfigFromEnv` de `scripts/microsoft-ads-ingest-spend.ts`
 *  (mesma prioridade Google-antes-de-Azure-AD, ver docstring de lá). Nunca
 *  lança. */
export function microsoftAdsAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { auth: MicrosoftAdsAuthConfig } | { missing: string[] } {
  const missingAlways = MICROSOFT_ADS_ALWAYS_REQUIRED_ENV_VARS.filter((name) => !env[name]);
  const missingGoogle = MICROSOFT_ADS_GOOGLE_ENV_VARS.filter((name) => !env[name]);
  const missingAzure = MICROSOFT_ADS_AZURE_ENV_VARS.filter((name) => !env[name]);
  if (missingAlways.length > 0) return { missing: missingAlways };
  if (missingGoogle.length > 0 && missingAzure.length > 0) return { missing: [...missingGoogle, ...missingAzure] };
  return {
    auth: {
      clientId: env.MICROSOFT_ADS_CLIENT_ID,
      refreshToken: env.MICROSOFT_ADS_REFRESH_TOKEN,
      developerToken: env.MICROSOFT_ADS_DEVELOPER_TOKEN!,
      customerId: env.MICROSOFT_ADS_CUSTOMER_ID!,
      accountId: env.MICROSOFT_ADS_ACCOUNT_ID!,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      googleRefreshToken: env.MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN,
    },
  };
}

/** Resolve `{ accessToken }` do ambiente pra Meta Ads — bem mais simples que
 *  Google/Microsoft porque o System User token não expira (não há refresh
 *  token nem client secret nesse caminho, ver comentário da issue #7536).
 *  `META_ADS_AD_ACCOUNT_ID` NÃO é lido do ambiente de propósito — já é uma
 *  constante testada (`meta-ads-ingest.ts`), consistente com o pedido
 *  explícito da issue de nunca copiar esse ID solto de novo. Nunca lança. */
export function metaAdsAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { auth: { accessToken: string } } | { missing: string[] } {
  if (!env.META_ADS_ACCESS_TOKEN) return { missing: ["META_ADS_ACCESS_TOKEN"] };
  return { auth: { accessToken: env.META_ADS_ACCESS_TOKEN } };
}

// ---------------------------------------------------------------------------
// Google Ads — GAQL diário (gasto + cliques + impressões)
// ---------------------------------------------------------------------------

export interface FetchGoogleAdsChannelMetricsOptions {
  now?: Date;
  lookbackDays?: number;
  canal?: string;
}

/** Busca gasto/cliques/impressões diários do Google Ads pra `canal`. Nunca
 *  lança — qualquer falha (auth, rede, API) vira `{ metrics: [], error }`,
 *  mesma disciplina fail-soft de `runGoogleAdsIngest`. */
export async function fetchGoogleAdsChannelMetrics(
  fetchImpl: GoogleFetchLike,
  auth: GoogleAdsAuthConfig,
  opts: FetchGoogleAdsChannelMetricsOptions = {},
): Promise<ChannelFetchResult> {
  const now = opts.now ?? new Date();
  const canal = opts.canal ?? "Google Ads (teste 2608)";
  const lookbackDays = opts.lookbackDays ?? 30;

  const tokenResult = await refreshGoogleAdsAccessToken(fetchImpl, auth);
  if ("error" in tokenResult) return { metrics: [], fetchedAt: null, error: tokenResult.error };

  const query = buildGoogleAdsPerformanceQuery(now, lookbackDays);
  const spendResult = await fetchGoogleAdsSpendRows<GaqlPerformanceApiRow>(fetchImpl, auth, tokenResult.accessToken, query);
  if ("error" in spendResult) return { metrics: [], fetchedAt: null, error: spendResult.error };

  return { metrics: normalizeGoogleAdsPerformanceRows(spendResult.rows, canal), fetchedAt: now.toISOString(), error: null };
}

// ---------------------------------------------------------------------------
// Microsoft Ads — Reporting API diária (gasto + cliques + impressões)
// ---------------------------------------------------------------------------

export interface FetchMicrosoftAdsChannelMetricsOptions {
  now?: Date;
  lookbackDays?: number;
  canal?: string;
}

/** Busca gasto/cliques/impressões diários do Microsoft Ads pra `canal`,
 *  via `fetchMicrosoftAdsPerformanceRows` (#7536/#7539 — colunas
 *  estendidas). Nunca lança, mesma disciplina de `runMicrosoftAdsIngest`. */
export async function fetchMicrosoftAdsChannelMetrics(
  fetchImpl: MicrosoftFetchLike,
  auth: MicrosoftAdsAuthConfig,
  opts: FetchMicrosoftAdsChannelMetricsOptions = {},
): Promise<ChannelFetchResult> {
  const now = opts.now ?? new Date();
  const canal = opts.canal ?? "Microsoft Ads (teste 2608)";
  const lookbackDays = opts.lookbackDays ?? 30;

  const tokenResult = await refreshMicrosoftAdsAccessToken(fetchImpl, auth);
  if ("error" in tokenResult) return { metrics: [], fetchedAt: null, error: tokenResult.error };

  const end = new Date(now.getTime());
  const start = new Date(now.getTime() - (lookbackDays - 1) * 24 * 60 * 60 * 1000);
  const perfResult = await fetchMicrosoftAdsPerformanceRows(fetchImpl, auth, tokenResult.accessToken, { start, end }, {
    columns: ADS_DASHBOARD_PERFORMANCE_COLUMNS,
  });
  if ("error" in perfResult) return { metrics: [], fetchedAt: null, error: perfResult.error };

  return { metrics: normalizeMicrosoftAdsPerformanceRows(perfResult.rows, canal), fetchedAt: now.toISOString(), error: null };
}

// ---------------------------------------------------------------------------
// Meta Ads — Graph API `insights` diária (gasto + cliques + impressões)
// ---------------------------------------------------------------------------

/** Rótulo de canal usado nesta unidade (teste 2608) — distinto de
 *  `META_ADS_CANAL` (`"Meta"`, em `meta-ads-ingest.ts`), que é o nome
 *  RESERVADO usado pelo caminho mensal de `spend.csv`
 *  (`RESERVED_CHANNEL_NAMES` em `cac.ts`). Os dois namespaces não se
 *  confundem: aquele agrega por MÊS pro CAC report; este é 1 ponto por DIA
 *  pro gráfico acumulado do teste. */
export const META_ADS_TESTE_CANAL = "Meta Ads (teste 2608)";

/** Subconjunto de `fetch` usado — mesma assinatura de `GoogleFetchLike`/
 *  `MicrosoftFetchLike`, permite injetar mock em teste. */
export type MetaFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const META_GRAPH_API_VERSION_DEFAULT = "v21.0";
/** Teto de páginas — a `insights` com `time_increment=1` e `limit=100`
 *  nunca deveria precisar de mais que 1 página pro lookback de 30-90 dias
 *  desta unidade; existe só como guard de custo/latência (mesmo espírito de
 *  `maxPages` em `fetchKitSignupsByChannel` abaixo), nunca pra travar um
 *  caso real. */
const META_ADS_INSIGHTS_MAX_PAGES = 10;

/** 1 linha de `act_{id}/insights` já parseada (JSON) — `spend`/`clicks`/
 *  `impressions` vêm como STRING decimal na Graph API, nunca `number`
 *  (confirmado ao vivo em 09/09/2026, chamando `GET act_{id}/insights?
 *  time_increment=1&fields=spend,clicks,impressions,date_start` direto:
 *  o body raw devolve `"spend":"170.17"` — PONTO decimal, formato
 *  americano. O `87,65` citado no comentário da issue #7536 era a
 *  formatação PT-BR que a ferramenta MCP usou pra EXIBIR o número pro
 *  editor, não o valor literal do JSON — não confundir os dois. O parser
 *  aceita string OU number pela mesma cautela dupla de
 *  `GaqlPerformanceApiRow`, mas nunca precisa tratar vírgula. */
export interface MetaAdsInsightsApiRow {
  date_start?: string;
  date_stop?: string;
  spend?: string | number;
  clicks?: string | number;
  impressions?: string | number;
}

/** `{since, until}` (`YYYY-MM-DD`, calendário UTC) — mesma convenção de
 *  `buildGoogleAdsPerformanceQuery`/`fetchMicrosoftAdsChannelMetrics`
 *  acima: `now` menos `lookbackDays - 1` dias, inclusive nas duas pontas.
 *  @pure */
function toMetaAdsDateRange(now: Date, lookbackDays: number): { since: string; until: string } {
  const end = new Date(now.getTime());
  const start = new Date(now.getTime() - (lookbackDays - 1) * 24 * 60 * 60 * 1000);
  return { since: start.toISOString().slice(0, 10), until: end.toISOString().slice(0, 10) };
}

/** Normaliza `MetaAdsInsightsApiRow[]` (bruto, 1 linha por dia) pro shape
 *  canônico `ChannelDailyMetric` — linha sem `date_start` reconhecível é
 *  descartada (mesma disciplina de `normalizeGoogleAdsPerformanceRows`/
 *  `normalizeMicrosoftAdsPerformanceRows`: nunca contamina com 0
 *  silencioso). @pure */
export function normalizeMetaAdsInsightsRows(rows: MetaAdsInsightsApiRow[], canal: string): ChannelDailyMetric[] {
  const out: ChannelDailyMetric[] = [];
  for (const row of rows) {
    const date = row.date_start;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const toNum = (v: string | number | undefined): number => {
      if (v === undefined) return 0;
      const n = typeof v === "string" ? Number(v) : v;
      return Number.isFinite(n) ? n : 0;
    };
    out.push({
      canal,
      date,
      gastoBrl: Math.round(toNum(row.spend) * 100) / 100,
      cliques: toNum(row.clicks),
      impressoes: toNum(row.impressions),
    });
  }
  return out;
}

export interface FetchMetaAdsChannelMetricsOptions {
  now?: Date;
  lookbackDays?: number;
  canal?: string;
  /** Default `META_ADS_AD_ACCOUNT_ID` (constante testada, `meta-ads-ingest.ts`)
   *  — sem prefixo `act_`, este código monta o prefixo. Override só pra teste. */
  adAccountId?: string;
  apiVersion?: string;
  /** Override do host base — só pra teste (evita mock de `fetchImpl` só
   *  pra trocar o domínio, mesmo padrão de `meta-capi-staleness.ts`). */
  apiBaseUrl?: string;
  maxPages?: number;
}

/**
 * Busca gasto/cliques/impressões diários do Meta Ads pra `canal`, via Graph
 * API `act_{id}/insights?level=account&time_increment=1` (REST puro, sem
 * MCP — `accessToken` é o System User token criado pelo editor, `ads_read`,
 * sem expiração, ver comentário da issue #7536 de 09/09/2026). Nunca lança
 * — qualquer falha (rede, credencial inválida, erro do Graph API, corpo
 * não-JSON, paginação sem fim) vira `{ metrics: [], error }`, mesma
 * disciplina fail-soft de `fetchGoogleAdsChannelMetrics`/
 * `fetchMicrosoftAdsChannelMetrics`.
 */
export async function fetchMetaAdsChannelMetrics(
  fetchImpl: MetaFetchLike,
  accessToken: string,
  opts: FetchMetaAdsChannelMetricsOptions = {},
): Promise<ChannelFetchResult> {
  const now = opts.now ?? new Date();
  const canal = opts.canal ?? META_ADS_TESTE_CANAL;
  const lookbackDays = opts.lookbackDays ?? 30;
  const adAccountId = opts.adAccountId ?? META_ADS_AD_ACCOUNT_ID;
  const apiVersion = opts.apiVersion ?? META_GRAPH_API_VERSION_DEFAULT;
  const base = opts.apiBaseUrl ?? `https://graph.facebook.com/${apiVersion}`;
  const maxPages = opts.maxPages ?? META_ADS_INSIGHTS_MAX_PAGES;

  const { since, until } = toMetaAdsDateRange(now, lookbackDays);
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  let url = `${base}/act_${adAccountId}/insights?level=account&time_increment=1&time_range=${timeRange}&fields=spend,clicks,impressions&limit=100`;
  // Token vai no header Authorization, nunca na query string (#7893, mesmo
  // padrão do #7779) — passado em TODAS as páginas, não só a 1ª: o
  // `paging.next` que a Graph API devolve não reintroduz um access_token
  // que nunca esteve na URL original.
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const allRows: MetaAdsInsightsApiRow[] = [];
  let pages = 0;
  for (;;) {
    pages++;
    if (pages > maxPages) {
      return {
        metrics: [],
        fetchedAt: null,
        error: `fetchMetaAdsChannelMetrics: excedeu maxPages=${maxPages} sem chegar ao fim da paginação — abortando em vez de continuar indefinidamente.`,
      };
    }
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: authHeaders });
    } catch (e) {
      return { metrics: [], fetchedAt: null, error: `falha de rede no Graph API (Meta Ads insights): ${e instanceof Error ? e.message : e}` };
    }
    // Payload da Graph API — forma não é tipada aqui de propósito (erro e
    // sucesso têm shapes diferentes, ver checagem `payload?.error` abaixo).
    let payload: any;
    try {
      payload = await res.json();
    } catch (e) {
      return { metrics: [], fetchedAt: null, error: `Graph API (Meta Ads insights) respondeu corpo não-JSON (HTTP ${res.status}): ${e instanceof Error ? e.message : e}` };
    }
    if (!res.ok || payload?.error) {
      return {
        metrics: [],
        fetchedAt: null,
        error: `Graph API (Meta Ads insights) falhou (HTTP ${res.status}): ${payload?.error?.message ?? JSON.stringify(payload).slice(0, 300)}`,
      };
    }
    const data = Array.isArray(payload?.data) ? (payload.data as MetaAdsInsightsApiRow[]) : [];
    allRows.push(...data);
    const next = payload?.paging?.next;
    if (!next || typeof next !== "string") break;
    url = next;
  }

  return { metrics: normalizeMetaAdsInsightsRows(allRows, canal), fetchedAt: now.toISOString(), error: null };
}

// ---------------------------------------------------------------------------
// Kit — cadastros diários por canal (fields.utm_source, NUNCA attribution —
// ver docstring de kit-subscribers-ingest.ts sobre o bloco attribution vir
// sempre com utm_source nulo)
// ---------------------------------------------------------------------------

export interface FetchKitSignupsByChannelOptions {
  /** Mapeia `fields.utm_source` (normalizado lowercase/trim) → rótulo de
   *  canal usado em `ChannelDailySignup.canal` — default cobre os 3 canais
   *  do teste 2608 (`google-ads`, `microsoft-ads`, `meta-ads`). */
  utmSourceToCanal?: Record<string, string>;
  /** Só cadastros com `created_at >= dateRange.start` (comparação de string
   *  ISO, funciona porque `created_at` do Kit já vem em formato
   *  ordenável). `dateRange.end` não é aplicado (cadastros "até agora" —
   *  um teto no futuro não filtraria nada de útil e complicaria o teste). */
  dateRangeStart?: string;
  /** Teto de páginas pra nunca paginar a base inteira sem limite (guard
   *  de custo/latência — a issue aceita rate limit folgado neste volume,
   *  mas um bug de paginação não deveria travar a página do Studio). */
  maxPages?: number;
}

const DEFAULT_UTM_SOURCE_TO_CANAL: Record<string, string> = {
  "google-ads": "Google Ads (teste 2608)",
  "microsoft-ads": "Microsoft Ads (teste 2608)",
  "meta-ads": META_ADS_TESTE_CANAL,
};

export interface KitSignupsFetchResult {
  signups: ChannelDailySignup[];
  fetchedAt: string | null;
  error: string | null;
}

/**
 * Pagina `/v4/subscribers` (status `all` — cadastro de teste pode estar
 * `inactive` em double opt-in pendente) e agrega cadastros por dia+canal a
 * partir de `fields.utm_source` — NUNCA do bloco `attribution` (que vem
 * sempre com `utm_source` nulo pra assinatura via `diar.ia.br/subscribe`,
 * ver `docs`/memória `atribuicao-cadastro-kit-so-por-email`). Assinante sem
 * `fields.utm_source` reconhecido (não bate nenhuma chave de
 * `utmSourceToCanal`) é simplesmente ignorado — não é erro, é "não veio de
 * um canal pago rastreado aqui".
 *
 * Nunca lança — qualquer falha de rede/auth vira `{ signups: [], error }`.
 */
export async function fetchKitSignupsByChannel(
  config: KitConfig,
  opts: FetchKitSignupsByChannelOptions = {},
): Promise<KitSignupsFetchResult> {
  const utmSourceToCanal = opts.utmSourceToCanal ?? DEFAULT_UTM_SOURCE_TO_CANAL;
  const dateRangeStart = opts.dateRangeStart;
  const maxPages = opts.maxPages ?? 50;

  const countByChannelDate = new Map<string, number>();
  let after: string | undefined;
  let pages = 0;

  try {
    for (;;) {
      pages++;
      if (pages > maxPages) {
        return {
          signups: [],
          fetchedAt: null,
          error: `fetchKitSignupsByChannel: excedeu maxPages=${maxPages} sem chegar ao fim da paginação — abortando em vez de continuar indefinidamente.`,
        };
      }
      const { subscribers, pagination } = await listKitSubscribersPage({ perPage: 500, after, status: "all", config });
      for (const sub of subscribers as KitSubscriberSummary[]) {
        const utmSourceRaw = sub.fields?.utm_source;
        if (!utmSourceRaw) continue;
        const canal = utmSourceToCanal[utmSourceRaw.trim().toLowerCase()];
        if (!canal) continue;
        if (!sub.created_at) continue;
        const date = sub.created_at.slice(0, 10);
        if (dateRangeStart && date < dateRangeStart) continue;
        const key = `${canal}|${date}`;
        countByChannelDate.set(key, (countByChannelDate.get(key) ?? 0) + 1);
      }
      if (!pagination.has_next_page) break;
      if (!pagination.end_cursor) {
        return {
          signups: [],
          fetchedAt: null,
          error: "fetchKitSignupsByChannel: has_next_page=true sem end_cursor — lista truncada, abortando (mesmo guard de #7200/#6491).",
        };
      }
      after = pagination.end_cursor;
    }
  } catch (e) {
    return { signups: [], fetchedAt: null, error: e instanceof Error ? e.message : String(e) };
  }

  const signups: ChannelDailySignup[] = [...countByChannelDate.entries()].map(([key, cadastros]) => {
    const sep = key.lastIndexOf("|");
    return { canal: key.slice(0, sep), date: key.slice(sep + 1), cadastros };
  });
  return { signups, fetchedAt: new Date().toISOString(), error: null };
}

// ---------------------------------------------------------------------------
// Orquestração — as 3 fontes em paralelo, fail-soft cada uma
// ---------------------------------------------------------------------------

export interface CampaignEconomicsSourcesResult {
  metrics: ChannelDailyMetric[];
  signups: ChannelDailySignup[];
  /** 1 entrada por fonte — `Google Ads`, `Microsoft Ads`, `Meta Ads`, `Kit`
   *  — pra `computeSourceFreshness` (ads-campaign-economics.ts, requisito 5). */
  sources: Record<string, { fetchedAt: string | null; error: string | null }>;
}

export interface FetchCampaignEconomicsSourcesOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  lookbackDays?: number;
  kitDateRangeStart?: string;
}

/**
 * Busca Google Ads + Microsoft Ads + Meta Ads + Kit EM PARALELO (`Promise.all`
 * sobre 4 promises que já são fail-soft individualmente — uma rejeitando
 * nunca acontece, cada uma resolve com `{ error }` no pior caso). Credencial
 * ausente por completo (env sem as vars) é reportada como `error` da fonte,
 * não como exceção — mesma disciplina de "servidor sem GOOGLE_ADS_* ainda
 * não configurado" que os CLIs de ingestão já seguem.
 */
export async function fetchCampaignEconomicsSources(
  fetchImpl: GoogleFetchLike & MicrosoftFetchLike & MetaFetchLike,
  kitConfig: { apiKey: string } | null,
  opts: FetchCampaignEconomicsSourcesOptions = {},
): Promise<CampaignEconomicsSourcesResult> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? 30;

  const googleAuthResult = googleAdsAuthConfigFromEnv(env);
  const googlePromise: Promise<ChannelFetchResult> =
    "auth" in googleAuthResult
      ? fetchGoogleAdsChannelMetrics(fetchImpl, googleAuthResult.auth, { now, lookbackDays })
      : Promise.resolve({
          metrics: [],
          fetchedAt: null,
          error: `GOOGLE_ADS_*: variável(is) de ambiente ausente(s): ${googleAuthResult.missing.join(", ")}`,
        });

  const microsoftAuthResult = microsoftAdsAuthConfigFromEnv(env);
  const microsoftPromise: Promise<ChannelFetchResult> =
    "auth" in microsoftAuthResult
      ? fetchMicrosoftAdsChannelMetrics(fetchImpl, microsoftAuthResult.auth, { now, lookbackDays })
      : Promise.resolve({
          metrics: [],
          fetchedAt: null,
          error: `MICROSOFT_ADS_*: variável(is) de ambiente ausente(s): ${microsoftAuthResult.missing.join(", ")}`,
        });

  const metaAuthResult = metaAdsAuthConfigFromEnv(env);
  const metaPromise: Promise<ChannelFetchResult> =
    "auth" in metaAuthResult
      ? fetchMetaAdsChannelMetrics(fetchImpl, metaAuthResult.auth.accessToken, { now, lookbackDays })
      : Promise.resolve({
          metrics: [],
          fetchedAt: null,
          error: `META_ADS_*: variável(is) de ambiente ausente(s): ${metaAuthResult.missing.join(", ")}`,
        });

  const kitPromise: Promise<KitSignupsFetchResult> = kitConfig
    ? fetchKitSignupsByChannel(kitConfig, { dateRangeStart: opts.kitDateRangeStart })
    : Promise.resolve({ signups: [], fetchedAt: null, error: "KIT_API_KEY não definida." });

  const [google, microsoft, meta, kit] = await Promise.all([googlePromise, microsoftPromise, metaPromise, kitPromise]);

  return {
    metrics: [...google.metrics, ...microsoft.metrics, ...meta.metrics],
    signups: kit.signups,
    sources: {
      "Google Ads": { fetchedAt: google.fetchedAt, error: google.error },
      "Microsoft Ads": { fetchedAt: microsoft.fetchedAt, error: microsoft.error },
      "Meta Ads": { fetchedAt: meta.fetchedAt, error: meta.error },
      Kit: { fetchedAt: kit.fetchedAt, error: kit.error },
    },
  };
}
