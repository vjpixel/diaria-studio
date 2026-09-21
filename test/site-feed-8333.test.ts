/**
 * test/site-feed-8333.test.ts (#8333) — feed RSS das edições no apex.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSiteFeedXml, toRfc822, SITE_FEED_URL } from "../scripts/lib/site-feed.ts";
import type { HomeFeedEntry } from "../scripts/lib/site-home-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

function e(slug: string, date: string | null, title = slug, description = ""): HomeFeedEntry {
  return { slug, title, description, url: `https://diar.ia.br/p/${slug}`, date, image: null };
}

describe("toRfc822", () => {
  it("converte data editorial pra RFC 822 UTC", () => {
    assert.equal(toRfc822("2026-09-18"), "Fri, 18 Sep 2026 09:00:00 GMT");
  });
  it("aceita ISO completo e rejeita lixo/nulo", () => {
    assert.equal(toRfc822("2026-09-18T12:00:00Z"), "Fri, 18 Sep 2026 09:00:00 GMT");
    assert.equal(toRfc822("lixo"), null);
    assert.equal(toRfc822(null), null);
    assert.equal(toRfc822("2026-13-45"), null);
  });
});

describe("buildSiteFeedXml", () => {
  it("escapa XML e preserva a ordem recebida", () => {
    const xml = buildSiteFeedXml([e("a", "2026-09-18", "A & B <c>", 'diz "x"'), e("b", "2026-09-17")]);
    assert.match(xml, /<title>A &amp; B &lt;c&gt;<\/title>/);
    assert.match(xml, /diz &quot;x&quot;/);
    assert.ok(xml.indexOf("/p/a<") < xml.indexOf("/p/b<"));
    assert.match(xml, /<atom:link href="https:\/\/diar\.ia\.br\/feed\.xml" rel="self"/);
  });
  it("lastBuildDate vem da edição mais recente, não do relógio", () => {
    const xml = buildSiteFeedXml([e("a", "2026-09-18"), e("b", "2026-09-17")]);
    assert.match(xml, /<lastBuildDate>Fri, 18 Sep 2026 09:00:00 GMT<\/lastBuildDate>/);
    assert.equal(xml, buildSiteFeedXml([e("a", "2026-09-18"), e("b", "2026-09-17")]));
  });
  it("respeita o limite e cai pro título quando não há dek; sem data omite pubDate", () => {
    const xml = buildSiteFeedXml([e("a", null, "Titulo A"), e("b", "2026-09-17"), e("c", "2026-09-16")], 2);
    assert.equal((xml.match(/<item>/g) ?? []).length, 2);
    assert.match(xml, /<description>Titulo A<\/description>/);
    assert.equal((xml.match(/<pubDate>/g) ?? []).length, 1);
  });
});

describe("artefatos commitados", () => {
  it("feed.xml existe, é bem-formado e tem itens", () => {
    const p = resolve(PUBLIC_DIR, "feed.xml");
    assert.ok(existsSync(p), "workers/site/public/feed.xml ausente — rode scripts/gen-feed.ts");
    const xml = readFileSync(p, "utf8");
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok((xml.match(/<item>/g) ?? []).length > 0);
    assert.equal((xml.match(/<item>/g) ?? []).length, (xml.match(/<\/item>/g) ?? []).length);
  });
  it("home e /archive anunciam o feed via <link rel=alternate>", () => {
    for (const f of ["index.html", "archive/index.html"]) {
      const html = readFileSync(resolve(PUBLIC_DIR, f), "utf8");
      assert.ok(
        html.includes(`<link rel="alternate" type="application/rss+xml"`) && html.includes(`href="${SITE_FEED_URL}"`),
        `${f} sem link alternate pro feed`,
      );
    }
  });
  it("_headers fixa o content-type do feed", () => {
    assert.match(readFileSync(resolve(PUBLIC_DIR, "_headers"), "utf8"), /\/feed\.xml\s+Content-Type: application\/rss\+xml/);
  });
});
