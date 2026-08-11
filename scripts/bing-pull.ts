/**
 * bing-pull.ts (#4908 item 2)
 *
 * Puxa dados de query do Bing Webmaster Tools (API oficial, grátis) — 2ª
 * fonte first-party de demanda de busca em pt-BR do projeto, ao lado de
 * `seo-pull.ts` (Google Search Console). Mirror deliberado de `seo-pull.ts`:
 * mesmo shape de saída em `data/seo/`, mesmo CLI (`--site`/`--out`),
 * mesma disciplina de payload puro testável — diferindo só no transporte de
 * auth (aqui: `apikey` como query param, não OAuth) e no fato de consultar
 * DUAS propriedades de prefixo de URL em vez de uma propriedade de domínio
 * (ver `scripts/lib/bing.ts`).
 *
 * **Escopo deliberadamente mínimo** (issue #4908, comentário do editor
 * 260811): isto é o pull+persist inicial da série — não uma pipeline de
 * scoring de oportunidades como `seo-pull.ts` tem (`scoreOpportunities`). As
 * propriedades BWT foram verificadas em 11/ago/2026 e a 1ª consulta ao vivo
 * (mesmo comentário da issue) devolveu 0 linhas pros dois hosts em
 * `GetQueryStats`/`GetRankAndTrafficStats`/`GetCrawlStats` — esperado (BWT
 * não faz backfill de propriedade nova), mas também não há nada ainda pra
 * escorar um rubrico de scoring. Quando o volume acumulado justificar,
 * espelhar `scoreOpportunities` aqui é o próximo passo natural (não feito
 * nesta unidade — fora do escopo aprovado dos itens 1-2 da issue).
 *
 * `GetCrawlStats` fica de fora de propósito: é sobre saúde de crawl/índice
 * (tema do #4909), não sobre "alguém busca isso" (tema desta issue).
 *
 * **Shape da resposta não verificado ao vivo nesta sessão** — a conta
 * devolveu 0 linhas na única consulta real já feita (issue #4908), então não
 * dá pra inspecionar o formato de uma linha não-vazia. Os parsers abaixo
 * seguem o schema documentado do SDK oficial do BWT (PascalCase:
 * `Query`/`Clicks`/`Impressions`/`AvgClickPosition`/`AvgImpressionPosition`,
 * datas no formato `.NET` `/Date(ms)/`), com fallback camelCase e defaults
 * tolerantes — mesma filosofia null-safe de `parseGscResponse`
 * (`seo-pull.ts`): elemento/campo inesperado nunca crasha o pull, só perde o
 * campo. Se a 1ª linha real chegar com um shape diferente do assumido,
 * ajustar os parsers então — não há como validar isso sem dado real.
 *
 * Endpoints consultados (GET, auth via query param `apikey` + `siteUrl`):
 *   GetQueryStats(siteUrl)          → linhas por query (agregado, sem data)
 *   GetRankAndTrafficStats(siteUrl) → linhas por dia (agregado, sem query)
 *
 * Uso:
 *   npx tsx scripts/bing-pull.ts [--site https://diar.ia.br/] \
 *     [--out data/seo/bing-{slug}-{YYYY-MM-DD}.json]
 *
 * Pra consultar a 2ª propriedade verificada:
 *   npx tsx scripts/bing-pull.ts --site https://arquivo.diar.ia.br/
 *
 * Env: BING_WEBMASTER_API_KEY (`.env`, ver `.env.example`).
 *
 * Exit: 0 ok (grava JSON); 1 erro de API ou credencial ausente; 2 erro de uso.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { BING_DEFAULT_SITE, BING_API_BASE } from "./lib/bing.ts";

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

async function main(nowMs: number): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
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

if (isMainModule(import.meta.url)) {
  main(Date.now()).then((code) => {
    process.exitCode = code;
  });
}

export { main };
