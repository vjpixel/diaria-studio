/**
 * scripts/lib/ga4-client.ts (#5248)
 *
 * Cliente pra Google Analytics Data API (GA4) — `properties.runReport`,
 * `analyticsdata.googleapis.com/v1beta`. Escopo desta unidade: só o lado de
 * CÓDIGO (cliente + ingestão + testes), sem depender de painel — ver
 * `docs/ga4-data-api-setup.md` pro porquê (comportamento pós-clique na home
 * hospedada, `diar.ia.br`, fora do alcance da Cloudflare porque é custom
 * hostname da Beehiiv) e os passos de painel que ficam com o editor (tag de
 * configuração GA4 no container GTM `GTM-TC8C65ZN`, confirmar dado nos
 * últimos 30 dias — issue #5248, decisão do editor 14/08/2026: CONSERTAR e
 * INGERIR, não aposentar).
 *
 * Segue o MESMO padrão de auth já usado por `postmaster-v2-client.ts` e
 * `seo-pull.ts` — reusa `gFetch`/`getAccessToken` de `google-auth.ts` (o
 * refresh_token único salvo em `data/.credentials.json`), em vez de
 * introduzir um mecanismo de auth novo (service account). O scope
 * `analytics.readonly` precisa ser adicionado a `SCOPES` em
 * `scripts/oauth-setup.ts` e o editor precisa reaprovar no browser — token
 * emitido antes desta mudança NÃO ganha o scope novo sozinho (mesma
 * armadilha documentada em `oauth-setup.ts` pros scopes de Postmaster/GSC).
 *
 * Toda função de I/O aceita `fetchImpl` injetável — em produção é sempre
 * `gFetch`; em teste é sempre um fake, nunca a rede real (regra do dispatch:
 * NUNCA chamar a API real do GA4 nesta unidade).
 */

export const GA4_DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";

/** Nome do env var com o Property ID numérico (ex: "123456789") — NÃO é o Measurement ID ("G-XXXXXXX"). */
export const GA4_PROPERTY_ID_ENV = "GA4_PROPERTY_ID";

export class Ga4ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ga4ConfigError";
  }
}

/**
 * Lê `GA4_PROPERTY_ID` do env. Nunca lança silenciosamente com uma exceção
 * genérica — a mensagem aponta pro doc de setup, porque a credencial/property
 * ainda não existe nesta sessão (a criação é ação de painel do editor).
 */
export function resolveGa4PropertyId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env[GA4_PROPERTY_ID_ENV]?.trim();
  if (!id) {
    throw new Ga4ConfigError(
      `[ga4-client] ${GA4_PROPERTY_ID_ENV} ausente/vazio. Configure a propriedade GA4 e a credencial ` +
        "OAuth antes de rodar a ingestão — passo-a-passo em docs/ga4-data-api-setup.md.",
    );
  }
  return id;
}

export interface Ga4DateRange {
  /** "YYYY-MM-DD", ou termos relativos aceitos pela API ("today", "yesterday", "NdaysAgo"). */
  startDate: string;
  endDate: string;
}

export interface Ga4RunReportRequest {
  propertyId: string;
  dimensions: string[];
  metrics: string[];
  dateRanges: Ga4DateRange[];
  /** Teto de linhas — a API pagina, mas os relatórios desta ingestão são pequenos o bastante pra não precisar de paginação. */
  limit?: number;
}

/**
 * Monta o corpo de `properties.runReport` (pura/testável, sem I/O).
 * Formato: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 */
export function buildRunReportBody(req: Ga4RunReportRequest): Record<string, unknown> {
  if (req.dimensions.length === 0 && req.metrics.length === 0) {
    throw new Error("[ga4-client] runReport precisa de ao menos 1 dimension ou 1 metric.");
  }
  if (req.dateRanges.length === 0) {
    throw new Error("[ga4-client] runReport precisa de ao menos 1 dateRange.");
  }
  return {
    dimensions: req.dimensions.map((name) => ({ name })),
    metrics: req.metrics.map((name) => ({ name })),
    dateRanges: req.dateRanges.map((r) => ({ startDate: r.startDate, endDate: r.endDate })),
    ...(req.limit ? { limit: String(req.limit) } : {}),
  };
}

/** Resposta bruta de `runReport` — só os campos que este módulo lê. */
export interface Ga4RunReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: {
    dimensionValues?: { value: string }[];
    metricValues?: { value: string }[];
  }[];
  rowCount?: number;
}

/** Uma linha "achatada" — chaves são nomes de dimension/metric, valores string (como a API devolve). */
export type Ga4FlatRow = Record<string, string>;

