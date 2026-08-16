/**
 * scripts/lib/ga4-ingest.ts (#5248)
 *
 * Cliente puro/testável para a Google Analytics Data API v1beta
 * (`runReport`), autenticado via OAuth refresh-token — mesmo padrão já
 * usado por `scripts/lib/google-ads-ingest.ts` (#5237), reaproveitado aqui
 * por consistência de repo (não por acoplamento: os dois módulos não se
 * importam).
 *
 * ## Contexto (#5248)
 *
 * GA4 confirmado COLETANDO ao vivo (checagem de painel via Claude in
 * Chrome, 16/08/2026, ver comentários da issue): propriedade `Diaria`,
 * stream Web único, measurement ID `G-SGXBD0R9CD`, property ID
 * `378028168`. Decisão do editor: "se coletar, consertar e ingerir via
 * Data API (cota gratuita)". Este módulo é essa ingestão.
 *
 * ## Fail-soft total — mesma disciplina do #5237
 *
 * Sem as env vars `GA4_*`, ou qualquer falha de rede/auth/quota, o
 * orquestrador injetável (`runGa4Ingest`) devolve `{ kind: "fallback",
 * reason }` em vez de lançar. Nunca `process.exit` de dentro deste módulo
 * — quem decide o que fazer com a falha é o CLI
 * (`scripts/ga4-ingest.ts`), não o núcleo.
 *
 * ## Por que OAuth refresh-token, não Service Account/ADC
 *
 * A Data API aceita os dois. O projeto já tem o padrão OAuth refresh-token
 * rodando em produção para Google Ads (#5237) — mesmo fluxo de token
 * endpoint, mesma forma de guardar segredo (Doppler), sem exigir criar uma
 * Service Account nova no GCP Console (passo manual pendente até hoje para
 * o MCP do Google Ads, ver `docs/google-ads-api-setup.md`). Escolha de
 * consistência, documentada em `docs/ga4-api-setup.md`.
 */

// ---------------------------------------------------------------------------
// Parsing runReport → linhas tabulares (puro)
// ---------------------------------------------------------------------------

/** Forma mínima da resposta de `properties/{id}:runReport` relevante aqui —
 *  dimensões e métricas vêm como arrays paralelos de `{ value }`, na mesma
 *  ordem em que foram pedidas na request (contrato da Data API v1beta). */
export interface Ga4RunReportApiResponse {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: { name?: string }[];
  rows?: {
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }[];
}

/** Uma linha já nomeada — chaves de dimensão/métrica resolvidas pelo header,
 *  não mais por posição de array. */
export type Ga4ReportRow = Record<string, string>;

/**
 * Combina `dimensionHeaders`/`metricHeaders` com `rows` (arrays paralelos
 * posicionais) em objetos nomeados. Linhas sem `dimensionValues`/
 * `metricValues` (nunca deveria acontecer, mas a API é externa) são
 * ignoradas — nunca preenchidas com `undefined` silencioso.
 *
 * @pure
 */
