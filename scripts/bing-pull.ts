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
 *   - `keywords` (#5128, resemeado #5253) → `GetKeyword`/`GetRelatedKeywords`/
 *     `GetKeywordStats`, os 3 endpoints de TERCEIRA parte — respondem "quanto
 *     se busca X em pt-BR" pra um termo arbitrário, independente de
 *     rankearmos. Rodado contra as sementes curadas de `seed/keywords.csv`
 *     (`loadBingKeywordSeeds`, abaixo) — termos comerciais/informacionais
 *     que descrevem a intenção do público (newsletter de IA em pt-BR), NUNCA
 *     derivados de título de matéria.
 *
 *     **#5253 (achado ao vivo em 12/ago/2026, pull `bing-keywords-2026-08-12.json`):**
 *     até aqui a semente incluía `GEO_HUB_QUESTIONS` (as perguntas que os 6
 *     hubs do Worker `arquivo` afirmam responder, `lib/geo-citation-monitor.ts`
 *     — estilo manchete de matéria, ex: "O que aconteceu com a Anthropic em
 *     2026?"). Ninguém busca uma pergunta-manchete verbatim
 *     (`GetKeyword` → `impressions: 0` garantido) e o `GetRelatedKeywords`
 *     da API casa por PREFIXO GENÉRICO da query ("o que aconteceu com...")
 *     em vez de por tema, devolvendo fofoca de celebridade brasileira — ruído
 *     puro, inútil pro planejamento de conteúdo. O fix teve 2 partes:
 *     (1) a semente virou config explícita e curada (`seed/keywords.csv`),
 *     desacoplada de `GEO_HUB_QUESTIONS`; (2) `filterRelevantRelated` descarta
 *     `related` sem nenhum marcador de domínio (IA/tecnologia) antes de
 *     persistir — o `raw` da chamada continua intacto pra auditoria (mesma
 *     disciplina do resto do arquivo), só o campo parseado é filtrado.
 *
 *     **#5624 (achado ao vivo em 18/ago/2026, pull `bing-keywords-2026-08-18.json`):
 *     o mesmo artefato voltou por SUFIXO.** Semente `newsletter de ia` →
 *     `detector de ia`, `viver de ia`, `humanizador de ia gratuito` — toda
 *     query que contém "de ia", sem relação temática nenhuma; o marcador de
 *     domínio isolado ("ia") casa nos dois lados sem provar relação. Fix:
 *     `filterRelevantRelated`/`isRelatedToSeed` ganharam um 2º gate — com a
 *     semente disponível, exige sobreposição de pelo menos 1 token
 *     SIGNIFICATIVO (não-stopword, não-"ia") entre semente e relacionado.
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
 * No modo `links`, isso é o `raw` por chamada `GetUrlLinks` (`pages[].raw`,
 * 1 entrada por página consultada) — é aí que a auditabilidade importa mais,
 * já que `GetUrlLinks` é o único endpoint dos 5 sem shape confirmado ao vivo.
 * `GetLinkCounts` (shape já confirmado, usado só pra paginar/enumerar as
 * URLs de destino) não tem seu `raw` persistido — decisão de escopo, não
 * lacuna: nada nele ficou sem confirmação.
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
 * `--mode site --site all` (#5621) itera os 4 hosts de `BING_KNOWN_SITES`
 * (`scripts/lib/bing.ts`), 1 pull por host, falha per-site tolerada (host
 * ainda não verificado no BWT não derruba os demais):
 *   npx tsx scripts/bing-pull.ts --mode site --site all
 *
 * Env: BING_WEBMASTER_API_KEY (`.env`, ver `.env.example`).
 *
 * Exit: 0 ok (grava JSON); 1 erro de API ou credencial ausente; 2 erro de uso
 * (inclui `--mode` desconhecido).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { BING_DEFAULT_SITE, BING_API_BASE, BING_KNOWN_SITES } from "./lib/bing.ts";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  /** Payload bruto da API — nunca descartado (ver docstring do arquivo: 4 dos
   * 5 endpoints de `keywords`/`links` têm shape confirmado ao vivo em
   * 12/ago/2026; só `GetUrlLinks` ficou sem confirmação real — única
   * tentativa deu `400 InvalidUrl`). */
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

/** Path do CSV de sementes curadas do modo `keywords` (#5253) — override de
 * `root` só para teste (nunca aponta pra fora do checkout em produção). */
export function bingKeywordSeedsPath(root: string = SCRIPT_ROOT): string {
  return resolve(root, "seed", "keywords.csv");
}

/**
 * Parseia o CSV de sementes — 1 termo por linha, header opcional "term"
 * (case-insensitive) e linhas em branco ignoradas. Pure — testável sem I/O.
 */
export function parseBingKeywordSeedsCsv(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.toLowerCase() !== "term");
}

/**
 * Carrega as sementes curadas de `seed/keywords.csv` (#5253) — termos
 * comerciais/informacionais que descrevem a intenção do público real do
 * projeto (newsletter de IA em pt-BR: "newsletter de ia", "ferramentas de
 * inteligência artificial", "curso de ia em português", etc.), NUNCA
 * derivados de título de matéria. Ver docstring do arquivo, seção #5253,
 * pro raciocínio completo de por que a semente antiga (`GEO_HUB_QUESTIONS`)
 * devolvia ruído.
 */
export function loadBingKeywordSeeds(root: string = SCRIPT_ROOT): string[] {
  return parseBingKeywordSeedsCsv(readFileSync(bingKeywordSeedsPath(root), "utf8"));
}

/** Termos consultados no modo `keywords` — por padrão, as sementes curadas de
 * `seed/keywords.csv`. Aceita uma lista explícita (parâmetro `seeds`) pra
 * teste/override sem tocar o disco. */
export function buildBingDemandTerms(seeds: string[] = loadBingKeywordSeeds()): string[] {
  return [...seeds];
}

// ─────────────────────────────────────────────────────────────────────────
// #5253 item 4 — filtro de relevância de domínio pro `related` da API
// ─────────────────────────────────────────────────────────────────────────

/** Marcadores de domínio (IA/tecnologia) usados por `isAiDomainRelevant`
 * abaixo — substring match sobre a query normalizada (minúscula, sem
 * acento). Cobre o vocabulário esperado do `related`/`stats` de um termo
 * semeado por `seed/keywords.csv`; não precisa ser exaustivo — só precisa
 * distinguir "tem relação com IA" de ruído genérico (fofoca de celebridade,
 * notícia não relacionada) que só casou por prefixo de query com a Bing. */
const AI_DOMAIN_MARKERS: readonly string[] = [
  "intelig", "artificial", "chatgpt", "gpt", "llm", "gemini", "claude",
  "openai", "anthropic", "algoritm", "automac", "automat", "tecnolog",
  "digital", "prompt", "robo", "maquina", "deep learning", "rede neural",
  "chatbot", "newsletter",
];

/** Remove acentos e normaliza para minúsculo — comparação tolerante a
 * "inteligência"/"inteligencia". Pure. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Um termo é relevante ao domínio se contém "ia" como PALAVRA ISOLADA (não
 * dentro de outra palavra — "dia"/"companhia" não casam, `\bia\b` sobre a
 * string normalizada) ou algum marcador de `AI_DOMAIN_MARKERS`. Pure —
 * testável sem I/O.
 */
export function isAiDomainRelevant(query: string): boolean {
  const q = normalizeForMatch(query);
  if (/\bia\b/.test(q)) return true;
  return AI_DOMAIN_MARKERS.some((m) => q.includes(m));
}

// ─────────────────────────────────────────────────────────────────────────
// #5624 — o artefato de substring do #5253 voltou por SUFIXO ("de ia")
// ─────────────────────────────────────────────────────────────────────────

/**
 * Palavras funcionais pt-BR ignoradas ao extrair tokens "significativos" de
 * uma query (#5624) — artigos/preposições/conjunções curtas que aparecem em
 * quase toda query e não carregam o tema em si (ex: o "de" de "newsletter
 * de ia"). Não precisa ser exaustiva — só precisa não deixar passar as mais
 * comuns em query curta de busca.
 */
const PT_STOPWORDS: ReadonlySet<string> = new Set([
  "de", "da", "do", "das", "dos", "a", "o", "as", "os", "e", "ou",
  "para", "pra", "com", "em", "no", "na", "nos", "nas", "por", "sobre",
  "que", "um", "uma", "uns", "umas", "se", "ao", "aos",
]);

/**
 * Tokens "significativos" de uma query (#5624): minúsculo/sem acento,
 * quebrado por qualquer não-alfanumérico, excluindo stopwords e o próprio
 * "ia" (marcador de domínio genérico demais pra servir de sinal de
 * sobreposição — é exatamente o token que faz "newsletter de ia" e
 * "detector de ia" parecerem relacionados sem ser). Pure.
 */
function meaningfulTokens(query: string): Set<string> {
  const q = normalizeForMatch(query);
  const out = new Set<string>();
  for (const t of q.split(/[^a-z0-9]+/)) {
    if (!t || t === "ia" || t.length <= 2 || PT_STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * #5624 — sucessor do #5253: o mesmo artefato de casamento por substring da
 * `GetRelatedKeywords` (lá era por PREFIXO genérico — "o que aconteceu
 * com..." devolvendo fofoca de celebridade; achado de 18/08/2026 mostrou o
 * mesmo problema por SUFIXO — semente `newsletter de ia` devolvendo
 * `detector de ia`, `viver de ia`, `humanizador de ia gratuito`: toda query
 * que contém "de ia", sem relação temática nenhuma). `isAiDomainRelevant`
 * sozinho não pega esse caso porque "ia" isolado casa em ambos os lados.
 *
 * Gate adicional: com `seedQuery` informada, exige que `relatedQuery`
 * compartilhe pelo menos 1 token SIGNIFICATIVO (não-stopword, não-"ia") com
 * a semente — é esse token que distingue "newsletter" de "detector". Sem
 * `seedQuery` (chamada legada, #5253) ou quando a semente em si não tem
 * nenhum token significativo (ex: semente literalmente "ia" sozinha — não
 * há o que comparar), cai de volta no gate só de `isAiDomainRelevant`, pra
 * não super-filtrar um caso em que a comparação não faz sentido.
 */
export function isRelatedToSeed(relatedQuery: string, seedQuery?: string): boolean {
  if (!isAiDomainRelevant(relatedQuery)) return false;
  if (!seedQuery) return true;
  const seedTokens = meaningfulTokens(seedQuery);
  if (seedTokens.size === 0) return true;
  const relatedTokens = meaningfulTokens(relatedQuery);
  for (const t of relatedTokens) {
    if (seedTokens.has(t)) return true;
  }
  return false;
}

/**
 * Filtra `related` descartando linhas sem relação com o domínio do projeto
 * (#5253 item 4 — a Bing casa `GetRelatedKeywords` por prefixo genérico da
 * query, não por tema; achado real: "o que aconteceu com" devolvendo fofoca
 * de celebridade brasileira pra uma semente sobre IA) **e**, quando
 * `seedQuery` é passada, sem sobreposição de token significativo com a
 * semente (#5624 — mesmo artefato de substring, agora por sufixo: "newsletter
 * de ia" → "detector de ia" tinha `isAiDomainRelevant` batendo nos dois lados
 * sem nenhuma relação temática real). Nunca aplicado a `stats` (série do
 * MESMO termo semeado, relevante por construção) nem ao `raw` bruto
 * (auditoria — ver docstring do arquivo). Pure.
 */
export function filterRelevantRelated(related: BingKeywordRow[], seedQuery?: string): BingKeywordRow[] {
  return related.filter((r) => isRelatedToSeed(r.query, seedQuery));
}

export interface BingKeywordSummaryRow {
  term: string;
  /** `null` quando a chamada `GetKeyword` falhou (`safeBingCall` capturou
   * erro) — nunca um 0 inventado nesse caso, distinto de "0 impressões
   * medidas de verdade". */
  impressions: number | null;
  broadImpressions: number | null;
  /** `true` só quando a chamada teve sucesso E `impressions === 0` — #5253
   * item 5 ("reportar quantas sementes voltaram com volume zero"). */
  zeroVolume: boolean;
}

/**
 * Resume `impressions`/`broadImpressions` por termo semeado (#5253 itens 3 e
 * 5) — cada pull mensal (`Diaria-Bing-Seo-Monthly-Pull`) grava um JSON datado
 * em `data/seo/bing-keywords-{YYYY-MM-DD}.json`; a série desses arquivos ao
 * longo dos meses É o histórico mensal por termo (nenhum mecanismo de
 * consolidação adicional necessário — o item 3 já está coberto pela
 * cadência + nomenclatura de arquivo existentes). Pure.
 */
export function summarizeBingKeywordTerms(entries: BingKeywordTermEntry[]): BingKeywordSummaryRow[] {
  return entries.map((e) => {
    if (!e.keyword.ok) return { term: e.term, impressions: null, broadImpressions: null, zeroVolume: false };
    const { impressions, broadImpressions } = e.keyword.data;
    return { term: e.term, impressions, broadImpressions, zeroVolume: impressions === 0 };
  });
}

export interface BingKeywordTermEntry {
  term: string;
  keyword: BingCallResult<BingKeywordTotal>;
  related: BingCallResult<BingKeywordRow[]>;
  stats: BingCallResult<BingKeywordRow[]>;
}

/** Payload pure: monta o objeto gravado em `data/seo/bing-keywords-*.json`.
 * `summary`/`terms_with_zero_impressions` (#5253 itens 3 e 5) são derivados
 * de `terms` via `summarizeBingKeywordTerms` — nunca passados separadamente,
 * pra não abrir espaço pra divergir do array bruto. */
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
  terms_with_zero_impressions: number;
  terms: BingKeywordTermEntry[];
  summary: BingKeywordSummaryRow[];
} {
  const summary = summarizeBingKeywordTerms(terms);
  return {
    country,
    language,
    start_date: startDate,
    end_date: endDate,
    pulled_at: pulledAt,
    total_terms: terms.length,
    terms_with_zero_impressions: summary.filter((s) => s.zeroVolume).length,
    terms,
    summary,
  };
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
  /** Payload(s) bruto(s) de cada chamada `GetUrlLinks` feita pra esta URL de
   * destino (1 entrada por página consultada) — nunca descartado, mesmo
   * padrão de `BingKeywordTermEntry`/`raw` no modo `keywords` (ver docstring
   * do arquivo). Vazio quando `count <= 0`: nenhuma chamada `GetUrlLinks` é
   * feita nesse caso (não há link de entrada a paginar). */
  raw: unknown[];
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
  /** Erro de `GetLinkCounts` (se algum) — ver comentário de `linkCountsError`
   * em `mainLinks`: pode conviver com `pages` PARCIALMENTE preenchido quando
   * a falha ocorre numa página > 0 (as páginas anteriores bem-sucedidas
   * continuam em `pages`, não é "nenhum dado capturado"). */
  link_counts_error: string | null;
  total_pages_with_links: number;
  total_linking_urls: number;
  total_distinct_domains: number;
  distinct_domains: string[];
  pages: Array<{ url: string; count: number; linking_urls: string[]; error: string | null; raw: unknown[] }>;
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
    pages: pages.map((p) => ({ url: p.url, count: p.count, linking_urls: p.linkingUrls, error: p.error, raw: p.raw })),
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
    const relatedRaw = await safeBingCall(() => pullBingRelatedKeywords(term, country, language, startDate, endDate, apiKey));
    // #5253 item 4 + #5624: filtra `related` sem relação com o domínio E sem
    // sobreposição de token com a SEMENTE (`term`) ANTES de persistir o campo
    // parseado — o `raw` da chamada (dentro de `relatedRaw`) segue intacto
    // pra auditoria, só `data` é filtrado.
    const related = relatedRaw.ok ? { ...relatedRaw, data: filterRelevantRelated(relatedRaw.data, term) } : relatedRaw;
    const stats = await safeBingCall(() => pullBingKeywordStats(term, country, language, apiKey));
    entries.push({ term, keyword, related, stats });
  }

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const jsonPath = String(values["out"] ?? resolve(seoDir, `bing-keywords-${pulledAt}.json`));
  const output = buildBingKeywordsPullOutput(country, language, startDate, endDate, pulledAt, entries);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  // #5253 item 5: reporta quantas sementes voltaram com volume zero — nunca
  // silencioso sobre isso, é sinal de que a semente pode precisar de revisão.
  const withDemand = entries.filter((e) => e.keyword.ok && e.keyword.data.impressions > 0).length;
  console.log(
    JSON.stringify(
      {
        total_terms: entries.length,
        terms_with_measurable_demand: withDemand,
        terms_with_zero_impressions: output.terms_with_zero_impressions,
        pulled_at: pulledAt,
        out: jsonPath,
      },
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
  // Erro de `GetLinkCounts` — persistido como `link_counts_error` no JSON
  // final. NÃO significa "nenhum dado capturado": se a falha ocorrer numa
  // página > 0 (não a 1ª), `linkCountRows` já tem as rows das páginas
  // anteriores bem-sucedidas, e `pages`/os totais abaixo seguem sendo
  // montados a partir delas — dado parcial, não descartado (achado 3 do
  // self-review #5158, não bloqueante: o nome do campo pode ler como "vazio"
  // quando pode ser parcial; mantido como está, comentário deixa a semântica
  // explícita).
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
      pages.push({ url: row.url, count: row.count, linkingUrls: [], error: null, raw: [] });
      continue;
    }
    const linkingUrls: string[] = [];
    const raw: unknown[] = [];
    let error: string | null = null;
    try {
      for (let page = 0; page < maxPages; page++) {
        const { data, raw: pageRaw } = await pullBingUrlLinks(site, row.url, page, apiKey);
        raw.push(pageRaw);
        if (data.length === 0) break;
        linkingUrls.push(...data);
      }
    } catch (e) {
      error = (e as Error).message;
    }
    pages.push({ url: row.url, count: row.count, linkingUrls, error, raw });
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

/** Pull de 1 site — extraído de `mainSite` (#5621) pra ser reusável tanto no
 * caso `--site {host}` (1 site) quanto `--site all` (itera `BING_KNOWN_SITES`,
 * falha per-site tolerada — ver docstring de `BING_KNOWN_SITES`). Grava o
 * JSON e retorna o resumo impresso; `null` em erro (logado pelo chamador). */
export async function pullOneSite(
  site: string,
  apiKey: string,
  nowMs: number,
  seoDir: string,
  outOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ site: string; pulled_at: string; total_query_rows: number; total_traffic_rows: number; out: string } | null> {
  let queryRows: BingQueryRow[];
  let trafficRows: BingTrafficRow[];
  try {
    [queryRows, trafficRows] = await Promise.all([
      pullBingQueryStats(site, apiKey, fetchImpl),
      pullBingTrafficStats(site, apiKey, fetchImpl),
    ]);
  } catch (e) {
    console.error(`[bing-pull] ${site}: ${(e as Error).message}`);
    return null;
  }

  const pulledAt = isoDate(nowMs);
  const slug = bingSiteSlug(site);
  const jsonPath = outOverride ?? resolve(seoDir, `bing-${slug}-${pulledAt}.json`);
  const output = buildBingPullOutput(site, pulledAt, queryRows, trafficRows);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  return {
    site,
    pulled_at: pulledAt,
    total_query_rows: output.total_query_rows,
    total_traffic_rows: output.total_traffic_rows,
    out: jsonPath,
  };
}

async function mainSite(nowMs: number, values: Record<string, string>): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const siteArg = String(values["site"] ?? BING_DEFAULT_SITE);

  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) {
    console.error("[bing-pull] BING_WEBMASTER_API_KEY não definida (.env, ver .env.example).");
    return 1;
  }

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });

  // #5621: `--site all` itera os 4 hosts conhecidos (`BING_KNOWN_SITES`),
  // com falha per-site tolerada — um host ainda não verificado no BWT (ex:
  // livros/cursos antes do AddSite) não derruba os outros 3 já verificados.
  // `--out` fica sem efeito nesse modo (path é sempre derivado por host, senão
  // os 4 pulls colidiriam no mesmo arquivo).
  if (siteArg === "all") {
    const results: Array<{ site: string; pulled_at: string; total_query_rows: number; total_traffic_rows: number; out: string }> = [];
    let anyFailed = false;
    for (const site of BING_KNOWN_SITES) {
      const r = await pullOneSite(site, apiKey, nowMs, seoDir);
      if (r) results.push(r);
      else anyFailed = true;
    }
    console.log(JSON.stringify({ mode: "site", site: "all", total_sites: BING_KNOWN_SITES.length, ok: results.length, results }, null, 2));
    // Sucesso parcial ainda é sucesso — um host não-verificado é esperado até
    // o AddSite/verificação DNS do #5621 rodar; não travar a rotina inteira
    // por causa disso. Só reprova se TODOS falharem.
    return results.length === 0 && anyFailed ? 1 : 0;
  }

  const result = await pullOneSite(siteArg, apiKey, nowMs, seoDir, values["out"] !== undefined ? String(values["out"]) : undefined);
  if (!result) return 1;
  console.log(JSON.stringify(result, null, 2));
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
