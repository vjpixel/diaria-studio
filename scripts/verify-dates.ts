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

// User-Agent de browser real — muitos sites (openai.com, exame.com, etc)
// bloqueiam user-agents que identificam bots. Mantemos um header plausível.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
  /**
   * Flag determinística pra renderização (#226). Hoje é alias de `fetch_failed`
   * — true quando não foi possível confirmar a data via fetch da página.
   * Pré-populada aqui em vez de no research-reviewer (Haiku) que divergia
   * em produção, marcando como unverified mesmo quando date_corrected.
   */
  date_unverified: boolean;
  note?: string;
}

function normalizeDate(raw: string): string | null {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    // Ajustar para fuso Brasil (UTC-3) para evitar off-by-one em artigos
    // publicados à noite no BR (23h BRT = 02h UTC do dia seguinte).
    const brOffset = -3 * 60; // minutos
    const localMs = d.getTime() + brOffset * 60 * 1000;
    const localDate = new Date(localMs);
    return localDate.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

async function extractPublishedDate(
  url: string,
  timeoutMs = 10000
): Promise<{ date: string | null; note: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // Usamos `fetch` (undici global) em vez de `undici.request` para seguir
    // redirects automaticamente (303/301/302 são comuns em nature.com etc).
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
      },
    });

    if (res.status >= 400) {
      return { date: null, note: `HTTP ${res.status}` };
    }

    const body = await res.text();

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

    // 4. <meta name="citation_date"> (arxiv, jornais acadêmicos — formato YYYY/MM/DD)
    const citationDate =
      body.match(
        /<meta[^>]+name=["']citation_date["'][^>]+content=["']([^"']+)["']/i
      )?.[1] ??
      body.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_date["']/i
      )?.[1];
    if (citationDate) {
      // citation_date vem como YYYY/MM/DD — normalizeDate lida com ambos os formatos
      const d = normalizeDate(citationDate.replace(/\//g, "-"));
      if (d) return { date: d, note: "meta:citation_date" };
    }

    // 5. <time itemprop="datePublished" datetime="...">
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

    // 6a. JSON embutido — buscar "datePublished" explicitamente antes do regex genérico.
    //     Evita que "dateModified" apareça primeiro e seja capturado pelo regex abaixo.
    const jsonDatePublished = body.match(
      /"datePublished"\s*:\s*"([^"]+)"/
    )?.[1];
    if (jsonDatePublished) {
      const d = normalizeDate(jsonDatePublished);
      if (d) return { date: d, note: "json:datePublished-explicit" };
    }

    // 6. `"published":"YYYY-MM-DD"` em JSON embutido (Apple, alguns Next.js)
    //    Pega a PRIMEIRA ocorrência — tipicamente a do artigo principal no
    //    topo do blob __NEXT_DATA__ / __SVELTE_DATA__ etc.
    const jsonPublished = body.match(
      /"(?:published|published_at|publishedAt|publish_date|first_published_at)"\s*:\s*"([^"]+)"/
    )?.[1];
    if (jsonPublished) {
      const d = normalizeDate(jsonPublished);
      if (d) return { date: d, note: "json:published" };
    }

    // 6b. `<time datetime>` dentro de contexto de artigo (antes do fallback genérico).
    //     Tenta elementos semânticos (article, main, header) antes de cair no
    //     primeiro <time> qualquer do documento, que pode ser de sidebar/comentário/rodapé.
    const articleTimeMatch =
      body.match(
        /<(?:article|main|header)[^>]*>[\s\S]{0,5000}?<time[^>]+datetime=["']([^"']+)["']/i
      ) ??
      body.match(
        /<[^>]+class=["'][^"']*(?:post-date|article-date|publish[^"']*|entry-date|byline)[^"']*["'][^>]*>[\s\S]{0,200}?<time[^>]+datetime=["']([^"']+)["']/i
      );
    if (articleTimeMatch) {
      const d = normalizeDate(articleTimeMatch[1]);
      if (d) return { date: d, note: "time:in-article-context" };
    }

    // 7. Primeiro `<time datetime="...">` do documento (fallback genérico —
    //    OpenAI, por exemplo, marca a data do artigo em `<time dateTime=...>`
    //    sem `itemprop`). Se houver múltiplos, usamos o primeiro (tipicamente
    //    é o cabeçalho do artigo).
    const firstTime =
      body.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ??
      body.match(/<time[^>]+dateTime=["']([^"']+)["']/)?.[1];
    if (firstTime) {
      const d = normalizeDate(firstTime);
      if (d) return { date: d, note: "time:first" };
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
      date_unverified: true,
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
    date_unverified: false,
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
