/**
 * seo-pull.ts (#1989 — 1º passo do loop de SEO #1896)
 *
 * Puxa dados de busca orgânica do Google Search Console (Search Analytics API,
 * grátis) por página/query e identifica oportunidades: páginas com impressão mas
 * CTR baixo (oportunidade de meta/título) e queries rankeando posição 5-15
 * (quase-primeira-página). Reusa o OAuth Google existente (gFetch) + o scope
 * `webmasters.readonly` (adicionado em oauth-setup.ts).
 *
 * **Pré-req do editor (1x):** verificar `https://diaria.beehiiv.com/` como
 * propriedade URL-prefix no GSC (esse é o host canônico — diar.ia.br só 302a).
 *
 * Uso:
 *   npx tsx scripts/seo-pull.ts [--site https://diaria.beehiiv.com/] [--days 28] \
 *     [--out data/seo/gsc-{YYYY-MM-DD}.json]
 *
 * Exit: 0 ok (grava JSON + opportunities.md); 1 erro de API (ex: scope ausente
 * → mensagem pedindo oauth-setup); 2 erro de uso. Sem GSC verificado → 403 com
 * remediação clara.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { gFetch } from "./google-auth.ts";

export interface GscRow {
  /** keys[] da API: [page] ou [page, query] conforme dimensions. */
  page: string;
  query?: string;
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
export function parseGscResponse(json: unknown): GscRow[] {
  const rows = (json as { rows?: unknown[] })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    // (r ?? {}): elemento null/undefined no array não crasha (code-review #1989).
    const row = (r ?? {}) as { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
    const keys = row.keys ?? [];
    return {
      page: keys[0] ?? "",
      query: keys[1],
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

async function pullGsc(site: string, startDate: string, endDate: string): Promise<GscRow[]> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await gFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate, dimensions: ["page", "query"], rowLimit: 5000, type: "web" }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) {
      throw new Error(
        `GSC 403 — propriedade não verificada OU scope ausente. (a) verifique '${site}' no Search Console; (b) re-rode 'npx tsx scripts/oauth-setup.ts' (o scope webmasters.readonly foi adicionado em #1989). Body: ${body.slice(0, 200)}`,
      );
    }
    throw new Error(`GSC ${res.status}: ${body.slice(0, 200)}`);
  }
  return parseGscResponse(await res.json());
}

function renderOpportunitiesMd(opps: SeoOpportunity[], site: string, period: string): string {
  const lines = [`# Oportunidades SEO — ${site} (${period})`, "", `${opps.length} oportunidades (≥50 impressões).`, ""];
  for (const o of opps.slice(0, 50)) {
    lines.push(`- **${o.type}** ${o.page}${o.query ? ` — "${o.query}"` : ""}`);
    lines.push(`  - ${o.reason} (${o.impressions} impr, CTR ${(o.ctr * 100).toFixed(1)}%, pos ${o.position.toFixed(1)})`);
  }
  return lines.join("\n") + "\n";
}

async function main(nowMs: number): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const site = String(values["site"] ?? "https://diaria.beehiiv.com/");
  const days = parseInt(String(values["days"] ?? "28"), 10) || 28;
  const endDate = isoDate(nowMs);
  const startDate = isoDate(nowMs - days * 86_400_000);
  let rows: GscRow[];
  try {
    rows = await pullGsc(site, startDate, endDate);
  } catch (e) {
    console.error(`[seo-pull] ${(e as Error).message}`);
    return 1;
  }
  const opps = scoreOpportunities(rows);
  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const period = `${startDate}_${endDate}`;
  const jsonPath = String(values["out"] ?? resolve(seoDir, `gsc-${endDate}.json`));
  writeFileSync(jsonPath, JSON.stringify({ site, period, total_rows: rows.length, opportunities: opps }, null, 2));
  writeFileSync(resolve(seoDir, `opportunities-${endDate}.md`), renderOpportunitiesMd(opps, site, period));
  console.log(JSON.stringify({ site, period, total_rows: rows.length, opportunities: opps.length, out: jsonPath }, null, 2));
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/seo-pull\.ts$/.test(_argv1)) {
  main(Date.now()).then((code) => {
    process.exitCode = code;
  });
}

export { main };
