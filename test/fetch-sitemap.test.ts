import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSitemap, filterByWindow } from "../scripts/lib/fetch-sitemap.ts";

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
