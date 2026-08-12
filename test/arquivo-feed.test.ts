/**
 * test/arquivo-feed.test.ts (#5127)
 *
 * Cobre `workers/arquivo/src/render-feed.ts` (buildArchiveFeedXml — puro,
 * testável sem rede) e a rota `GET /feed.xml` de `workers/arquivo/src/index.ts`
 * (fetch handler, mock de `globalThis.fetch`, sem chamada externa real) —
 * mesmo padrão de `test/arquivo-render.test.ts`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildArchiveFeedXml, FEED_URL } from "../workers/arquivo/src/render-feed.ts";
import { PAGE_URL } from "../workers/arquivo/src/render-archive.ts";
import type { TitlesCacheMap } from "../workers/arquivo/src/render-archive.ts";
import type { SitemapEntry } from "../scripts/lib/fetch-sitemap.ts";
import worker from "../workers/arquivo/src/index.ts";

function entry(loc: string, lastmod: string | null): SitemapEntry {
  return { loc, lastmod };
}

describe("buildArchiveFeedXml (#5127)", () => {
  it("gera <item> com <title>, <link>, <pubDate>, <description> por edição /p/*", () => {
    const xml = buildArchiveFeedXml([
      entry("https://diar.ia.br/p/anthropic-lanca-claude", "2026-07-27"),
    ]);
    assert.match(xml, /<title>Anthropic lanca claude<\/title>/i);
    assert.match(xml, /<link>https:\/\/diar\.ia\.br\/p\/anthropic-lanca-claude<\/link>/);
    assert.match(xml, /<guid isPermaLink="true">https:\/\/diar\.ia\.br\/p\/anthropic-lanca-claude<\/guid>/);
    assert.match(xml, /<pubDate>.*2026.*<\/pubDate>/);
    assert.match(xml, /<description>.*<\/description>/);
  });

  it("usa o título real do cache quando disponível (não o slug cru)", () => {
    const cache: TitlesCacheMap = {
      "anthropic-lanca-claude": { title: "Anthropic lança o Claude Opus 5", publishDate: "2026-07-27" },
    };
    const xml = buildArchiveFeedXml(
      [entry("https://diar.ia.br/p/anthropic-lanca-claude", "2026-07-27")],
      cache,
    );
    assert.match(xml, /<title>Anthropic lança o Claude Opus 5<\/title>/);
  });

  it("exclui entradas que não são /p/* e entradas sem lastmod (mesmo filtro da HTML)", () => {
    const xml = buildArchiveFeedXml([
      entry("https://diar.ia.br/", "2026-07-27"),
      entry("https://diar.ia.br/subscribe", "2026-07-27"),
      entry("https://diar.ia.br/p/sem-data", null),
      entry("https://diar.ia.br/p/edicao-real", "2026-07-27"),
    ]);
    assert.doesNotMatch(xml, /sem-data/);
    assert.doesNotMatch(xml, /href="https:\/\/diar\.ia\.br\/subscribe"/);
    assert.match(xml, /edicao-real/);
  });

  it("ordena os <item> do mais recente pro mais antigo, independente da ordem de entrada", () => {
    const xml = buildArchiveFeedXml([
      entry("https://diar.ia.br/p/edicao-antiga", "2026-05-10"),
      entry("https://diar.ia.br/p/edicao-recente", "2026-07-15"),
      entry("https://diar.ia.br/p/edicao-media", "2026-06-01"),
    ]);
    const idxRecente = xml.indexOf("edicao-recente");
    const idxMedia = xml.indexOf("edicao-media");
    const idxAntiga = xml.indexOf("edicao-antiga");
    assert.ok(idxRecente < idxMedia && idxMedia < idxAntiga, "ordem esperada: recente, média, antiga");
  });

  it("NUNCA o corpo inteiro — description é curta (título), não HTML de edição", () => {
    const xml = buildArchiveFeedXml([entry("https://diar.ia.br/p/edicao-de-teste", "2026-07-27")]);
    // Nenhuma tag de corpo típica de HTML de post (parágrafos, divs de conteúdo).
    assert.doesNotMatch(xml, /<p>/);
    assert.doesNotMatch(xml, /<div/);
  });

  it("canal traz title, link, description, language pt-BR e atom:link self", () => {
    const xml = buildArchiveFeedXml([entry("https://diar.ia.br/p/e", "2026-07-27")]);
    assert.match(xml, /<rss version="2\.0"/);
    assert.match(xml, new RegExp(`<link>${PAGE_URL.replace(/\//g, "\\/")}</link>`));
    assert.match(xml, /<language>pt-BR<\/language>/);
    assert.match(xml, new RegExp(`<atom:link href="${FEED_URL.replace(/\//g, "\\/")}" rel="self"`));
  });

  it("limita a MAX_FEED_ITEMS (50) mesmo com mais entradas no sitemap", () => {
    const entries: SitemapEntry[] = [];
    for (let i = 0; i < 80; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String(Math.floor(i / 28) + 1).padStart(2, "0");
      entries.push(entry(`https://diar.ia.br/p/edicao-${i}`, `2026-${month}-${day}`));
    }
    const xml = buildArchiveFeedXml(entries);
    const itemCount = (xml.match(/<item>/g) ?? []).length;
    assert.equal(itemCount, 50);
  });

  it("sitemap vazio (sem edições) -> canal sem <item>, nunca lança", () => {
    assert.doesNotThrow(() => buildArchiveFeedXml([]));
    const xml = buildArchiveFeedXml([]);
    assert.doesNotMatch(xml, /<item>/);
    assert.match(xml, /<rss version="2\.0"/);
  });

  it("escapa HTML no título/link", () => {
    const cache: TitlesCacheMap = {
      "edicao-com-tags": { title: `Título com <tag> & "aspas"`, publishDate: "2026-07-27" },
    };
    const xml = buildArchiveFeedXml([entry("https://diar.ia.br/p/edicao-com-tags", "2026-07-27")], cache);
    assert.match(xml, /Título com &lt;tag&gt; &amp; &quot;aspas&quot;/);
  });
});

describe("workers/arquivo GET /feed.xml — fetch handler (#5127)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sitemap ok → 200 RSS com <item> por edição + Content-Type/Cache-Control corretos", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://diar.ia.br/p/edicao-de-teste</loc><lastmod>2026-07-27</lastmod></url>
</urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/feed.xml"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/rss\+xml/);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
    const body = await res.text();
    assert.match(body, /<link>https:\/\/diar\.ia\.br\/p\/edicao-de-teste<\/link>/);
  });

  it("HTTP não-200 do sitemap → 502, nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/feed.xml"));
    assert.equal(res.status, 502);
  });

  it("erro de rede (fetch rejeita) → 502, nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/feed.xml"));
    assert.equal(res.status, 502);
  });

  it("sitemap XML malformado → 502, nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () => new Response("<not-xml>>", { status: 200 })) as unknown as typeof fetch;
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/feed.xml"));
    assert.equal(res.status, 502);
  });
});

describe("workers/arquivo — feed declarado no head + robots.txt (#5127)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("GET / declara <link rel=alternate type=application/rss+xml> pro feed", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    const body = await res.text();
    assert.match(body, /<link rel="alternate" type="application\/rss\+xml"[^>]*href="https:\/\/arquivo\.diar\.ia\.br\/feed\.xml">/);
  });

  it("GET /robots.txt declara Feed: junto do Sitemap:", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/robots.txt não deveria depender de rede");
    }) as unknown as typeof fetch;
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/robots.txt"));
    const body = await res.text();
    assert.match(body, /Feed: https:\/\/arquivo\.diar\.ia\.br\/feed\.xml/);
  });
});
