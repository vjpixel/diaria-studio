/**
 * verify-dates.ts
 *
 * Verifica e corrige as datas de publicação de uma lista de artigos.
 * Para cada artigo, faz GET na URL e tenta extrair a data real de publicação
 * a partir dos metadados da página (JSON-LD → og:article:published_time →
 * meta pubdate → time[itemprop=datePublished]).
 *
 * Uso:
 *   npx tsx scripts/verify-dates.ts <articles.json>
 *   npx tsx scripts/verify-dates.ts <articles.json> <out.json>
 *
 * Input JSON: array de { url: string; date: string }
 * Output JSON: array de DateVerifyResult
 */

import { readFileSync, writeFileSync } from "node:fs";
import { request } from "undici";

interface ArticleInput {
  url: string;
  date: string; // YYYY-MM-DD or ISO string
}

export interface DateVerifyResult {
  url: string;
  original_date: string;
  verified_date: string | null; // null if fetch failed or no date found
  changed: boolean;
  fetch_failed: boolean;
  note?: string;
}

function normalizeDate(raw: string): string | null {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0]; // YYYY-MM-DD
  } catch {
    return null;
  }
}

async function extractPublishedDate(
  url: string,
  timeoutMs = 8000
): Promise<{ date: string | null; note: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await request(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DiariaBot/1.0)" },
    });

    if (res.statusCode >= 400) {
      return { date: null, note: `HTTP ${res.statusCode}` };
    }

    const body = await res.body.text();

    // 1. JSON-LD datePublished (maior confiança — estruturado e intencionalmente exposto)
    for (const match of body.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )) {
      try {
        const data = JSON.parse(match[1]);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item["@graph"]) items.push(...item["@graph"]);
          if (item.datePublished) {
            const d = normalizeDate(item.datePublished);
            if (d) return { date: d, note: "json-ld:datePublished" };
          }
        }
      } catch {
        // JSON-LD malformado — ignorar e tentar próxima estratégia
      }
    }

    // 2. <meta property="article:published_time">
    const ogDate =
      body.match(
        /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i
      )?.[1] ??
      body.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i
      )?.[1];
    if (ogDate) {
      const d = normalizeDate(ogDate);
      if (d) return { date: d, note: "og:article:published_time" };
    }

    // 3. <meta name="pubdate"> / "publish-date" / "date"
    const metaDate =
      body.match(
        /<meta[^>]+name=["'](?:pubdate|publish-date|publishdate|date)["'][^>]+content=["']([^"']+)["']/i
      )?.[1] ??
      body.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:pubdate|publish-date|publishdate|date)["']/i
      )?.[1];
    if (metaDate) {
      const d = normalizeDate(metaDate);
      if (d) return { date: d, note: "meta:pubdate" };
    }

    // 4. <time itemprop="datePublished" datetime="...">
    const timeDate =
      body.match(
        /<time[^>]+itemprop=["']datePublished["'][^>]+datetime=["']([^"']+)["']/i
      )?.[1] ??
      body.match(
        /<time[^>]+datetime=["']([^"']+)["'][^>]+itemprop=["']datePublished["']/i
      )?.[1];
    if (timeDate) {
      const d = normalizeDate(timeDate);
      if (d) return { date: d, note: "time[itemprop=datePublished]" };
    }

    return { date: null, note: "no-date-found" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { date: null, note: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyDate(article: ArticleInput): Promise<DateVerifyResult> {
  const { date, note } = await extractPublishedDate(article.url);
  const originalNorm = normalizeDate(article.date);

  if (!date) {
    return {
      url: article.url,
      original_date: article.date,
      verified_date: null,
      changed: false,
      fetch_failed: true,
      note,
    };
  }

  const changed = originalNorm !== date;
  return {
    url: article.url,
    original_date: article.date,
    verified_date: date,
    changed,
    fetch_failed: false,
    note: changed ? `era ${originalNorm ?? article.date} → encontrado ${date} (${note})` : undefined,
  };
}

async function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Uso: verify-dates.ts <articles.json> [out.json]");
    console.error("  articles.json: array de { url, date }");
    process.exit(1);
  }

  const articles: ArticleInput[] = JSON.parse(readFileSync(inputArg, "utf8"));

  // Concurrency limit: no máximo 5 fetches simultâneos para evitar rate limiting
  const CONCURRENCY = 5;
  const results: DateVerifyResult[] = [];
  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(verifyDate))));
  }

  const changed = results.filter((r) => r.changed).length;
  const failed = results.filter((r) => r.fetch_failed).length;
  console.error(
    `verify-dates: ${results.length} artigos — ${changed} datas corrigidas, ${failed} fetches falhos`
  );

  const outArg = process.argv[3];
  if (outArg) {
    writeFileSync(outArg, JSON.stringify(results, null, 2), "utf8");
    console.error(`Wrote ${results.length} results to ${outArg}`);
  } else {
    process.stdout.write(JSON.stringify(results, null, 2));
  }
}

// Detecta execução direta (npx tsx verify-dates.ts ...) de forma portável no Windows e Unix
const _isMain = process.argv[1] != null &&
  import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").replace(/^.*\//, ""));
if (_isMain) main();
