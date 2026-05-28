/**
 * extract-date.ts (#1554 — P2 lift date extraction)
 *
 * Pure function that extracts a publication date from an HTML body using
 * 7 strategies ordered by confidence (JSON-LD → og:article:published_time →
 * meta pubdate → citation_date → time[itemprop=datePublished] → JSON embedded
 * datePublished → time:in-article-context → first <time>).
 *
 * Extracted from `verify-dates.ts:extractDateFromBody` (#836) into a shared
 * lib so `verify-accessibility.ts` can populate `published_date` on every
 * successful GET, eliminating ~3-4min of duplicate fetches in stage 1p1.
 *
 * Tests: see `test/extract-date.test.ts` (was bundled in verify-dates tests).
 */

/**
 * Normalize a raw date string to YYYY-MM-DD in Brazil timezone (UTC-3).
 * Returns null if the input cannot be parsed.
 */
export function normalizeDate(raw: string): string | null {
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
 * Pure: extracts the best possible date from an HTML body using 7 strategies
 * in order of confidence. Sem I/O, sem state.
 *
 * Returns `{ date: null, note: "no-date-found" }` when nothing matches.
 */
export function extractDateFromBody(body: string): { date: string | null; note: string } {
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
