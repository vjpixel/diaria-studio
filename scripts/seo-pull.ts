/**
 * seo-pull.ts (#1989 — 1º passo do loop de SEO #1896)
 *
 * Puxa dados de busca orgânica do Google Search Console (Search Analytics API,
 * grátis) por página/query e identifica oportunidades: páginas com impressão mas
 * CTR baixo (oportunidade de meta/título) e queries rankeando posição 5-15
 * (quase-primeira-página). Reusa o OAuth Google existente (gFetch) + o scope
 * `webmasters` (adicionado em oauth-setup.ts; era `.readonly` até o #4546).
 *
 * **Pré-req (feito em 260727, #4089):** `diar.ia.br` verificado como propriedade
 * **Domínio** (`sc-domain:diar.ia.br`) via TXT no Cloudflare, e a Google Search
 * Console API habilitada no projeto GCP — ela estava DESLIGADA desde o #1989,
 * que é por que este script nunca chegou a gerar `data/seo/`.
 *
 * Uso:
 *   npx tsx scripts/seo-pull.ts [--site sc-domain:diar.ia.br] [--days 28] \
 *     [--out data/seo/gsc-{YYYY-MM-DD}.json] [--dimensions page,query,date,country]
 *
 * Exit: 0 ok (grava JSON + opportunities.md); 1 erro de API (ex: scope ausente
 * → mensagem pedindo oauth-setup); 2 erro de uso. Sem GSC verificado → 403 com
 * remediação clara.
 *
 * **#5119 — dimensões ampliadas + discover/news.** A chamada principal
 * (`type: "web"`) ganhou `date` e `country` nas dimensões default (antes só
 * `page,query`, que devolvia um agregado do período sem série temporal e sem
 * separar demanda pt-BR — objeto declarado do #4908). Uma 2ª e 3ª chamada,
 * best-effort e não-fatais (falha registra aviso e segue com `rows: []`, não
 * derruba a rodada), puxam `type: "discover"` e `type: "news"` — esses dois
 * tipos não suportam a dimensão `query` na Search Analytics API, só
 * `page`/`date`/`country`/`device`. Vazio é REGISTRADO (`total_rows: 0,
 * rows: []`), nunca omitido — é resposta, não ausência de resposta.
 *
 * **#5973 — retry+timeout no fetch da Search Analytics API.** Mesmo padrão
 * de single-shot fetch que causou o #5943 no passo "index" da mesma unit
 * semanal (`Diaria-SEO-Weekly`): um blip de rede em `pullGsc` também
 * derrubava o passo "pull" inteiro sem retry. `pullGsc` agora usa
 * `fetchWithRetry` (`scripts/lib/fetch-retry.ts`) — erro de rede/5xx
 * tenta de novo, 4xx (ex: 403 de permissão) falha já na 1ª tentativa.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { GSC_DEFAULT_SITE } from "./lib/gsc.ts";
import { gFetch } from "./google-auth.ts";
import { fetchWithRetry } from "./lib/fetch-retry.ts";

/** Dimensões suportadas pelas chamadas deste script (#5119). `query` só é
 * válida em `type: "web"` — Discover/News não têm dado de query. */
export type GscDimension = "page" | "query" | "date" | "country";

export interface GscRow {
  /** keys[] da API, na MESMA ordem de `dimensions` (achatado por `parseGscResponse`). */
  page: string;
  query?: string;
  /** YYYY-MM-DD — presente quando `dimensions` inclui `"date"` (#5119 item 2). */
  date?: string;
  /** Código de país ISO 3166-1 alpha-3 minúsculo (ex: "bra") — presente quando
   * `dimensions` inclui `"country"` (#5119 item 3). */
  country?: string;
  clicks: number;
  impressions: number;
  ctr: number; // 0..1
  position: number;
}

export interface SeoOpportunity {
  type: "low_ctr" | "near_first_page";
  page: string;
  query?: string;
  impressions: number;
  ctr: number;
  position: number;
  reason: string;
}

// CTR esperado por faixa de posição (benchmark grosseiro de organic search).
// Posição 1 ~30%, 2-3 ~15%, 4-5 ~8%, 6-10 ~3%. Abaixo disso com impressão alta
// = título/meta description fraco (oportunidade barata: reescrever, não criar conteúdo).
function expectedCtr(position: number): number {
  if (position <= 1.5) return 0.25;
  if (position <= 3) return 0.12;
  if (position <= 5) return 0.06;
  if (position <= 10) return 0.025;
  return 0.01;
}

