/**
 * scripts/lib/microsoft-ads-ingest.ts (#5502 Parte B)
 *
 * Adaptador Microsoft Advertising (Bing Ads) do motor genérico
 * `scripts/lib/spend-ingest.ts` — espelha `google-ads-ingest.ts` (#5237): um
 * núcleo de NORMALIZAÇÃO puro/testável contra fixture (sem depender de
 * credencial pra rodar em CI, mesma disciplina de
 * `test/google-ads-ingest-5237.test.ts`) + uma orquestração fail-soft
 * injetável (`runMicrosoftAdsIngest`) que nunca lança — o CLI
 * (`scripts/microsoft-ads-ingest-spend.ts`) é quem de fato chama a API e
 * escreve em disco.
 *
 * ## Formato consumido: `CampaignPerformanceReport` da Reporting API
 *
 * A Reporting API do Microsoft Advertising devolve relatórios como CSV/TSV
 * (não JSON como a GAQL do Google) via um fluxo assíncrono de 2 passos
 * (submeter → poll até "Success" → baixar). O que importa pra normalização
 * (`aggregateMicrosoftAdsSpendByMonth` abaixo) é só a FORMA de cada linha já
 * parseada — `TimePeriod` (a API devolve `MM/DD/YYYY` por padrão) e `Spend`
 * (decimal com PONTO, moeda da conta) — este módulo aceita as duas
 * variações de formato de data mais prováveis (`MM/DD/YYYY` e `YYYY-MM-DD`)
 * pra não quebrar se o parsing do CSV upstream mudar a serialização.
 *
 * `fetchMicrosoftAdsSpendRows` abaixo modela o fluxo como uma ÚNICA chamada
 * fail-soft (submissão + poll + parse já resolvidos em `rows`) — o detalhe
 * de poll/backoff real fica no CLI/infra que implementar a chamada de fato
 * (não testável sem credencial; ver `docs/microsoft-ads-api-setup.md`), o
 * mesmo espírito de `fetchGoogleAdsSpendRows` (esconder a mecânica HTTP
 * atrás de uma função fail-soft, testável com um `fetchImpl` mockado).
 *
 * ## Por que fail-soft é o comportamento CORRETO aqui (mesma disciplina do
 * #5237/#5502)
 *
 * Sem credencial (`MICROSOFT_ADS_*` ausente do ambiente) é o estado ESPERADO
 * hoje — nenhuma campanha Microsoft roda ainda (#5493). O adaptador precisa
 * degradar pro CSV manual sem quebrar `cac-report.ts` nem lançar stack cru —
 * nunca `process.exit` de dentro deste módulo.
 */

import type { SpendRow } from "./aquisicao-spend.ts";
import { runSpendIngest, type SpendIngestFetchResult } from "./spend-ingest.ts";

// ---------------------------------------------------------------------------
// Parsing CampaignPerformanceReport → SpendRow (puro)
// ---------------------------------------------------------------------------

/** Uma linha já parseada do `CampaignPerformanceReport` (CSV/TSV → objeto) —
 *  `TimePeriod` em `MM/DD/YYYY` (formato default da Reporting API) ou
 *  `YYYY-MM-DD`; `Spend` decimal com ponto, string ou number (mesma cautela
 *  de `GaqlSpendApiRow.metrics.costMicros` — o parser CSV upstream pode
 *  devolver os dois). */
export interface MicrosoftAdsReportRow {
  TimePeriod?: string;
  Spend?: string | number;
}

export interface AggregateMicrosoftAdsSpendOptions {
  canal: string;
  moeda: string;
  /** Prefixo da coluna `fonte` — a função acrescenta o range de datas agregado. */
  fonteLabel: string;
}

/** `true` quando mês/dia estão em faixa válida (01-12 / 01-31) — regex sozinha
 *  aceitaria "2026-13-99", que não é uma data. @pure */
function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** `MM/DD/YYYY` (formato default da Reporting API) → `AAAA-MM-DD`. `null`
 *  se não casar o padrão ou tiver mês/dia fora de faixa — nunca adivinha.
 *  @pure */
