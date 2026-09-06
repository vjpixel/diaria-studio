/**
 * scripts/lib/ads-campaign-economics-fetch.ts (#7536, "Economia da
 * campanha ao vivo" — Google Ads + Microsoft Ads apenas; Meta Ads fica de
 * fora desta unidade, ver docstring de `scripts/meta-ads-ingest-spend.ts`
 * e o corpo da issue #7536 — hoje só é acessível via MCP dentro de uma
 * sessão Claude Code, não via REST server-side, e depende de o editor criar
 * um System User token no Business Manager).
 *
 * Orquestração de I/O (rede) por trás de `scripts/lib/ads-campaign-economics.ts`
 * (núcleo puro) — busca ao vivo, sob demanda, nunca via `spend.csv` (que só
 * agrega por MÊS): Google Ads GAQL diário + Microsoft Ads Reporting API
 * diária + cadastros por canal via Kit API. Fail-soft POR FONTE — uma fonte
 * falhando (credencial ausente, rede, quota) nunca derruba as outras 2; o
 * caller (`studio-ads.ts`) decide como apresentar `error`/`fetchedAt` de
 * cada uma (ver `computeSourceFreshness`).
 *
 * **Estruturado pra Meta entrar depois como só mais um caso na mesma
 * tabela/loop** (requisito explícito da issue) — `CampaignEconomicsSources`
 * já tem o formato `Record<string, ChannelFetchResult>`; adicionar `"Meta
 * Ads"` é 1 função `fetchMetaAdsChannelMetrics` a mais chamada em paralelo
 * com as 2 existentes, sem mudar a forma do resultado nem
 * `ads-campaign-economics.ts`.
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
// Kit — cadastros diários por canal (fields.utm_source, NUNCA attribution —
// ver docstring de kit-subscribers-ingest.ts sobre o bloco attribution vir
// sempre com utm_source nulo)
// ---------------------------------------------------------------------------

export interface FetchKitSignupsByChannelOptions {
  /** Mapeia `fields.utm_source` (normalizado lowercase/trim) → rótulo de
   *  canal usado em `ChannelDailySignup.canal` — default cobre os 2 canais
   *  desta unidade (`google-ads`, `microsoft-ads`); Meta entra aqui quando
   *  a unidade correspondente for implementada. */
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
  /** 1 entrada por fonte — `Google Ads`, `Microsoft Ads`, `Kit` — pra
   *  `computeSourceFreshness` (ads-campaign-economics.ts, requisito 5). */
  sources: Record<string, { fetchedAt: string | null; error: string | null }>;
}

export interface FetchCampaignEconomicsSourcesOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  lookbackDays?: number;
  kitDateRangeStart?: string;
}

/**
 * Busca Google Ads + Microsoft Ads + Kit EM PARALELO (`Promise.all` sobre 3
 * promises que já são fail-soft individualmente — uma rejeitando nunca
 * acontece, cada uma resolve com `{ error }` no pior caso). Credencial
 * ausente por completo (env sem as vars) é reportada como `error` da fonte,
 * não como exceção — mesma disciplina de "servidor sem GOOGLE_ADS_* ainda
 * não configurado" que os CLIs de ingestão já seguem.
 *
 * Meta Ads NÃO entra aqui (fora desta unidade, #7536) — `sources` só tem 3
 * chaves hoje; adicionar Meta é 1 `Promise` a mais no `Promise.all` sem
 * mudar a forma do resultado.
 */
export async function fetchCampaignEconomicsSources(
  fetchImpl: GoogleFetchLike & MicrosoftFetchLike,
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

  const kitPromise: Promise<KitSignupsFetchResult> = kitConfig
    ? fetchKitSignupsByChannel(kitConfig, { dateRangeStart: opts.kitDateRangeStart })
    : Promise.resolve({ signups: [], fetchedAt: null, error: "KIT_API_KEY não definida." });

  const [google, microsoft, kit] = await Promise.all([googlePromise, microsoftPromise, kitPromise]);

  return {
    metrics: [...google.metrics, ...microsoft.metrics],
    signups: kit.signups,
    sources: {
      "Google Ads": { fetchedAt: google.fetchedAt, error: google.error },
      "Microsoft Ads": { fetchedAt: microsoft.fetchedAt, error: microsoft.error },
      Kit: { fetchedAt: kit.fetchedAt, error: kit.error },
    },
  };
}