export function parseGa4RunReportRows(response: Ga4RunReportApiResponse): Ga4ReportRow[] {
  const dimensionNames = (response.dimensionHeaders ?? []).map((h) => h.name ?? "");
  const metricNames = (response.metricHeaders ?? []).map((h) => h.name ?? "");

  const out: Ga4ReportRow[] = [];
  for (const row of response.rows ?? []) {
    if (!row.dimensionValues || !row.metricValues) continue;
    const named: Ga4ReportRow = {};
    dimensionNames.forEach((name, i) => {
      if (name) named[name] = row.dimensionValues?.[i]?.value ?? "";
    });
    metricNames.forEach((name, i) => {
      if (name) named[name] = row.metricValues?.[i]?.value ?? "";
    });
    out.push(named);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orquestração injetável (fetch + fail-soft) — sem I/O de disco
// ---------------------------------------------------------------------------

export interface Ga4AuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  propertyId: string;
}

export type Ga4IngestResult =
  | { kind: "ok"; rows: Ga4ReportRow[]; snapshotAt: string }
  | { kind: "fallback"; reason: string };

/** Subconjunto de `fetch` usado — permite injetar um mock em teste sem
 *  depender do `fetch` global do runtime. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";

/**
 * Renova o access token via refresh token. Nunca lança — falha de rede,
 * credencial ausente/expirada, ou resposta não-JSON viram `{ error }`,
 * porque este caminho é fail-soft por design (mesma disciplina de
 * `refreshGoogleAdsAccessToken` em `scripts/lib/google-ads-ingest.ts`).
 */
export async function refreshGa4AccessToken(
  fetchImpl: FetchLike,
  auth: Pick<Ga4AuthConfig, "clientId" | "clientSecret" | "refreshToken">,
): Promise<{ accessToken: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        refresh_token: auth.refreshToken,
        grant_type: "refresh_token",
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

export interface Ga4RunReportRequest {
  /** Ex: [{ startDate: "30daysAgo", endDate: "today" }] */
  dateRanges: { startDate: string; endDate: string }[];
  /** Ex: [{ name: "date" }] */
  dimensions?: { name: string }[];
  /** Ex: [{ name: "activeUsers" }, { name: "screenPageViews" }] */
  metrics: { name: string }[];
  limit?: number;
}

/**
 * Chama `properties/{id}:runReport`. Nunca lança — mesma disciplina de
 * `fetchGoogleAdsSpendRows`; qualquer status não-2xx (quota, auth, property
 * ID errado) chega aqui como `{ error }` comum, sem classificação especial.
 */
export async function fetchGa4Report(
  fetchImpl: FetchLike,
  auth: Ga4AuthConfig,
  accessToken: string,
  reportRequest: Ga4RunReportRequest,
): Promise<{ response: Ga4RunReportApiResponse } | { error: string }> {
  const propertyId = auth.propertyId.replace(/[^0-9]/g, "");
  const url = `${DATA_API_BASE}/properties/${propertyId}:runReport`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportRequest),
    });
  } catch (e) {
    return { error: `falha de rede na chamada runReport: ${e instanceof Error ? e.message : e}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { error: `runReport respondeu HTTP ${res.status}: ${text.slice(0, 300)}` };
  }

  let payload: Ga4RunReportApiResponse;
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `runReport respondeu corpo não-JSON (HTTP ${res.status})` };
  }
  return { response: payload };
}

export interface RunGa4IngestOptions {
  auth: Ga4AuthConfig;
  /** Default: sessões/usuários/pageviews por dia, últimos N dias. */
  reportRequest?: Ga4RunReportRequest;
  /** Injetável só para determinismo em teste — default `new Date().toISOString()`. */
  now?: () => Date;
}

const DEFAULT_REPORT_REQUEST: Ga4RunReportRequest = {
  dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
  dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
  metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
  limit: 10000,
};

/**
 * Orquestra token → runReport → parsing, sempre fail-soft: qualquer falha
 * em qualquer etapa (env ausente é responsabilidade do CLI checar antes de
 * chamar isto; aqui é rede/auth/quota) devolve `{ kind: "fallback", reason
 * }` em vez de lançar — o CLI decide o que logar e onde salvar, mas NUNCA
 * quebra quem chama.
 */
export async function runGa4Ingest(fetchImpl: FetchLike, opts: RunGa4IngestOptions): Promise<Ga4IngestResult> {
  const reportRequest = opts.reportRequest ?? DEFAULT_REPORT_REQUEST;
  const now = opts.now ?? (() => new Date());

  const tokenResult = await refreshGa4AccessToken(fetchImpl, opts.auth);
  if ("error" in tokenResult) return { kind: "fallback", reason: tokenResult.error };

  const reportResult = await fetchGa4Report(fetchImpl, opts.auth, tokenResult.accessToken, reportRequest);
  if ("error" in reportResult) return { kind: "fallback", reason: reportResult.error };

  const rows = parseGa4RunReportRows(reportResult.response);
  return { kind: "ok", rows, snapshotAt: now().toISOString() };
}
