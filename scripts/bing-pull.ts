/**
 * bing-pull.ts (#4908 item 2; estendido #5128/#5130)
 *
 * Puxa dados do Bing Webmaster Tools (API oficial, grátis) em 3 modos
 * (`--mode site|keywords|links`, default `site` — retrocompatível com a
 * invocação original do #4908):
 *
 *   - `site`     (#4908) → `GetQueryStats`/`GetRankAndTrafficStats`, os 2
 *     endpoints de PRIMEIRA parte (só o que o site JÁ toca — garantidamente
 *     vazio numa propriedade nova). 2ª fonte first-party de demanda de busca
 *     em pt-BR do projeto, ao lado de `seo-pull.ts` (Google Search Console).
 *   - `keywords` (#5128) → `GetKeyword`/`GetRelatedKeywords`/`GetKeywordStats`,
 *     os 3 endpoints de TERCEIRA parte — respondem "quanto se busca X em
 *     pt-BR" pra um termo arbitrário, independente de rankearmos. Rodado
 *     contra `GEO_HUB_QUESTIONS` (as perguntas que os 6 hubs afirmam
 *     responder, `lib/geo-citation-monitor.ts` — reusado aqui de propósito,
 *     não duplicado) + `BING_LONGTAIL_AI_TERMS` (cauda longa pt-BR sobre IA,
 *     abaixo).
 *   - `links`    (#5130) → `GetLinkCounts`/`GetUrlLinks` — instrumento de
 *     AUTORIDADE (backlinks). Sem instrumento até aqui, o critério de
 *     sucesso pré-registrado pro checkpoint de ~29/set ("≥5 domínios
 *     externos distintos") não tinha como ser avaliado (#5130).
 *
 * Mirror deliberado de `seo-pull.ts`: mesmo diretório de saída (`data/seo/`),
 * mesma disciplina de payload puro testável — diferindo só no transporte de
 * auth (aqui: `apikey` como query param, não OAuth) e no fato de o modo
 * `site` consultar DUAS propriedades de prefixo de URL em vez de uma
 * propriedade de domínio (ver `scripts/lib/bing.ts`).
 *
 * **Escopo deliberadamente mínimo, nos 3 modos** (issue #4908, comentário do
 * editor 260811, reafirmado nos #5128/#5130): isto é pull+persist — não uma
 * pipeline de scoring de oportunidades como `seo-pull.ts` tem
 * (`scoreOpportunities`). Nenhum dos modos novos sintetiza conclusão
 * (`≥5 domínios`, "termo X tem demanda") — só captura e persiste; a leitura
 * é humana, no comentário das issues, não código.
 *
 * `GetCrawlStats` fica de fora de propósito: é sobre saúde de crawl/índice
 * (tema do #4909), não sobre "alguém busca isso" (tema do #5128).
 * `SubmitUrlBatch` também fica de fora (tema de URL órfã, não desta issue).
 *
 * **Shape das respostas `keywords`/`links` CONFIRMADO ao vivo em 12/ago/2026**
 * (contra `chatgpt`, termo com volume garantido, pra não confundir "vazio
 * porque o shape é outro" com "vazio porque o termo não tem demanda"):
 *   - `GetKeyword`         → `{d: {Query, Impressions, BroadImpressions}}` —
 *     objeto ÚNICO, total do período.
 *   - `GetKeywordStats`/`GetRelatedKeywords` → `{d: [{Query, [Date,]
 *     Impressions, BroadImpressions}, ...]}` — array; só `GetKeywordStats`
 *     tem `Date` (série do MESMO termo); `GetRelatedKeywords` não (cada
 *     linha é um termo DIFERENTE).
 *   - `GetLinkCounts`      → `{d: {Links: [...], TotalPages: N}}` — objeto
 *     ÚNICO embrulhando o array (diferente da forma `{d: [...]}` do resto
 *     do arquivo) + contagem de página EXPLÍCITA (paginação exata, não
 *     "até vir vazio"). `diar.ia.br` e `arquivo.diar.ia.br` confirmados com
 *     `Links: [], TotalPages: 0` nesta sessão — 0 backlink indexado pelo
 *     Bing pras duas propriedades, resposta legítima (site pequeno/novo).
 *   - `GetUrlLinks`        → **NÃO confirmado** (a única tentativa real, com
 *     a raiz de `diar.ia.br` — a única URL disponível, já que `GetLinkCounts`
 *     não devolveu nenhuma página com link — deu `400 InvalidUrl`, esperado
 *     nesse caso). Parser tolerante às 2 formas plausíveis (ver docstring de
 *     `parseBingUrlLinksResponse`).
 *   - **Achado que só apareceu testando ao vivo, sem doc que o mencionasse:**
 *     `country`/`language` de `GetKeyword`/`GetRelatedKeywords`/
 *     `GetKeywordStats` são case-SENSITIVE de um jeito não-óbvio — só
 *     `country=br` (minúsculo) e `language=pt-BR` (exatamente essa forma;
 *     `pt-br` e `pt` sozinho falham) passam; `country=BR` (maiúsculo) falha.
 *     Default do CLI abaixo já reflete isso.
 *
 * Cada chamada de `keywords`/`links` continua persistindo o payload `raw`
 * INTEIRO ao lado do campo parseado (mesmo confirmado o shape — barato,
 * audita qualquer drift futuro da API sem exigir nova sessão de descoberta).
 *
 * Endpoints consultados (GET, auth via query param `apikey` + `siteUrl`):
 *   GetQueryStats(siteUrl)          → linhas por query (agregado, sem data) [site]
 *   GetRankAndTrafficStats(siteUrl) → linhas por dia (agregado, sem query) [site]
 *   GetKeyword(q, country, language, startDate, endDate) → impressões do termo [keywords]
 *   GetRelatedKeywords(q, country, language, startDate, endDate) → termos relacionados [keywords]
 *   GetKeywordStats(q, country, language) → histórico do termo [keywords]
 *   GetLinkCounts(siteUrl, page)    → páginas do site com link de entrada [links]
 *   GetUrlLinks(siteUrl, url, page) → os backlinks em si, por página [links]
 *
 * Uso:
 *   npx tsx scripts/bing-pull.ts [--site https://diar.ia.br/] \
 *     [--out data/seo/bing-{slug}-{YYYY-MM-DD}.json]
 *   npx tsx scripts/bing-pull.ts --mode keywords [--country br] [--language pt-BR] \
 *     [--days 30] [--out data/seo/bing-keywords-{YYYY-MM-DD}.json]
 *   npx tsx scripts/bing-pull.ts --mode links [--site https://diar.ia.br/] \
 *     [--max-pages 20] [--out data/seo/bing-links-{YYYY-MM-DD}.json]
 *
 * Pra consultar a 2ª propriedade verificada (modos `site`/`links`):
 *   npx tsx scripts/bing-pull.ts --site https://arquivo.diar.ia.br/
 *
 * Env: BING_WEBMASTER_API_KEY (`.env`, ver `.env.example`).
 *
 * Exit: 0 ok (grava JSON); 1 erro de API ou credencial ausente; 2 erro de uso
 * (inclui `--mode` desconhecido).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { BING_DEFAULT_SITE, BING_API_BASE } from "./lib/bing.ts";
import { GEO_HUB_QUESTIONS } from "./lib/geo-citation-monitor.ts";

// .env — loader canônico do projeto (#923, consolidado #4820). Chamada em
// module scope, ANTES de qualquer leitura de `process.env.BING_WEBMASTER_API_KEY`
// (bloco de preflight em `main()`, abaixo) — mesmo achado/fix do #4983/#5048
// (scripts que leem env direto sem isto falham sob systemd --user, que não
// herda o `.env` do shell interativo).
loadProjectEnv();

export interface BingQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  avgClickPosition: number;
  avgImpressionPosition: number;
}

export interface BingTrafficRow {
  date: string | null;
  clicks: number;
  impressions: number;
  avgClickPosition: number;
  avgImpressionPosition: number;
}

function numOr0(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strOr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Extrai o array de linhas de uma resposta do BWT — direto, ou embrulhado em `{ d: [...] }`
 * (convenção ASP.NET AJAX/WCF de serviços `.svc/json`, comum nesta geração de API). */