function normalizeMicrosoftDate(raw: string): string | null {
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    const month = Number(m);
    const day = Number(d);
    if (!isValidMonthDay(month, day)) return null;
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const [, , m, d] = ymd;
    if (!isValidMonthDay(Number(m), Number(d))) return null;
    return raw;
  }
  return null;
}

/**
 * Agrupa linhas do `CampaignPerformanceReport` por mês (`AAAA-MM`), somando
 * `Spend`. Linha sem `TimePeriod` reconhecível ou sem `Spend` parseável é
 * IGNORADA (não tem mês pra agrupar) — nunca contamina a soma como 0, mesma
 * disciplina de `aggregateGaqlSpendByMonth` (`google-ads-ingest.ts`).
 *
 * @pure
 */
export function aggregateMicrosoftAdsSpendByMonth(
  rows: MicrosoftAdsReportRow[],
  opts: AggregateMicrosoftAdsSpendOptions,
): SpendRow[] {
  const byMonth = new Map<string, { spendSum: number; dates: string[] }>();

  for (const row of rows) {
    const rawDate = row.TimePeriod;
    if (!rawDate) continue;
    const date = normalizeMicrosoftDate(rawDate);
    if (!date) continue;

    const spendRaw = row.Spend;
    if (spendRaw === undefined) continue;
    const spend = typeof spendRaw === "string" ? Number(spendRaw) : spendRaw;
    if (!Number.isFinite(spend)) continue;

    const mes = date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { spendSum: 0, dates: [] };
    entry.spendSum += spend;
    entry.dates.push(date);
    byMonth.set(mes, entry);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { spendSum, dates }]) => {
      const first = dates.slice().sort()[0];
      const last = dates.slice().sort().at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal: opts.canal,
        mes,
        moeda: opts.moeda,
        valor: Math.round(spendSum * 100) / 100,
        fonte: `${opts.fonteLabel} — CampaignPerformanceReport, ${dates.length} dia(s) (${range}), ingestão automática`,
      };
    });
}

// ---------------------------------------------------------------------------
// Orquestração injetável (fetch + fail-soft) — sem I/O de disco
// ---------------------------------------------------------------------------

export interface MicrosoftAdsAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  customerId: string;
  accountId: string;
  /** Endpoint OAuth2 (Azure AD v2) — sobreponível pra teste; default é o
   *  endpoint "common" documentado em `docs/microsoft-ads-api-setup.md`. */
  tokenEndpoint?: string;
}

export type MicrosoftAdsIngestResult =
  | { kind: "updated"; rows: SpendRow[]; fetchedRows: number }
  | { kind: "fallback"; reason: string };

/** Subconjunto de `fetch` usado — permite injetar um mock em teste, mesmo
 *  padrão de `FetchLike` em `google-ads-ingest.ts`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
/** Escopo padrão da Microsoft Advertising API (client credentials/refresh
 *  token flow) — https://learn.microsoft.com/advertising/guides/authentication-oauth. */
const DEFAULT_SCOPE = "https://ads.microsoft.com/msads.manage offline_access";

/**
 * Renova o access token via refresh token (Azure AD v2). Nunca lança — falha
 * de rede, credencial ausente/expirada, ou resposta não-JSON viram `null` +
 * `reason`, mesma disciplina fail-soft de `refreshGoogleAdsAccessToken`.
 */
export async function refreshMicrosoftAdsAccessToken(
  fetchImpl: FetchLike,
  auth: Pick<MicrosoftAdsAuthConfig, "clientId" | "clientSecret" | "refreshToken" | "tokenEndpoint">,
): Promise<{ accessToken: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(auth.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        refresh_token: auth.refreshToken,
        grant_type: "refresh_token",
        scope: DEFAULT_SCOPE,
      }).toString(),
    });
  } catch (e) {
    return { error: `falha de rede na renovação do access token: ${e instanceof Error ? e.message : e}` };
  }

  const text = await res.text();
  let payload: { access_token?: string; error_description?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `renovação do access token respondeu não-JSON (HTTP ${res.status})` };
  }
  if (!res.ok || !payload.access_token) {
    return { error: `renovação do access token falhou: ${payload.error_description ?? res.status}` };
  }
  return { accessToken: payload.access_token };
}

