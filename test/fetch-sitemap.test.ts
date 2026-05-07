import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSitemap, filterByWindow } from "../scripts/lib/fetch-sitemap.ts";
import { MAX_ARTICLES_PER_SOURCE } from "../scripts/lib/article-cap.ts";

const SAMPLE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/articles/recent-1</loc>
    <lastmod>2026-05-04T12:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://example.com/articles/recent-2</loc>
    <lastmod>2026-05-05T08:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://example.com/articles/recent-3</loc>
    <lastmod>2026-05-06T18:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://example.com/articles/old-1</loc>
    <lastmod>2025-12-01T00:00:00Z</lastmod>
  </url>
  <url>
    <loc>https://example.com/articles/old-2</loc>
    <lastmod>2025-11-15T00:00:00Z</lastmod>
  </url>
</urlset>`;

describe("parseSitemap", () => {
  it("parseia 5 entries com loc + lastmod", () => {
    const entries = parseSitemap(SAMPLE_SITEMAP);
    assert.equal(entries.length, 5);
    assert.equal(entries[0].loc, "https://example.com/articles/recent-1");
    assert.equal(entries[0].lastmod, "2026-05-04T12:00:00Z");
    assert.equal(entries[4].loc, "https://example.com/articles/old-2");
  });

  it("entries sem <lastmod> ficam com lastmod: null", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/no-date</loc></url>
</urlset>`;
    const entries = parseSitemap(xml);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].lastmod, null);
  });

  it("lança erro em XML malformado", () => {
    assert.throws(() => parseSitemap("<not-xml>>"), /sitemap/i);
  });

  it("lança erro se não tem <urlset>", () => {
    const xml = `<?xml version="1.0"?><other-root><url><loc>x</loc></url></other-root>`;
    assert.throws(() => parseSitemap(xml), /urlset/);
  });

  it("aceita um único <url> (não array)", () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x.com/a</loc><lastmod>2026-05-01</lastmod></url></urlset>`;
    const entries = parseSitemap(xml);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].loc, "https://x.com/a");
  });
});

describe("filterByWindow", () => {
  it("mantém só entries dentro da janela de 4 dias (anchor 2026-05-06)", () => {
    const entries = parseSitemap(SAMPLE_SITEMAP);
    const now = new Date("2026-05-06T18:00:00Z");
    const inWindow = filterByWindow(entries, 4, now);
    // recent-1 (2026-05-04 12:00) dentro de 4 dias.
    // recent-2 (2026-05-05 08:00) dentro.
    // recent-3 (2026-05-06 18:00) dentro.
    // old-1, old-2 fora.
    assert.equal(inWindow.length, 3);
    assert.deepEqual(
      inWindow.map((e) => e.loc),
      [
        "https://example.com/articles/recent-1",
        "https://example.com/articles/recent-2",
        "https://example.com/articles/recent-3",
      ],
    );
  });

  it("descarta entries com lastmod null", () => {
    const entries = [
      { loc: "https://x.com/a", lastmod: null },
      { loc: "https://x.com/b", lastmod: "2026-05-05T00:00:00Z" },
    ];
    const result = filterByWindow(entries, 30, new Date("2026-05-06T00:00:00Z"));
    assert.equal(result.length, 1);
    assert.equal(result[0].loc, "https://x.com/b");
  });

  it("descarta entries com lastmod inválido (NaN)", () => {
    const entries = [
      { loc: "https://x.com/a", lastmod: "not-a-date" },
      { loc: "https://x.com/b", lastmod: "2026-05-05T00:00:00Z" },
    ];
    const result = filterByWindow(entries, 30, new Date("2026-05-06T00:00:00Z"));
    assert.equal(result.length, 1);
    assert.equal(result[0].loc, "https://x.com/b");
  });
});

describe("fetchSitemapEntries + cap integração (#891 / #945)", () => {
  /**
   * Constrói sitemap.xml com N entries, todas com lastmod recente o
   * suficiente pra passar o filterByWindow default. Entry N tem hh=N%24.
   */
  function buildSitemapXml(entryCount: number, baseDate = "2026-05-07"): string {
    const urls = Array.from({ length: entryCount }, (_, i) => {
      const hh = String(i % 24).padStart(2, "0");
      return `<url>
        <loc>https://example.com/articles/${i}</loc>
        <lastmod>${baseDate}T${hh}:00:00Z</lastmod>
      </url>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls}
</urlset>`;
  }

  /**
   * Stuba globalThis.fetch — sitemap inicial responde com XML do sitemap;
   * fetches subsequentes (enrichEntry) também recebem o mesmo body trivial,
   * suficiente pra completar o pipeline. Retorna restore.
   */
  function stubFetch(sitemapXml: string): () => void {
    const orig = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async (url: unknown) => {
      callCount++;
      // Primeira chamada é o sitemap em si
      if (callCount === 1 || String(url).endsWith(".xml")) {
        return new Response(sitemapXml, {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }
      // Enrich requests (cada entry) — HTML mínimo, só pra não falhar.
      return new Response(
        "<html><head><title>Test</title></head><body>x</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }) as typeof globalThis.fetch;
    return () => { globalThis.fetch = orig; };
  }

  it("SitemapFetchResult inclui truncated_by_cap quando sitemap > cap", async () => {
    const { fetchSitemapEntries } = await import("../scripts/lib/fetch-sitemap.ts");
    const TOTAL = 40;
    const restore = stubFetch(buildSitemapXml(TOTAL));
    try {
      const result = await fetchSitemapEntries({
        url: "https://example.com/sitemap.xml",
        sourceName: "test-large-sitemap",
        days: 365,
        now: new Date("2026-05-08T00:00:00Z"),
      });
      assert.equal(result.articles.length, MAX_ARTICLES_PER_SOURCE, "cap aplica");
      assert.equal(result.truncated_by_cap, TOTAL - MAX_ARTICLES_PER_SOURCE, "entries cortadas = total - cap");
      // Mesmo invariante que fetchRss: articles ordenados por published_at desc (#945 nit C).
      assert.match(result.articles[0].published_at ?? "", /T23:00:00/, "primeira article = lastmod hour 23");
    } finally {
      restore();
    }
  });

  it("SitemapFetchResult NÃO inclui truncated_by_cap quando <= cap", async () => {
    const { fetchSitemapEntries } = await import("../scripts/lib/fetch-sitemap.ts");
    const TOTAL = 15;
    const restore = stubFetch(buildSitemapXml(TOTAL));
    try {
      const result = await fetchSitemapEntries({
        url: "https://example.com/sitemap.xml",
        sourceName: "test-small-sitemap",
        days: 365,
        now: new Date("2026-05-08T00:00:00Z"),
      });
      assert.equal(result.articles.length, TOTAL);
      assert.equal(result.truncated_by_cap, undefined);
    } finally {
      restore();
    }
  });
});