function extractRows(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  const wrapped = (json as { d?: unknown })?.d;
  if (Array.isArray(wrapped)) return wrapped;
  return null;
}

/** Datas do BWT vêm no formato .NET `/Date(ms)/`; tolera ISO e ausência. Nunca lança. */
export function parseBingDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const netMatch = v.match(/\/Date\((\d+)\)\//);
  if (netMatch) return new Date(Number(netMatch[1])).toISOString().slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Parseia a resposta de `GetQueryStats`. Tolerante a shape inesperado — nunca lança. */
export function parseBingQueryStatsResponse(json: unknown): BingQueryRow[] {
  const rows = extractRows(json);
  if (!rows) return [];
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      query: strOr(row.Query ?? row.query),
      clicks: numOr0(row.Clicks ?? row.clicks),
      impressions: numOr0(row.Impressions ?? row.impressions),
      avgClickPosition: numOr0(row.AvgClickPosition ?? row.avgClickPosition),
      avgImpressionPosition: numOr0(row.AvgImpressionPosition ?? row.avgImpressionPosition),
    };
  });
}

/** Parseia a resposta de `GetRankAndTrafficStats`. Mesma tolerância. */
export function parseBingTrafficStatsResponse(json: unknown): BingTrafficRow[] {
  const rows = extractRows(json);
  if (!rows) return [];
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      date: parseBingDate(row.Date ?? row.date),
      clicks: numOr0(row.Clicks ?? row.clicks),
      impressions: numOr0(row.Impressions ?? row.impressions),
      avgClickPosition: numOr0(row.AvgClickPosition ?? row.avgClickPosition),
      avgImpressionPosition: numOr0(row.AvgImpressionPosition ?? row.avgImpressionPosition),
    };
  });
}

