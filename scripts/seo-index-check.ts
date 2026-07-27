/**
 * seo-index-check.ts (#4105 — 2º passo do loop de SEO #1896)
 *
 * Mede COBERTURA DE INDEXAÇÃO: pra cada URL do sitemap, pergunta ao Google (URL
 * Inspection API) se ela está no índice. É o KPI que faz sentido enquanto o
 * Search Analytics ainda não tem histórico — sem página indexada não existe
 * impressão, e sem impressão o `seo-pull.ts` não tem o que pontuar.
 *
 * Linha de base da primeira rodada (260727, logo após a verificação da
 * propriedade): das 223 edições do sitemap, 24 indexadas (10,8%), 182
 * "Detectada, mas não indexada" e 70 sem nenhuma página de referência. Causa
 * provável: /archive serve só ~5 links `/p/` no HTML (o resto é paginação por
 * JS), então quase nenhum post tem link interno rastreável. Este script
 * transforma esse achado pontual em série temporal, pra saber se as correções
 * de linkagem interna (#4105) funcionaram.
 *
 * Quota da API: 2.000 inspeções/dia e 600/min por propriedade. O default de 200
 * URLs/rodada cabe folgado e cobre o sitemap inteiro em 2 execuções.
 *
 * Uso:
 *   npx tsx scripts/seo-index-check.ts [--site sc-domain:diar.ia.br]
 *     [--sitemap https://diar.ia.br/sitemap.xml] [--limit 200] [--concurrency 4]
 *     [--only-posts] [--out data/seo/index-status-{YYYY-MM-DD}.json]
 *
 * Exit: 0 ok (grava JSON + index-status-{data}.md); 1 erro de API/rede; 2 uso.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { parseSitemap } from "./lib/fetch-sitemap.ts";
import { gFetch } from "./google-auth.ts";

/**
 * Propriedade GSC padrão. Domain property (`sc-domain:`) cobre TODOS os hosts e
 * protocolos de diar.ia.br — inclusive o `diaria.beehiiv.com` legado, que 301a
 * pra cá e está na conta como `siteUnverifiedUser` (consultá-lo dá 403).
 *
 * Constante local de propósito: o `seo-pull.ts` tem a dele, corrigida em
 * paralelo pela PR #4099. Compartilhar exigiria que uma das duas PRs esperasse a
 * outra — e a duplicação de um literal é mais barata que o acoplamento.
 * Consolidar em `lib/` quando as duas estiverem em master.
 */
export const DEFAULT_SITE = "sc-domain:diar.ia.br";

const INSPECT_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const DEFAULT_SITEMAP = "https://diar.ia.br/sitemap.xml";
/** Quota diária da API é 2.000; 200/rodada deixa margem pra retry e uso manual. */
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;

export interface IndexStatus {
  url: string;
  /** PASS = indexada; NEUTRAL/FAIL = não. Ausente se a chamada falhou. */
  verdict?: string;
  /** Texto do Google, ex: "Enviada e indexada", "Detectada, mas não indexada no momento". */
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  /** Página que linka pra esta URL. Vazio = órfã (só existe no sitemap). */
  referringUrls?: string[];
  error?: string;
}

export interface IndexSummary {
  total: number;
  indexed: number;
  not_indexed: number;
  errors: number;
  /** Percentual de cobertura, 0..100 com 1 casa. */
  coverage_pct: number;
  /** Contagem por coverageState, pra ver o MOTIVO dominante de não-indexação. */
  by_coverage_state: Record<string, number>;
  /** URLs sem nenhuma página de referência (só o sitemap aponta pra elas). */
  orphan_count: number;
}

/** Parseia a resposta do urlInspection em IndexStatus (shape achatado). */
export function parseInspection(url: string, json: unknown): IndexStatus {
  const r = (json as { inspectionResult?: { indexStatusResult?: Record<string, unknown> } })
    ?.inspectionResult?.indexStatusResult;
  if (!r) return { url, error: "resposta sem indexStatusResult" };
  const referring = r["referringUrls"];
  return {
    url,
    verdict: r["verdict"] as string | undefined,
    coverageState: r["coverageState"] as string | undefined,
    robotsTxtState: r["robotsTxtState"] as string | undefined,
    indexingState: r["indexingState"] as string | undefined,
    lastCrawlTime: r["lastCrawlTime"] as string | undefined,
    googleCanonical: r["googleCanonical"] as string | undefined,
    referringUrls: Array.isArray(referring) ? (referring as string[]) : [],
  };
}

/**
 * Agrega os status numa métrica única. `verdict === "PASS"` é o sinal
 * autoritativo de "está no índice" — `coverageState` é texto localizado
 * (pt-BR na conta do editor) e NÃO deve ser comparado por string (#573:
 * validar estado externo por campo determinístico, não pelo gloss).
 */
