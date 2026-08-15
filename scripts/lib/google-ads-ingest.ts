/**
 * scripts/lib/google-ads-ingest.ts (#5237)
 *
 * Traduz o resultado bruto de uma query GAQL (`metrics.cost_micros` por
 * `segments.date`) para o formato `spend.csv` de #5236 (`canal,mes,moeda,
 * valor,fonte`). Núcleo puro/testável — sem I/O de rede nem disco; o
 * orquestrador injetável (`runGoogleAdsIngest`) abaixo é quem decide o que
 * fazer com falha de rede/auth (fail-soft, item 5 do checklist da issue), e
 * o CLI (`scripts/google-ads-ingest-spend.ts`) é quem faz de fato a chamada
 * e escreve em disco.
 *
 * ## Por que fail-soft é o comportamento CORRETO aqui, não um fallback pobre
 *
 * O developer token do projeto (`236-921-9639`) está no nível "Conta de
 * teste" — toda chamada de produção volta `DEVELOPER_TOKEN_NOT_APPROVED`
 * até o Basic Access sair da fila (#5262). Isso é o estado ESPERADO hoje,
 * não uma exceção rara: o script precisa degradar pro CSV manual
 * (`data/aquisicao/spend.csv` já mantido por `seed-spend-csv.ts`/edição
 * manual) sem quebrar `cac-report.ts` nem lançar stack cru — nunca
 * `process.exit` de dentro deste módulo, que não sabe se está rodando
 * dentro de um teste.
 */

import type { SpendRow } from "./aquisicao-spend.ts";

// ---------------------------------------------------------------------------
// Parsing GAQL → SpendRow (puro)
// ---------------------------------------------------------------------------

/** Forma mínima de uma linha devolvida por `googleAds:search`/`searchStream`
 *  para a query `SELECT segments.date, metrics.cost_micros FROM customer
 *  WHERE segments.date DURING ...`. `costMicros` pode vir como string (a API
 *  serializa int64 como string em JSON) ou number — aceitar os dois evita um
 *  bug de parsing silencioso se o formato mudar entre versões da API. */
export interface GaqlSpendApiRow {
  segments?: { date?: string };
  metrics?: { costMicros?: string | number };
}

export interface AggregateGaqlSpendOptions {
  canal: string;
  moeda: string;
  /** Prefixo da coluna `fonte` — a função acrescenta o range de datas agregado. */
  fonteLabel: string;
}

/**
 * Agrupa linhas GAQL por mês (`AAAA-MM` extraído de `segments.date`,
 * formato `AAAA-MM-DD` da API) somando `cost_micros` (unidade de 1/1.000.000
 * da moeda da conta) e convertendo para a unidade decimal que `spend.csv`
 * espera. Linhas sem `segments.date` ou `metrics.costMicros` parseável são
 * ignoradas (não têm mês pra agrupar) — nunca contaminam a soma como 0.
 *
 * @pure
 */
export function aggregateGaqlSpendByMonth(
  rows: GaqlSpendApiRow[],
  opts: AggregateGaqlSpendOptions,
): SpendRow[] {
  const byMonth = new Map<string, { microsSum: number; dates: string[] }>();

  for (const row of rows) {
    const date = row.segments?.date;
    const microsRaw = row.metrics?.costMicros;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || microsRaw === undefined) continue;

    const micros = typeof microsRaw === "string" ? Number(microsRaw) : microsRaw;
    if (!Number.isFinite(micros)) continue;

    const mes = date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { microsSum: 0, dates: [] };
    entry.microsSum += micros;
    entry.dates.push(date);
    byMonth.set(mes, entry);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { microsSum, dates }]) => {
      const first = dates.slice().sort()[0];
      const last = dates.slice().sort().at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal: opts.canal,
        mes,
        moeda: opts.moeda,
        valor: Math.round((microsSum / 1_000_000) * 100) / 100,
        fonte: `${opts.fonteLabel} — GAQL cost_micros, ${dates.length} dia(s) (${range}), ingestão automática`,
      };
    });
}

/**
 * Funde linhas novas (`incoming`) em cima do conjunto existente lido do
 * `spend.csv` atual: uma linha `incoming` SUBSTITUI qualquer linha
 * `existing` com o mesmo par (`canal`, `mes`) — idempotente em re-execução —
 * e linhas de outros canais/meses (LinkedIn, Beehiiv Boosts, meses antigos
 * de Google Ads não recobertos pela query) são preservadas intactas.
 *
 * @pure
 */
export function mergeSpendRows(existing: SpendRow[], incoming: SpendRow[]): SpendRow[] {
  const key = (r: SpendRow) => `${r.canal} ${r.mes}`;
  const incomingKeys = new Set(incoming.map(key));
  const kept = existing.filter((r) => !incomingKeys.has(key(r)));
  return [...kept, ...incoming].sort((a, b) => a.canal.localeCompare(b.canal) || a.mes.localeCompare(b.mes));
}