/** Slug de arquivo a partir do siteUrl (ex: "https://diar.ia.br/" → "diar-ia-br"). */
export function bingSiteSlug(site: string): string {
  return site
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Monta a URL de um endpoint do BWT (auth via query param `apikey`, não OAuth). */
export function buildBingUrl(endpoint: string, site: string, apiKey: string): string {
  const params = new URLSearchParams({ siteUrl: site, apikey: apiKey });
  return `${BING_API_BASE}${endpoint}?${params.toString()}`;
}

async function bingGet(endpoint: string, site: string, apiKey: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(buildBingUrl(endpoint, site, apiKey));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bing WMT ${endpoint} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Único ponto de I/O de rede pra query stats — fetch injetável (nunca rede real em teste). */
export async function pullBingQueryStats(
  site: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BingQueryRow[]> {
  return parseBingQueryStatsResponse(await bingGet("GetQueryStats", site, apiKey, fetchImpl));
}

/** Único ponto de I/O de rede pra traffic stats — fetch injetável. */
export async function pullBingTrafficStats(
  site: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BingTrafficRow[]> {
  return parseBingTrafficStatsResponse(await bingGet("GetRankAndTrafficStats", site, apiKey, fetchImpl));
}

/**
 * Payload pure: monta o objeto gravado em `data/seo/bing-*.json`. Mesma
 * disciplina do `buildSeoPullOutput` irmão em `seo-pull.ts` (#4908 item 1) —
 * ponto de injeção testável, sem I/O.
 */
export function buildBingPullOutput(
  site: string,
  pulledAt: string,
  queryRows: BingQueryRow[],
  trafficRows: BingTrafficRow[],
): {
  site: string;
  pulled_at: string;
  total_query_rows: number;
  query_rows: BingQueryRow[];
  total_traffic_rows: number;
  traffic_rows: BingTrafficRow[];
} {
  return {
    site,
    pulled_at: pulledAt,
    total_query_rows: queryRows.length,
    query_rows: queryRows,
    total_traffic_rows: trafficRows.length,
    traffic_rows: trafficRows,
  };
}

/** YYYY-MM-DD a partir de epoch ms (injetável pra teste — mesmo padrão de `seo-pull.ts::isoDate`). */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────
// #5128 — GetKeyword / GetRelatedKeywords / GetKeywordStats (demanda 3ª parte)
// ─────────────────────────────────────────────────────────────────────────

/** Monta a URL de um endpoint do BWT com params arbitrários (auth via query
 * param `apikey`, mesma convenção de `buildBingUrl`, mas sem assumir só
 * `siteUrl` — os endpoints de `keywords` usam `q`/`country`/`language`/
 * `startDate`/`endDate`, os de `links` usam `siteUrl`/`url`/`page`). */
export function buildBingEndpointUrl(endpoint: string, params: Record<string, string>, apiKey: string): string {
  const search = new URLSearchParams({ ...params, apikey: apiKey });
  return `${BING_API_BASE}${endpoint}?${search.toString()}`;
}

async function bingGetWithParams(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(buildBingEndpointUrl(endpoint, params, apiKey));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bing WMT ${endpoint} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Desembrulha `{d: X}` (convenção `.svc/json`) pro valor de `X`, seja ele
 * objeto OU array — complementa `extractRows` (que só serve o caso array).
 * Sem `d`, retorna o próprio `json` (tolera resposta já desembrulhada, ex:
 * em teste). Nunca lança. */
function extractD(json: unknown): unknown {
  if (json && typeof json === "object" && "d" in (json as Record<string, unknown>)) {
    return (json as { d?: unknown }).d;
  }
  return json;
}

export interface BingKeywordTotal {
  query: string;
  impressions: number;
  broadImpressions: number;
}

/**
 * Parseia a resposta de `GetKeyword` — **confirmado ao vivo em 12/ago/2026**
 * (#5128 item 2): `{d: {Query, Impressions, BroadImpressions}}`, um objeto
 * ÚNICO (o total do termo no período `startDate..endDate`), não uma série.
 * Tolerante a camelCase e a ausência de `d` (json já desembrulhado). Nunca
 * lança; shape inesperado → `{ query: "", impressions: 0, broadImpressions: 0 }`.
 */
export function parseBingKeywordTotalResponse(json: unknown): BingKeywordTotal {
  const obj = (extractD(json) ?? {}) as Record<string, unknown>;
  return {
    query: strOr(obj.Query ?? obj.query),
    impressions: numOr0(obj.Impressions ?? obj.impressions),
    broadImpressions: numOr0(obj.BroadImpressions ?? obj.broadImpressions),
  };
}

export interface BingKeywordRow {
  query: string;
  /** `null` pra `GetRelatedKeywords` (sem campo `Date` — cada linha é um
   * termo diferente, não um ponto no tempo do MESMO termo). */
  date: string | null;
  impressions: number;
  broadImpressions: number;
}

/**
 * Parseia a resposta de `GetKeywordStats` (série temporal do MESMO termo,
 * `{d: [{Query, Date, Impressions, BroadImpressions}, ...]}`) e de
 * `GetRelatedKeywords` (lista de termos relacionados, mesmo shape de linha
 * SEM `Date` — `{d: [{Query, Impressions, BroadImpressions}, ...]}`) —
 * **ambos confirmados ao vivo em 12/ago/2026** (#5128 item 2), mesma forma
 * de linha o suficiente pra compartilhar 1 parser. Tolerante a `{d:[...]}`
 * (`extractRows`), camelCase, e elemento/campo ausente. Nunca lança.
 */
export function parseBingKeywordRowsResponse(json: unknown): BingKeywordRow[] {
  const rows = extractRows(json);
  if (!rows) return [];
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return {
      query: strOr(row.Query ?? row.query),
      date: parseBingDate(row.Date ?? row.date),
      impressions: numOr0(row.Impressions ?? row.impressions),
      broadImpressions: numOr0(row.BroadImpressions ?? row.broadImpressions),
    };
  });
}

export interface BingCallOk<T> {
  ok: true;
  data: T;
  /** Payload bruto da API — nunca descartado (ver docstring do arquivo: shape
   * dos 3 endpoints de `keywords`/2 de `links` não confirmado ao vivo). */
  raw: unknown;
}
export interface BingCallErr {
  ok: false;
  error: string;
}
export type BingCallResult<T> = BingCallOk<T> | BingCallErr;

/** Executa uma chamada BWT capturando falha como `{ok:false}` em vez de
 * lançar — cada termo/página é independente; 1 falha não derruba a rodada
 * inteira (mesmo espírito do `bestEffort` de `ScheduledTaskStep`). */
async function safeBingCall<T>(fn: () => Promise<{ data: T; raw: unknown }>): Promise<BingCallResult<T>> {
  try {
    const { data, raw } = await fn();
    return { ok: true, data, raw };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function pullBingKeyword(
  q: string,
  country: string,
  language: string,
  startDate: string,
  endDate: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: BingKeywordTotal; raw: unknown }> {
  const raw = await bingGetWithParams("GetKeyword", { q, country, language, startDate, endDate }, apiKey, fetchImpl);
  return { data: parseBingKeywordTotalResponse(raw), raw };
}

export async function pullBingRelatedKeywords(
  q: string,
  country: string,
  language: string,
  startDate: string,
  endDate: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: BingKeywordRow[]; raw: unknown }> {
  const raw = await bingGetWithParams("GetRelatedKeywords", { q, country, language, startDate, endDate }, apiKey, fetchImpl);
  return { data: parseBingKeywordRowsResponse(raw), raw };
}

export async function pullBingKeywordStats(
  q: string,
  country: string,
  language: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: BingKeywordRow[]; raw: unknown }> {
  const raw = await bingGetWithParams("GetKeywordStats", { q, country, language }, apiKey, fetchImpl);
  return { data: parseBingKeywordRowsResponse(raw), raw };
}

/**
 * Cauda longa pt-BR sobre IA (#5128 item 3, 18 termos — dentro do intervalo
 * "15-20" pedido pela issue). Escritos à mão, cobrindo intenção prática
 * (como usar/aprender/comparar) DIFERENTE das perguntas factuais de
 * `GEO_HUB_QUESTIONS` (que perguntam "o que aconteceu" — cronologia de
 * empresa), então as duas listas não se sobrepõem por construção.
 */
export const BING_LONGTAIL_AI_TERMS: readonly string[] = [
  "como usar inteligência artificial no trabalho",
  "melhor ia gratuita em português",
  "chatgpt ou gemini qual é melhor",
  "como a ia vai afetar meu emprego",
  "cursos gratuitos de inteligência artificial",
  "como usar ia para estudar",
  "inteligência artificial substitui programador",
  "o que é prompt engineering",
  "como funciona o chatgpt",
  "ia generativa o que é",
  "regulamentação de inteligência artificial no brasil",
  "quais profissões vão acabar com a ia",
  "como criar imagens com inteligência artificial",
  "diferença entre ia e machine learning",
  "inteligência artificial na educação",
  "como funciona o claude ia",
  "vantagens e riscos da inteligência artificial",
  "inteligência artificial generativa exemplos",
] as const;

/** União das perguntas dos 6 hubs + cauda longa — os termos consultados no
 * modo `keywords` (#5128 item 3). Reusa `GEO_HUB_QUESTIONS` (não duplica). */
export function buildBingDemandTerms(): string[] {
  return [...GEO_HUB_QUESTIONS, ...BING_LONGTAIL_AI_TERMS];
}

export interface BingKeywordTermEntry {
  term: string;
  keyword: BingCallResult<BingKeywordTotal>;
  related: BingCallResult<BingKeywordRow[]>;
  stats: BingCallResult<BingKeywordRow[]>;
}

/** Payload pure: monta o objeto gravado em `data/seo/bing-keywords-*.json`. */
export function buildBingKeywordsPullOutput(
  country: string,
  language: string,
  startDate: string,
  endDate: string,
  pulledAt: string,
  terms: BingKeywordTermEntry[],
): {
  country: string;
  language: string;
  start_date: string;
  end_date: string;
  pulled_at: string;
  total_terms: number;
  terms: BingKeywordTermEntry[];
} {
  return { country, language, start_date: startDate, end_date: endDate, pulled_at: pulledAt, total_terms: terms.length, terms };
}

// ─────────────────────────────────────────────────────────────────────────
// #5130 — GetLinkCounts / GetUrlLinks (autoridade — backlinks)
// ─────────────────────────────────────────────────────────────────────────

export interface BingLinkCountRow {
  url: string;
  count: number;
}

export interface BingLinkCountsParsed {
  rows: BingLinkCountRow[];
  /** Total de páginas de paginação — `0` quando não há link nenhum
   * (confirmado ao vivo em 12/ago/2026: `{d: {Links: [], TotalPages: 0}}`
   * pra `diar.ia.br`/`arquivo.diar.ia.br`, resposta legítima, não erro). */
  totalPages: number;
}

/**
 * Parseia a resposta de `GetLinkCounts` — **confirmado ao vivo em
 * 12/ago/2026** (#5130 item 2): `{d: {Links: [...], TotalPages: N}}`, um
 * objeto ÚNICO que EMBRULHA o array (diferente do resto dos endpoints deste
 * arquivo, que embrulham o array direto em `d`) — daí `extractD`, não
 * `extractRows`, pra desembrulhar o nível externo antes de ler `.Links`.
 * Tolerante a camelCase. Nunca lança; shape inesperado →
 * `{ rows: [], totalPages: 0 }`.
 */
export function parseBingLinkCountsResponse(json: unknown): BingLinkCountsParsed {
  const obj = (extractD(json) ?? {}) as Record<string, unknown>;
  const rawLinks = obj.Links ?? obj.links;
  const rows = Array.isArray(rawLinks)
    ? rawLinks.map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        return { url: strOr(row.Url ?? row.url), count: numOr0(row.Count ?? row.count) };
      })
    : [];
  return { rows, totalPages: numOr0(obj.TotalPages ?? obj.totalPages) };
}

/**
 * Parseia a resposta de `GetUrlLinks` — os backlinks (URLs) em si, por
 * página de destino. **Não confirmado ao vivo nesta sessão**: a única
 * tentativa real (contra a raiz de `diar.ia.br`, que `GetLinkCounts` já
 * reportou sem NENHUM link de entrada) devolveu `400 InvalidUrl` — esperado
 * (não há URL válida pra consultar quando `GetLinkCounts` está vazio), mas
 * significa que o shape de uma resposta NÃO-vazia segue por confirmar.
 * Tolerante às duas formas plausíveis, na ordem: (a) objeto embrulhando
 * `Links`/`Urls` — simetria com `GetLinkCounts`, mesma família de API; (b)
 * array bruto de string ou `{Url}` embrulhado em `d` (`extractRows`). Nunca
 * lança; nenhuma das duas bate → `[]`.
 */
export function parseBingUrlLinksResponse(json: unknown): string[] {
  const d = extractD(json);
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const obj = d as Record<string, unknown>;
    const rawLinks = obj.Links ?? obj.links ?? obj.Urls ?? obj.urls;
    if (Array.isArray(rawLinks)) {
      return rawLinks
        .map((r) => (typeof r === "string" ? r : strOr((r as Record<string, unknown> | null)?.Url ?? (r as Record<string, unknown> | null)?.url)))
        .filter((s) => s.length > 0);
    }
  }
  const rows = extractRows(json);
  if (!rows) return [];
  return rows
    .map((r) => {
      if (typeof r === "string") return r;
      const row = (r ?? {}) as Record<string, unknown>;
      return strOr(row.Url ?? row.url);
    })
    .filter((s) => s.length > 0);
}

/** Hostname (lowercase) de uma URL — `null` se a string não for uma URL
 * válida (nunca lança). Usado pra agregar domínios distintos. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function pullBingLinkCounts(
  siteUrl: string,
  page: number,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: BingLinkCountsParsed; raw: unknown }> {
  const raw = await bingGetWithParams("GetLinkCounts", { siteUrl, page: String(page) }, apiKey, fetchImpl);
  return { data: parseBingLinkCountsResponse(raw), raw };
}

export async function pullBingUrlLinks(
  siteUrl: string,
  url: string,
  page: number,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: string[]; raw: unknown }> {
  const raw = await bingGetWithParams("GetUrlLinks", { siteUrl, url, page: String(page) }, apiKey, fetchImpl);
  return { data: parseBingUrlLinksResponse(raw), raw };
}

export interface BingLinksPageDetail {
  url: string;
  count: number;
  linkingUrls: string[];
  error: string | null;
}

/**
 * Payload pure: agrega o detalhe por página em domínios/URLs distintos e
 * monta o objeto gravado em `data/seo/bing-links-*.json` (#5130 item 2 — só
 * agregação/persistência, SEM scoreOpportunities). `distinct_domains` vem
 * ORDENADO pra diff estável entre rodadas.
 */
export function buildBingLinksPullOutput(
  site: string,
  pulledAt: string,
  linkCountsError: string | null,
  pages: BingLinksPageDetail[],
): {
  site: string;
  pulled_at: string;
  link_counts_error: string | null;
  total_pages_with_links: number;
  total_linking_urls: number;
  total_distinct_domains: number;
  distinct_domains: string[];
  pages: Array<{ url: string; count: number; linking_urls: string[]; error: string | null }>;
} {
  const allDomains = new Set<string>();
  const allUrls = new Set<string>();
  for (const p of pages) {
    for (const u of p.linkingUrls) {
      allUrls.add(u);
      const d = domainOf(u);
      if (d) allDomains.add(d);
    }
  }
  return {
    site,
    pulled_at: pulledAt,
    link_counts_error: linkCountsError,
    total_pages_with_links: pages.filter((p) => p.count > 0).length,
    total_linking_urls: allUrls.size,
    total_distinct_domains: allDomains.size,
    distinct_domains: [...allDomains].sort(),
    pages: pages.map((p) => ({ url: p.url, count: p.count, linking_urls: p.linkingUrls, error: p.error })),
  };
}

async function mainKeywords(nowMs: number, values: Record<string, string>): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) {
    console.error("[bing-pull] BING_WEBMASTER_API_KEY não definida (.env, ver .env.example).");
    return 1;
  }

  // #5128 item 2, confirmado ao vivo em 12/ago/2026: `country` só é aceito
  // MINÚSCULO ("br", não "BR" — a Bing devolve 400 "out of the range of
  // valid values" pro maiúsculo) e `language` precisa da forma EXATA
  // "pt-BR" (nem "pt-br" nem "pt" sozinho — os dois também 400). Achado
  // NÃO documentado em nenhuma referência textual encontrada — só
  // descoberto testando as variantes ao vivo.
  const country = String(values["country"] ?? "br");
  const language = String(values["language"] ?? "pt-BR");
  const days = Number(values["days"] ?? 30);
  const pulledAt = isoDate(nowMs);
  const endDate = pulledAt;
  const startDate = isoDate(nowMs - days * 24 * 3600 * 1000);
  const terms = buildBingDemandTerms();

  const entries: BingKeywordTermEntry[] = [];
  for (const term of terms) {
    const keyword = await safeBingCall(() => pullBingKeyword(term, country, language, startDate, endDate, apiKey));
    const related = await safeBingCall(() => pullBingRelatedKeywords(term, country, language, startDate, endDate, apiKey));
    const stats = await safeBingCall(() => pullBingKeywordStats(term, country, language, apiKey));
    entries.push({ term, keyword, related, stats });
  }

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const jsonPath = String(values["out"] ?? resolve(seoDir, `bing-keywords-${pulledAt}.json`));
  const output = buildBingKeywordsPullOutput(country, language, startDate, endDate, pulledAt, entries);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  const withDemand = entries.filter((e) => e.keyword.ok && e.keyword.data.impressions > 0).length;
  console.log(
    JSON.stringify(
      { total_terms: entries.length, terms_with_measurable_demand: withDemand, pulled_at: pulledAt, out: jsonPath },
      null,
      2,
    ),
  );
  return 0;
}