/**
 * Pure (#1989): pontua oportunidades de SEO a partir das rows do GSC.
 *  - low_ctr: impressões ≥ minImpressions E ctr < metade do esperado pra posição
 *    → meta/título fraco (a página JÁ rankeia, só não atrai o clique).
 *  - near_first_page: posição 5-15 com impressões ≥ minImpressions → empurrão de
 *    conteúdo/título pode levar pra 1ª página.
 */
export function scoreOpportunities(rows: GscRow[], minImpressions = 50): SeoOpportunity[] {
  const out: SeoOpportunity[] = [];
  for (const r of rows) {
    if (r.impressions < minImpressions) continue;
    const exp = expectedCtr(r.position);
    if (r.ctr < exp * 0.5) {
      out.push({
        type: "low_ctr",
        page: r.page,
        query: r.query,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
        reason: `CTR ${(r.ctr * 100).toFixed(1)}% << esperado ~${(exp * 100).toFixed(0)}% na posição ${r.position.toFixed(1)} — meta/título fraco`,
      });
    } else if (r.position >= 5 && r.position <= 15) {
      out.push({
        type: "near_first_page",
        page: r.page,
        query: r.query,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
        reason: `posição ${r.position.toFixed(1)} (quase 1ª página) com ${r.impressions} impressões — empurrão de conteúdo/título`,
      });
    }
  }
  // mais impressões primeiro (maior potencial)
  return out.sort((a, b) => b.impressions - a.impressions);
}

/** Parseia a resposta da Search Analytics API em GscRow[] (dimensions [page,query]). */
/**
 * Achata `keys[]` conforme a ORDEM de `dimensions` (#5119 — antes assumia
 * fixo `[page, query]`; agora `keys[i]` mapeia pra `dimensions[i]`, então
 * `["page","query","date","country"]` popula os 4 campos correspondentes de
 * `GscRow`, e `["page","date"]` — usado nos pulls de discover/news, que não
 * têm dimensão `query` — popula só `page`+`date`).
 */
export function parseGscResponse(json: unknown, dimensions: GscDimension[] = ["page", "query"]): GscRow[] {
  const rows = (json as { rows?: unknown[] })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    // (r ?? {}): elemento null/undefined no array não crasha (code-review #1989).
    const row = (r ?? {}) as { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
    const keys = row.keys ?? [];
    const dims: Partial<Record<GscDimension, string>> = {};
    dimensions.forEach((d, i) => {
      if (keys[i] !== undefined) dims[d] = keys[i];
    });
    return {
      page: dims.page ?? "",
      query: dims.query,
      date: dims.date,
      country: dims.country,
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    };
  });
}

/** YYYY-MM-DD a partir de um epoch ms (injetável pra teste). */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function pullGsc(
  site: string,
  startDate: string,
  endDate: string,
  dimensions: GscDimension[],
  type: string,
): Promise<GscRow[]> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await fetchWithRetry((signal) =>
    gFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions, rowLimit: 5000, type }),
      signal,
    }),
  );
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) {
      throw new Error(
        // #4089: a causa (c) foi a real em 260727 e não estava listada — a
        // mensagem mandava verificar propriedade/scope, nenhum dos dois sendo
        // o problema. O corpo distingue: "has not been used in project" = (c);
        // "does not have sufficient permission for site" = (a).
        `GSC 403 — três causas possíveis: (a) '${site}' não verificado no Search Console, ou esta conta não é usuária dele; (b) scope ausente → re-rode 'npx tsx scripts/oauth-setup.ts' (webmasters, #1989/#4546); (c) a Google Search Console API está desabilitada no projeto GCP → habilite em console.cloud.google.com/apis/library/searchconsole.googleapis.com. Body: ${body.slice(0, 200)}`,
      );
    }
    throw new Error(`GSC ${type} ${res.status}: ${body.slice(0, 200)}`);
  }
  return parseGscResponse(await res.json(), dimensions);
}

/**
 * Payload pure (#4908 item 1): monta o objeto gravado em `data/seo/gsc-*.json`.
 * Extraído de `main()` pra ter ponto de injeção testável — antes o `writeFileSync`
 * descartava `rows` (só gravava `site`/`period`/`total_rows`/`opportunities`),
 * então nenhuma rodada semanal deixava rastro de query em pt-BR pra medir
 * demanda (#4908). `rows` entra na saída; `opportunities` continua derivado
 * de `scoreOpportunities` (sem mudar esse contrato — #4908 item 1 é só
 * parar de jogar fora o dado já buscado).
 */
/** `{total_rows, rows}` de um pull de discover/news (#5119 item 4). Vazio é
 * um resultado gravado (`total_rows: 0, rows: []`), não um campo ausente —
 * "não temos impressão no Discover" é resposta, não falta de resposta. */
