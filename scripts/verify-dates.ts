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
import { loadCachedBody } from "./lib/url-body-cache.ts";
import {
  parseArxivId,
  arxivIdSentinelDate,
  isClearlyBeforeCutoff,
} from "./lib/arxiv-id.ts";
import type { VerifyDateOptions } from "./lib/verify-options.ts";

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
  /**
   * Sinaliza se este resultado veio do body cache (#717 hyp 1) ou do fetch
   * normal. Usado por `main()` pra acumular hits/misses. Undefined quando
   * o caminho não tocou cache (ex: arxiv pre-skip). #836: replaced module-
   * level CACHE_HITS/CACHE_MISSES counters.
   */
  _cacheHit?: boolean;
  /**
   * Sinaliza arxiv pre-skip (#717 hyp 4). Usado por main() pra contagem.
   * Undefined quando não foi pre-skip.
   */
  _arxivPreSkipped?: boolean;
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

/**
 * Pura: extrai a melhor data possível do body HTML usando 7 estratégias
 * em ordem de confiança. Sem I/O, sem state. #836: extraída de
 * `extractPublishedDate` pra simplificar attach de cacheHit no wrapper.
 */
function extractDateFromBody(body: string): { date: string | null; note: string } {
  try {

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
    // Captura erros do parse/regex (raro). Erros de fetch/timeout já tratados acima.
    const msg = e instanceof Error ? e.message : String(e);
    return { date: null, note: msg };
  }
}

/**
 * Orquestra: carrega body do cache (se disponível) ou faz fetch, depois
 * delega pra `extractDateFromBody` pra parsing puro. Retorna o resultado
 * + cacheHit pra accumulação em main(). #836: substitui as vars module-
 * level CACHE_HITS/CACHE_MISSES por per-call return.
 */
async function extractPublishedDate(
  url: string,
  bodiesDir: string | null,
  timeoutMs = 10000,
): Promise<{ date: string | null; note: string; cacheHit: boolean | undefined }> {
  const cached = loadCachedBody(bodiesDir, url);
  let body: string;
  let cacheHit: boolean | undefined;
  if (cached !== null) {
    cacheHit = true;
    body = cached;
  } else {
    cacheHit = bodiesDir !== null ? false : undefined;
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
        return { date: null, note: `HTTP ${res.status}`, cacheHit };
      }

      body = await res.text();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { date: null, note: msg, cacheHit };
    } finally {
      clearTimeout(timer);
    }
  }

  const parsed = extractDateFromBody(body);
  return { ...parsed, cacheHit };
}

/**
 * Verifica/corrige a data de publicação de um único artigo. Threaded
 * `opts` carrega bodiesDir e cutoffIso; counters retornam em `_cacheHit`
 * e `_arxivPreSkipped` no resultado, acumulados por main().
 *
 * #836: opts substitui ~5 vars module-level (BODIES_CACHE_DIR,
 * CACHE_HITS, CACHE_MISSES, ARXIV_CUTOFF_ISO, ARXIV_PRESKIP_COUNT).
 */
export async function verifyDate(
  article: ArticleInput,
  opts: VerifyDateOptions = {},
): Promise<DateVerifyResult> {
  const bodiesDir = opts.bodiesDir ?? null;
  const cutoffIso = opts.cutoffIso ?? null;

  // #717 hypothesis #4: arxiv pre-skip. Quando o URL é arxiv e o YYMM do ID
  // é claramente anterior ao cutoff (1+ mês de margem), retorna data sintética
  // sem fetch. filter-date-window remove naturalmente.
  if (cutoffIso !== null) {
    const arxiv = parseArxivId(article.url);
    if (arxiv !== null && isClearlyBeforeCutoff(arxiv, cutoffIso)) {
      const sentinel = arxivIdSentinelDate(arxiv);
      const originalNorm = normalizeDate(article.date);
      return {
        url: article.url,
        original_date: article.date,
        verified_date: sentinel,
        changed: originalNorm !== sentinel,
        fetch_failed: false,
        date_unverified: false,
        note: `arxiv pre-skip: id ${arxiv.id} → ${sentinel} (cutoff ${cutoffIso}, sem fetch)`,
        _arxivPreSkipped: true,
      };
    }
  }

  const { date, note, cacheHit } = await extractPublishedDate(article.url, bodiesDir);
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
      _cacheHit: cacheHit,
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
    _cacheHit: cacheHit,
  };
}