export function summarize(rows: IndexStatus[]): IndexSummary {
  const byState: Record<string, number> = {};
  let indexed = 0;
  let errors = 0;
  let orphans = 0;
  for (const r of rows) {
    if (r.error) {
      errors++;
      continue;
    }
    if (r.verdict === "PASS") indexed++;
    const state = r.coverageState ?? "(sem coverageState)";
    byState[state] = (byState[state] ?? 0) + 1;
    if ((r.referringUrls?.length ?? 0) === 0) orphans++;
  }
  const scored = rows.length - errors;
  return {
    total: rows.length,
    indexed,
    not_indexed: scored - indexed,
    errors,
    coverage_pct: scored === 0 ? 0 : Math.round((indexed / scored) * 1000) / 10,
    by_coverage_state: byState,
    orphan_count: orphans,
  };
}

/** Só as URLs de edição (`/p/…`) — as institucionais poluem a métrica. */
export function filterPosts(urls: string[]): string[] {
  return urls.filter((u) => /\/p\//.test(u));
}

/**
 * Roda `worker` sobre `items` com no máximo `concurrency` em voo. Mantém a
 * ordem da entrada no resultado.
 */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

async function inspectUrl(site: string, url: string): Promise<IndexStatus> {
  try {
    const res = await gFetch(INSPECT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: site, languageCode: "pt-BR" }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 403) {
        return { url, error: `403 — '${site}' não verificada no GSC ou scope webmasters.readonly ausente (rode oauth-setup.ts). ${body}` };
      }
      if (res.status === 429) return { url, error: `429 — quota da URL Inspection API estourada (2.000/dia). ${body}` };
      return { url, error: `${res.status}: ${body}` };
    }
    return parseInspection(url, await res.json());
  } catch (e) {
    return { url, error: (e as Error).message };
  }
}

export function renderMd(rows: IndexStatus[], sum: IndexSummary, site: string, date: string): string {
  const lines = [
    `# Cobertura de indexação — ${site} (${date})`,
    "",
    `**${sum.indexed}/${sum.total - sum.errors} indexadas (${sum.coverage_pct}%)** · ${sum.orphan_count} sem página de referência · ${sum.errors} erro(s).`,
    "",
    "## Por estado",
    "",
  ];
  for (const [state, n] of Object.entries(sum.by_coverage_state).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${n}× ${state}`);
  }
  const notIndexed = rows.filter((r) => !r.error && r.verdict !== "PASS");
  if (notIndexed.length) {
    lines.push("", `## Não indexadas (${notIndexed.length})`, "");
    for (const r of notIndexed.slice(0, 100)) {
      const orphan = (r.referringUrls?.length ?? 0) === 0 ? " — órfã (sem link interno)" : "";
      lines.push(`- ${r.url} — ${r.coverageState ?? r.verdict ?? "?"}${orphan}`);
    }
    if (notIndexed.length > 100) lines.push(`- … +${notIndexed.length - 100} (ver JSON)`);
  }
  const errored = rows.filter((r) => r.error);
  if (errored.length) {
    lines.push("", `## Erros (${errored.length})`, "");
    for (const r of errored.slice(0, 20)) lines.push(`- ${r.url} — ${r.error}`);
  }
  return lines.join("\n") + "\n";
}

async function main(nowMs: number): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const site = String(values["site"] ?? DEFAULT_SITE);
  const sitemapUrl = String(values["sitemap"] ?? DEFAULT_SITEMAP);
  const limit = parseInt(String(values["limit"] ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  const concurrency = parseInt(String(values["concurrency"] ?? DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY;
  const date = new Date(nowMs).toISOString().slice(0, 10);

  let urls: string[];
  try {
    const res = await fetch(sitemapUrl, { headers: { "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br)" } });
    if (!res.ok) throw new Error(`sitemap ${res.status}`);
    urls = parseSitemap(await res.text()).map((e) => e.loc);
  } catch (e) {
    console.error(`[seo-index-check] falha ao ler ${sitemapUrl}: ${(e as Error).message}`);
    return 1;
  }
  if (flags.has("only-posts")) urls = filterPosts(urls);
  const dropped = Math.max(0, urls.length - limit);
  urls = urls.slice(0, limit);
  if (dropped > 0) console.error(`[seo-index-check] aviso: ${dropped} URL(s) além de --limit ${limit} não foram inspecionadas`);

  const rows = await mapLimit(urls, concurrency, (u) => inspectUrl(site, u));
  const sum = summarize(rows);

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const jsonPath = String(values["out"] ?? resolve(seoDir, `index-status-${date}.json`));
  writeFileSync(jsonPath, JSON.stringify({ site, date, sitemap: sitemapUrl, summary: sum, rows }, null, 2));
  writeFileSync(resolve(seoDir, `index-status-${date}.md`), renderMd(rows, sum, site, date));
  console.log(JSON.stringify({ site, date, ...sum, out: jsonPath }, null, 2));
  // Erro em TODAS as URLs = falha real (quota/scope), não "0% de cobertura".
  return sum.errors === rows.length && rows.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main(Date.now()).then((code) => {
    process.exitCode = code;
  });
}

export { main };