export interface GscTypeResult {
  total_rows: number;
  rows: GscRow[];
}

export interface SeoPullOutput {
  site: string;
  period: string;
  total_rows: number;
  rows: GscRow[];
  opportunities: SeoOpportunity[];
  /** `type: "discover"` (#5119 item 4) — sem dimensão `query` (a API não a suporta pra este tipo). */
  discover: GscTypeResult;
  /** `type: "news"` (#5119 item 4) — mesma ressalva de `discover`. */
  news: GscTypeResult;
}

export function buildSeoPullOutput(
  rows: GscRow[],
  site: string,
  period: string,
  discoverRows: GscRow[] = [],
  newsRows: GscRow[] = [],
): SeoPullOutput {
  return {
    site,
    period,
    total_rows: rows.length,
    rows,
    opportunities: scoreOpportunities(rows),
    discover: { total_rows: discoverRows.length, rows: discoverRows },
    news: { total_rows: newsRows.length, rows: newsRows },
  };
}

function renderOpportunitiesMd(opps: SeoOpportunity[], site: string, period: string): string {
  const lines = [`# Oportunidades SEO — ${site} (${period})`, "", `${opps.length} oportunidades (≥50 impressões).`, ""];
  for (const o of opps.slice(0, 50)) {
    lines.push(`- **${o.type}** ${o.page}${o.query ? ` — "${o.query}"` : ""}`);
    lines.push(`  - ${o.reason} (${o.impressions} impr, CTR ${(o.ctr * 100).toFixed(1)}%, pos ${o.position.toFixed(1)})`);
  }
  return lines.join("\n") + "\n";
}

/** Default da chamada principal (`type: "web"`) — #5119: `date`+`country`
 * entraram pra dar série temporal e separar demanda pt-BR. */
const DEFAULT_DIMENSIONS: GscDimension[] = ["page", "query", "date", "country"];
/** Discover/News não suportam `query` na Search Analytics API. */
const DISCOVER_NEWS_DIMENSIONS: GscDimension[] = ["page", "date"];

async function main(nowMs: number): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  // #4089 (propriedade) + #4108 (constante única): o porquê do `sc-domain:` e de
  // não somar com o host beehiiv está em `lib/gsc.ts`, junto da constante.
  const site = String(values["site"] ?? GSC_DEFAULT_SITE);
  const days = parseInt(String(values["days"] ?? "28"), 10) || 28;
  const endDate = isoDate(nowMs);
  const startDate = isoDate(nowMs - days * 86_400_000);
  const dimensions = values["dimensions"]
    ? (String(values["dimensions"]).split(",").map((s) => s.trim()) as GscDimension[])
    : DEFAULT_DIMENSIONS;
  let rows: GscRow[];
  try {
    rows = await pullGsc(site, startDate, endDate, dimensions, "web");
  } catch (e) {
    console.error(`[seo-pull] ${(e as Error).message}`);
    return 1;
  }

  // #5119 item 4: discover/news são best-effort — uma falha aqui (ex: conta
  // sem permissão nesse tipo, ou o tipo não existir pra esta propriedade)
  // não pode derrubar a rodada principal, que já tem o dado que importa.
  // Vazio é REGISTRADO (rows: []), não omitido — "sem impressão no
  // Discover" é resposta.
  let discoverRows: GscRow[] = [];
  try {
    discoverRows = await pullGsc(site, startDate, endDate, DISCOVER_NEWS_DIMENSIONS, "discover");
  } catch (e) {
    console.error(`[seo-pull] aviso: pull type=discover falhou, seguindo sem esses dados: ${(e as Error).message}`);
  }
  let newsRows: GscRow[] = [];
  try {
    newsRows = await pullGsc(site, startDate, endDate, DISCOVER_NEWS_DIMENSIONS, "news");
  } catch (e) {
    console.error(`[seo-pull] aviso: pull type=news falhou, seguindo sem esses dados: ${(e as Error).message}`);
  }

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const period = `${startDate}_${endDate}`;
  const jsonPath = String(values["out"] ?? resolve(seoDir, `gsc-${endDate}.json`));
  const output = buildSeoPullOutput(rows, site, period, discoverRows, newsRows);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  writeFileSync(resolve(seoDir, `opportunities-${endDate}.md`), renderOpportunitiesMd(output.opportunities, site, period));
  console.log(
    JSON.stringify(
      {
        site,
        period,
        total_rows: output.total_rows,
        opportunities: output.opportunities.length,
        discover_rows: output.discover.total_rows,
        news_rows: output.news.total_rows,
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