/**
 * Busca as linhas já resolvidas do `CampaignPerformanceReport` via
 * `fetchImpl` injetado. Nunca lança — mesma disciplina fail-soft de
 * `fetchGoogleAdsSpendRows`. O CLI real (fora de escopo desta função, ver
 * docstring do módulo) é responsável por resolver o fluxo assíncrono de 2
 * passos (submeter relatório → poll até "Success" → baixar/parsear CSV) e
 * entregar aqui as linhas já parseadas — `fetchImpl` aqui representa
 * qualquer chamada HTTP que essa resolução precisar fazer (o teste injeta um
 * mock que devolve o payload final direto, sem simular o poll).
 */
export async function fetchMicrosoftAdsSpendRows(
  fetchImpl: FetchLike,
  auth: MicrosoftAdsAuthConfig,
  accessToken: string,
  reportRequestUrl: string,
): Promise<{ rows: MicrosoftAdsReportRow[] } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(reportRequestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        DeveloperToken: auth.developerToken,
        CustomerId: auth.customerId,
        CustomerAccountId: auth.accountId,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    return { error: `falha de rede na chamada da Reporting API: ${e instanceof Error ? e.message : e}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { error: `Reporting API respondeu HTTP ${res.status}: ${text.slice(0, 300)}` };
  }

  let payload: { rows?: MicrosoftAdsReportRow[] };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `Reporting API respondeu corpo não-JSON (HTTP ${res.status})` };
  }
  return { rows: payload.rows ?? [] };
}

export interface RunMicrosoftAdsIngestOptions {
  auth: MicrosoftAdsAuthConfig;
  existingRows: SpendRow[];
  canal?: string;
  moeda?: string;
  fonteLabel?: string;
  reportRequestUrl?: string;
}

const DEFAULT_REPORT_REQUEST_URL = "https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Submit";

/**
 * Orquestra token → Reporting API → agregação → merge, sempre fail-soft —
 * mesmo contrato de `runGoogleAdsIngest`, implementado como adaptador de
 * `runSpendIngest` (#5502 Parte B). `canal` default é o nome CANÔNICO
 * reservado em `scripts/lib/cac.ts` (`RESERVED_CHANNEL_NAMES`) — usar
 * exatamente essa string, nunca "Microsoft Ads"/"Bing Ads", senão a linha
 * cai no caminho "canal desconhecido" de `buildCacReport` mesmo com o gasto
 * corretamente importado.
 */
export async function runMicrosoftAdsIngest(
  fetchImpl: FetchLike,
  opts: RunMicrosoftAdsIngestOptions,
): Promise<MicrosoftAdsIngestResult> {
  const canal = opts.canal ?? "Microsoft Advertising";
  const moeda = opts.moeda ?? "BRL";
  const fonteLabel = opts.fonteLabel ?? "Microsoft Advertising Reporting API";
  const reportRequestUrl = opts.reportRequestUrl ?? DEFAULT_REPORT_REQUEST_URL;

  const fetcher = async (): Promise<SpendIngestFetchResult> => {
    const tokenResult = await refreshMicrosoftAdsAccessToken(fetchImpl, opts.auth);
    if ("error" in tokenResult) return { kind: "error", reason: tokenResult.error };

    const spendResult = await fetchMicrosoftAdsSpendRows(fetchImpl, opts.auth, tokenResult.accessToken, reportRequestUrl);
    if ("error" in spendResult) return { kind: "error", reason: spendResult.error };

    const rows = aggregateMicrosoftAdsSpendByMonth(spendResult.rows, { canal, moeda, fonteLabel });
    return { kind: "ok", rows, fetchedCount: spendResult.rows.length };
  };

  const result = await runSpendIngest({ fetcher, existingRows: opts.existingRows });
  if (result.kind === "fallback") return result;
  return { kind: "updated", rows: result.rows, fetchedRows: result.fetchedCount };
}