async function main() {
  // CLI shape preservada: positional <articles.json> [out.json], + flags opcionais
  // --bodies-dir <path> (#717 hyp 1) e --cutoff-iso <YYYY-MM-DD> (#717 hyp 4).
  // #836: módulo-level vars eliminadas. Toda configuração vive em locals
  // de main() ou na VerifyDateOptions threaded por chamada.
  let bodiesDir: string | null = null;
  let cutoffIso: string | null = null;
  const positional: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--bodies-dir" && i + 1 < process.argv.length) {
      bodiesDir = process.argv[i + 1];
      i++;
    } else if (a === "--cutoff-iso" && i + 1 < process.argv.length) {
      cutoffIso = process.argv[i + 1];
      i++;
    } else {
      positional.push(a);
    }
  }
  const inputArg = positional[0];
  if (!inputArg) {
    console.error(
      "Uso: verify-dates.ts <articles.json> [out.json] [--bodies-dir <path>] [--cutoff-iso YYYY-MM-DD]",
    );
    console.error("  articles.json: array de { url, date }");
    process.exit(1);
  }

  const articles: ArticleInput[] = JSON.parse(readFileSync(inputArg, "utf8"));

  const verifyOpts: VerifyDateOptions = { bodiesDir, cutoffIso };

  // Concurrency limit: no máximo 5 fetches simultâneos para evitar rate limiting
  const CONCURRENCY = 5;
  const results: DateVerifyResult[] = [];
  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((a) => verifyDate(a, verifyOpts)))));
  }

  // #836: counters acumulados aqui em locals (era module-level antes).
  let cacheHits = 0;
  let cacheMisses = 0;
  let arxivPreSkipped = 0;
  for (const r of results) {
    if (r._cacheHit === true) cacheHits++;
    else if (r._cacheHit === false) cacheMisses++;
    if (r._arxivPreSkipped === true) arxivPreSkipped++;
  }

  const changed = results.filter((r) => r.changed).length;
  const failed = results.filter((r) => r.fetch_failed).length;
  let cacheLine = "";
  if (bodiesDir !== null) {
    const total = cacheHits + cacheMisses;
    const hitPct = total > 0 ? Math.round((cacheHits / total) * 100) : 0;
    cacheLine = ` [body-cache: ${cacheHits}/${total} hit (${hitPct}%)]`;
  }
  let arxivLine = "";
  if (cutoffIso !== null) {
    arxivLine = ` [arxiv-pre-skip: ${arxivPreSkipped} (cutoff ${cutoffIso})]`;
  }
  console.error(
    `verify-dates: ${results.length} artigos — ${changed} datas corrigidas, ${failed} fetches falhos${cacheLine}${arxivLine}`
  );

  // Strip internal _cacheHit / _arxivPreSkipped fields antes de serializar.
  const serializable = results.map(({ _cacheHit, _arxivPreSkipped, ...rest }) => rest);

  const outArg = positional[1];
  if (outArg) {
    writeFileSync(outArg, JSON.stringify(serializable, null, 2), "utf8");
    console.error(`Wrote ${serializable.length} results to ${outArg}`);
  } else {
    process.stdout.write(JSON.stringify(serializable, null, 2));
  }
}

// Detecta execução direta (npx tsx verify-dates.ts ...) de forma portável no Windows e Unix
const _isMain = process.argv[1] != null &&
  import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").replace(/^.*\//, ""));
if (_isMain) main();