// ---------------------------------------------------------------------------
// Orquestração injetável (fetch + fail-soft) — sem I/O de disco
// ---------------------------------------------------------------------------

export interface GoogleAdsAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  loginCustomerId: string;
  customerId: string;
  apiVersion?: string;
}

export type GoogleAdsIngestResult =
  | { kind: "updated"; rows: SpendRow[]; fetchedRows: number }
  | { kind: "fallback"; reason: string };

/** Subconjunto de `fetch` usado — permite injetar um mock em teste sem
 *  depender do `fetch` global do runtime. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_API_VERSION = "v25";

/**
 * Renova o access token via refresh token. Nunca lança — falha de rede,
 * credencial ausente/expirada, ou resposta não-JSON viram `null` +
 * `reason`, porque este caminho é fail-soft por design (item 5 da issue
 * #5237): MCP/API indisponível nunca pode derrubar quem chama.
 */
export async function refreshGoogleAdsAccessToken(
  fetchImpl: FetchLike,
  auth: Pick<GoogleAdsAuthConfig, "clientId" | "clientSecret" | "refreshToken">,
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

/**
 * Busca as linhas GAQL de custo diário da conta. Nunca lança — mesma
 * disciplina fail-soft de `refreshGoogleAdsAccessToken`. `DEVELOPER_TOKEN_NOT_APPROVED`
 * (estado esperado hoje, ver docstring do módulo) chega aqui como um HTTP
 * não-2xx comum e vira `{ error }`, sem tratamento especial — diferente de
 * `google-ads-associate.ts`, este caminho não tenta classificar "associou
 * ou não", só decide "consegui os dados ou preciso cair pro CSV manual".
 */
export async function fetchGoogleAdsSpendRows(
  fetchImpl: FetchLike,
  auth: GoogleAdsAuthConfig,
  accessToken: string,
  gaqlQuery: string,
): Promise<{ rows: GaqlSpendApiRow[] } | { error: string }> {
  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const customerId = auth.customerId.replace(/[^0-9]/g, "");
  const loginCustomerId = auth.loginCustomerId.replace(/[^0-9]/g, "");
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": auth.developerToken,
        "login-customer-id": loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gaqlQuery }),
    });
  } catch (e) {
    return { error: `falha de rede na chamada googleAds:search: ${e instanceof Error ? e.message : e}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { error: `googleAds:search respondeu HTTP ${res.status}: ${text.slice(0, 300)}` };
  }

  let payload: { results?: GaqlSpendApiRow[] };
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `googleAds:search respondeu corpo não-JSON (HTTP ${res.status})` };
  }
  return { rows: payload.results ?? [] };
}

export interface RunGoogleAdsIngestOptions {
  auth: GoogleAdsAuthConfig;
  existingRows: SpendRow[];
  canal?: string;
  moeda?: string;
  fonteLabel?: string;
  gaqlQuery?: string;
}

const DEFAULT_GAQL_QUERY =
  "SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date DURING LAST_90_DAYS";

/**
 * Orquestra token → GAQL → agregação → merge, sempre fail-soft: qualquer
 * falha em qualquer etapa (env ausente é responsabilidade do CLI checar
 * antes de chamar isto; aqui é rede/auth/API) devolve `{ kind: "fallback",
 * reason }` em vez de lançar — o CLI decide o que logar, mas NUNCA quebra
 * o relatório (`cac-report.ts` segue lendo o `spend.csv` manual intocado).
 */
export async function runGoogleAdsIngest(
  fetchImpl: FetchLike,
  opts: RunGoogleAdsIngestOptions,
): Promise<GoogleAdsIngestResult> {
  const canal = opts.canal ?? "Google Ads";
  const moeda = opts.moeda ?? "BRL";
  const fonteLabel = opts.fonteLabel ?? "Google Ads API (MCP oficial)";
  const gaqlQuery = opts.gaqlQuery ?? DEFAULT_GAQL_QUERY;

  const tokenResult = await refreshGoogleAdsAccessToken(fetchImpl, opts.auth);
  if ("error" in tokenResult) return { kind: "fallback", reason: tokenResult.error };

  const spendResult = await fetchGoogleAdsSpendRows(fetchImpl, opts.auth, tokenResult.accessToken, gaqlQuery);
  if ("error" in spendResult) return { kind: "fallback", reason: spendResult.error };

  const incoming = aggregateGaqlSpendByMonth(spendResult.rows, { canal, moeda, fonteLabel });
  if (incoming.length === 0) {
    return { kind: "fallback", reason: "GAQL não devolveu nenhuma linha com custo — nada pra atualizar" };
  }

  const merged = mergeSpendRows(opts.existingRows, incoming);
  return { kind: "updated", rows: merged, fetchedRows: spendResult.rows.length };
}