async function mainLinks(nowMs: number, values: Record<string, string>): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) {
    console.error("[bing-pull] BING_WEBMASTER_API_KEY não definida (.env, ver .env.example).");
    return 1;
  }

  const site = String(values["site"] ?? BING_DEFAULT_SITE);
  // Teto de paginação pro loop de `GetUrlLinks` (shape de resposta
  // não-vazia não confirmado ao vivo — ver docstring de
  // `parseBingUrlLinksResponse`); sem isso, uma API que nunca devolve array
  // vazio giraria em loop infinito. `GetLinkCounts` não precisa desse teto —
  // devolve `TotalPages` explícito (confirmado ao vivo, #5130 item 2), então
  // sua paginação é exata, não "até vir vazio".
  const maxPages = Number(values["max-pages"] ?? 20);

  const linkCountRows: BingLinkCountRow[] = [];
  let linkCountsError: string | null = null;
  try {
    const first = await pullBingLinkCounts(site, 0, apiKey);
    linkCountRows.push(...first.data.rows);
    const totalPages = Math.min(first.data.totalPages, maxPages);
    for (let page = 1; page < totalPages; page++) {
      const { data } = await pullBingLinkCounts(site, page, apiKey);
      linkCountRows.push(...data.rows);
    }
  } catch (e) {
    linkCountsError = (e as Error).message;
  }

  const pages: BingLinksPageDetail[] = [];
  for (const row of linkCountRows) {
    if (row.count <= 0) {
      pages.push({ url: row.url, count: row.count, linkingUrls: [], error: null });
      continue;
    }
    const linkingUrls: string[] = [];
    let error: string | null = null;
    try {
      for (let page = 0; page < maxPages; page++) {
        const { data } = await pullBingUrlLinks(site, row.url, page, apiKey);
        if (data.length === 0) break;
        linkingUrls.push(...data);
      }
    } catch (e) {
      error = (e as Error).message;
    }
    pages.push({ url: row.url, count: row.count, linkingUrls, error });
  }

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const pulledAt = isoDate(nowMs);
  const jsonPath = String(values["out"] ?? resolve(seoDir, `bing-links-${pulledAt}.json`));
  const output = buildBingLinksPullOutput(site, pulledAt, linkCountsError, pages);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify(
      {
        site,
        pulled_at: pulledAt,
        total_distinct_domains: output.total_distinct_domains,
        total_linking_urls: output.total_linking_urls,
        total_pages_with_links: output.total_pages_with_links,
        out: jsonPath,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function mainSite(nowMs: number, values: Record<string, string>): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const site = String(values["site"] ?? BING_DEFAULT_SITE);

  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) {
    console.error("[bing-pull] BING_WEBMASTER_API_KEY não definida (.env, ver .env.example).");
    return 1;
  }

  let queryRows: BingQueryRow[];
  let trafficRows: BingTrafficRow[];
  try {
    [queryRows, trafficRows] = await Promise.all([pullBingQueryStats(site, apiKey), pullBingTrafficStats(site, apiKey)]);
  } catch (e) {
    console.error(`[bing-pull] ${(e as Error).message}`);
    return 1;
  }

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const pulledAt = isoDate(nowMs);
  const slug = bingSiteSlug(site);
  const jsonPath = String(values["out"] ?? resolve(seoDir, `bing-${slug}-${pulledAt}.json`));
  const output = buildBingPullOutput(site, pulledAt, queryRows, trafficRows);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify(
      {
        site,
        pulled_at: pulledAt,
        total_query_rows: output.total_query_rows,
        total_traffic_rows: output.total_traffic_rows,
        out: jsonPath,
      },
      null,
      2,
    ),
  );
  return 0;
}

/** Dispatcher — `--mode site` (default, retrocompatível #4908) |
 * `--mode keywords` (#5128) | `--mode links` (#5130). `--mode` desconhecido
 * → exit 2 (erro de uso), mesmo vocabulário de exit code do resto do script. */
async function main(nowMs: number): Promise<number> {
  const { values } = parseCliArgs(process.argv.slice(2));
  const mode = String(values["mode"] ?? "site");
  if (mode === "keywords") return mainKeywords(nowMs, values);
  if (mode === "links") return mainLinks(nowMs, values);
  if (mode === "site") return mainSite(nowMs, values);
  console.error(`[bing-pull] --mode desconhecido: "${mode}" (esperado: site, keywords, links)`);
  return 2;
}

if (isMainModule(import.meta.url)) {
  main(Date.now()).then((code) => {
    process.exitCode = code;
  });
}

export { main };