/**
 * Achata `Ga4RunReportResponse.rows` usando os headers pra nomear cada
 * coluna. Pura/testável. `rows`/`rowCount` ausentes (0 linhas, ex: janela sem
 * dado ainda) devolvem array vazio, nunca lançam.
 */
export function extractReportRows(res: Ga4RunReportResponse): Ga4FlatRow[] {
  const dimNames = (res.dimensionHeaders ?? []).map((h) => h.name);
  const metricNames = (res.metricHeaders ?? []).map((h) => h.name);
  return (res.rows ?? []).map((row) => {
    const flat: Ga4FlatRow = {};
    (row.dimensionValues ?? []).forEach((v, i) => {
      if (dimNames[i]) flat[dimNames[i]] = v.value;
    });
    (row.metricValues ?? []).forEach((v, i) => {
      if (metricNames[i]) flat[metricNames[i]] = v.value;
    });
    return flat;
  });
}

/**
 * Mensagem de erro fail-soft — mesmo vocabulário de conserto usado por
 * `postmaster-v2-client.ts::describeQueryFailure` (scope insuficiente / API
 * desabilitada / property inexistente/sem permissão), sempre apontando pro
 * doc de setup em vez de uma exceção genérica. `body` é o texto bruto da
 * resposta HTTP.
 */
export function describeGa4Failure(status: number, body: string): string {
  const b = body ?? "";
  if (b.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || b.includes("insufficient authentication scopes")) {
    return (
      "token sem o scope analytics.readonly — rode `npx tsx scripts/oauth-setup.ts` e reaprove no " +
      "browser. Ver docs/ga4-data-api-setup.md."
    );
  }
  if (b.includes("SERVICE_DISABLED") || b.includes("has not been used in project") || b.includes("it is disabled")) {
    return (
      "Google Analytics Data API não habilitada no projeto GCP deste OAuth client " +
      "(console.cloud.google.com → APIs → Google Analytics Data API → Ativar). Ver docs/ga4-data-api-setup.md."
    );
  }
  if (status === 401) {
    return "401 mesmo após retry — refresh token revogado/expirado. Rode `npx tsx scripts/oauth-setup.ts`.";
  }
  if (status === 403) {
    return (
      "403 sem código de scope/API reconhecido — confira se a conta OAuth tem acesso de leitura à " +
      "propriedade GA4 (Admin → Gerenciamento de acesso à propriedade) e se GA4_PROPERTY_ID é o Property ID " +
      "numérico, não o Measurement ID (G-XXXXXXX). Ver docs/ga4-data-api-setup.md."
    );
  }
  if (status === 404) {
    return (
      "404 — propriedade GA4 inexistente ou GA4_PROPERTY_ID incorreto (precisa ser o Property ID numérico, " +
      "ex: 123456789, e NÃO o Measurement ID G-XXXXXXX — ver Admin → Detalhes da propriedade na UI do GA4). " +
      "Ver docs/ga4-data-api-setup.md."
    );
  }
  if (status === 429) {
    return "429 — cota da Data API excedida (cota gratuita é generosa; provável chamada concorrente/loop). Tente novamente mais tarde.";
  }
  return `HTTP ${status} inesperado. Corpo: ${b.slice(0, 300)}. Ver docs/ga4-data-api-setup.md.`;
}

/**
 * Assinatura mínima exigida de `fetchImpl` — mesma disciplina de
 * `postmaster-v2-client.ts::PostmasterV2FetchImpl`: `gFetch` só aceita
 * `string` no 1º argumento, mais estreito que `typeof fetch`.
 */
export type Ga4FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Roda UM `runReport` contra a Data API. Todo I/O passa por `fetchImpl`
 * (em produção sempre `gFetch` de `google-auth.ts`) — nunca chama `fetch`
 * global diretamente, pra manter testável sem rede.
 */
export async function runGa4Report(req: Ga4RunReportRequest, fetchImpl: Ga4FetchImpl): Promise<Ga4RunReportResponse> {
  const url = `${GA4_DATA_API_BASE}/properties/${encodeURIComponent(req.propertyId)}:runReport`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRunReportBody(req)),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`[ga4-client] falha em runReport: ${describeGa4Failure(res.status, bodyText)}`);
  }
  try {
    return JSON.parse(bodyText) as Ga4RunReportResponse;
  } catch {
    throw new Error(`[ga4-client] resposta 2xx não é JSON válido: ${bodyText.slice(0, 300)}`);
  }
}
