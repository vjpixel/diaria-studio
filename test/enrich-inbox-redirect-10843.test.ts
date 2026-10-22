/**
 * #10843: `fetchHtml` (undici `request`) não seguia redirect — a resposta 3xx
 * era parseada e o `<title>` do stub ("Document moved", "301 Moved
 * Permanently") virava o título do artigo. 39 artigos em 261019–261022; um
 * virou destaque (Voxtral 3, 261022). Servidor HTTP local, sem rede real.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchHtml,
  extractMetadata,
  extractMetaRefreshUrl,
  isRedirectStubHtml,
  mergeMetadata,
  needsEnrichment,
  enrichArticles,
  MAX_REDIRECTS,
} from "../scripts/enrich-inbox-articles.ts";
import {
  isPlaceholderHighlightTitle,
  isRedirectStubTitle,
} from "../scripts/lib/placeholder-title-guard.ts";
import { bodyCacheFilename } from "../scripts/lib/url-body-cache.ts";

const STUB_301 =
  '<html><head><title>301 Moved Permanently</title></head><body><h1>Moved Permanently</h1></body></html>';
const STUB_DOC_MOVED =
  '<html><head><title>Document moved</title></head><body>Object moved to <a href="/final">here</a></body></html>';
const FINAL_PAGE =
  '<html><head><meta property="og:title" content="Voxtral 3 chega com transcrição em tempo real">' +
  '<meta property="og:description" content="A Mistral lançou o Voxtral 3."></head><body>ok</body></html>';
const META_REFRESH_PAGE =
  '<html><head><title>Redirecting...</title><meta http-equiv="refresh" content="0; url=/final"></head><body></body></html>';

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/final") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FINAL_PAGE);
    } else if (path === "/news/voxtral-3") {
      res.writeHead(301, { location: "/news/voxtral-3/", "content-type": "text/html" });
      res.end(STUB_DOC_MOVED);
    } else if (path === "/news/voxtral-3/") {
      res.writeHead(302, { location: `${base}/final`, "content-type": "text/html" });
      res.end(STUB_301);
    } else if (path === "/no-location") {
      res.writeHead(301, { "content-type": "text/html" });
      res.end(STUB_301);
    } else if (path.startsWith("/loop")) {
      const n = Number(path.slice("/loop".length) || "0");
      res.writeHead(302, { location: `/loop${n + 1}` });
      res.end(STUB_DOC_MOVED);
    } else if (path === "/meta-refresh") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(META_REFRESH_PAGE);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("fetchHtml segue redirects (#10843 A)", () => {
  it("301 → 302 → página final: devolve o HTML final, nunca o stub", async () => {
    const html = await fetchHtml(`${base}/news/voxtral-3`, 5000, "test");
    assert.ok(html, "deveria devolver o body final");
    assert.equal(extractMetadata(html).title, "Voxtral 3 chega com transcrição em tempo real");
  });

  it("3xx sem Location → null (não parseia o stub)", async () => {
    assert.equal(await fetchHtml(`${base}/no-location`, 5000, "test"), null);
  });

  it("loop de redirect além do teto → null", async () => {
    assert.equal(await fetchHtml(`${base}/loop0`, 5000, "test"), null);
    assert.equal(MAX_REDIRECTS, 5);
  });

  it("meta refresh de stub 'Redirecting...' é seguido (#10843 C)", async () => {
    const html = await fetchHtml(`${base}/meta-refresh`, 5000, "test");
    assert.ok(html);
    assert.equal(extractMetadata(html).title, "Voxtral 3 chega com transcrição em tempo real");
  });

  it("enrichArticles com o fetcher real: newsletter_extracted ganha o og:title da página final", async () => {
    const { articles } = await enrichArticles(
      [{ url: `${base}/news/voxtral-3`, title: '(newsletter:"The Batch")', flag: "newsletter_extracted" }],
      (url) => fetchHtml(url, 5000, "test"),
    );
    assert.equal(articles[0].title, "Voxtral 3 chega com transcrição em tempo real");
  });
});

describe("título de stub de redirect é placeholder (#10843 B)", () => {
  const stubs = [
    "Document moved",
    "301 Moved Permanently",
    "302 Found",
    "Moved Permanently",
    "Object moved",
    "Redirecting...",
    "Redirecting…",
    "Redirecting",
    "307 Temporary Redirect",
  ];
  for (const t of stubs) {
    it(`"${t}" é stub e placeholder`, () => {
      assert.equal(isRedirectStubTitle(t), true);
      assert.equal(isPlaceholderHighlightTitle(t), true);
    });
  }

  for (const t of [
    "Found: o modelo que a OpenAI escondeu",
    "Redirecting the AI race to Europe",
    "Microsoft moved its AI team to London",
    "Voxtral 3",
  ]) {
    it(`"${t}" continua título real`, () => {
      assert.equal(isRedirectStubTitle(t), false);
      assert.equal(isPlaceholderHighlightTitle(t), false);
    });
  }

  it("extractMetadata descarta <title> de stub", () => {
    assert.equal(extractMetadata(STUB_DOC_MOVED).title, null);
    assert.equal(extractMetadata(STUB_301).title, null);
    assert.equal(isRedirectStubHtml(STUB_DOC_MOVED), true);
    assert.equal(isRedirectStubHtml(FINAL_PAGE), false);
  });

  it("artigo já com título 'Document moved' volta a precisar de enrichment e aceita o título real", () => {
    const art = { url: "https://mistral.ai/news/voxtral-3", title: "Document moved", summary: "x", flag: "newsletter_extracted" };
    assert.equal(needsEnrichment(art), true);
    const merged = mergeMetadata(art, { title: "Voxtral 3", summary: null });
    assert.equal(merged.article.title, "Voxtral 3");
  });

  it("body cacheado que é stub conta como cache-miss e cai no fetch de rede", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-10843-"));
    try {
      const url = "https://mistral.ai/news/voxtral-3";
      writeFileSync(join(dir, bodyCacheFilename(url)), STUB_DOC_MOVED, "utf8");
      const { articles, stats } = await enrichArticles(
        [{ url, title: '(newsletter:"The Batch")', flag: "newsletter_extracted" }],
        async () => FINAL_PAGE,
        { bodiesDir: dir },
      );
      assert.equal(stats.cache_hits, 0);
      assert.equal(stats.cache_misses, 1);
      assert.equal(articles[0].title, "Voxtral 3 chega com transcrição em tempo real");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractMetaRefreshUrl (#10843 C)", () => {
  it("resolve url relativa", () => {
    assert.equal(extractMetaRefreshUrl(META_REFRESH_PAGE, "https://blog.google/x"), "https://blog.google/final");
  });
  it("ignora refresh periódico sem url ou com delay longo", () => {
    assert.equal(extractMetaRefreshUrl('<meta http-equiv="refresh" content="300">', "https://a.com/"), null);
    assert.equal(
      extractMetaRefreshUrl('<meta http-equiv="refresh" content="600; url=https://a.com/b">', "https://a.com/"),
      null,
    );
  });
  it("aceita content antes de http-equiv", () => {
    assert.equal(
      extractMetaRefreshUrl("<meta content='0;URL=https://b.com/c' http-equiv='refresh'>", "https://a.com/"),
      "https://b.com/c",
    );
  });
});
