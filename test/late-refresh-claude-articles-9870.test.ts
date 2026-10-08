/**
 * test/late-refresh-claude-articles-9870.test.ts (#9870)
 *
 * O refresh tardio (#9370/#9424) lia de claude.com só o sitemap com
 * `pathPrefix: "/blog/"`. Posts novos em `/resources/articles/` (o do Claude
 * for Google Workspace, 06/10/2026) não apareciam. Medido em 08/10/2026: no
 * `claude.com/sitemap.xml` as 255 entradas de `/resources/articles/` não têm
 * `lastmod` — um feed `sitemap` com esse prefixo devolveria zero sempre. Por
 * isso o feed novo lê a página-índice (mais nova primeiro) e tira a data de
 * cada artigo da própria página.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LATE_REFRESH_FEEDS,
  extractIndexPageLinks,
  extractPublishedTime,
  filterLateArticles,
  isOfficialHost,
  selectSitemapEntries,
  type IndexPageFeed,
} from "../scripts/lib/late-refresh.ts";
import { fetchFeed } from "../scripts/late-refresh-candidates.ts";

const CUTOFF = "2026-10-05T20:00:00Z";
const NOW = new Date("2026-10-07T23:00:00Z");
const INDEX_URL = "https://claude.com/resources/articles";

const feed = LATE_REFRESH_FEEDS.find((f): f is IndexPageFeed => f.method === "index-page" && f.url === INDEX_URL);

const INDEX_HTML = `
  <a href="/resources/articles">Articles</a>
  <a href="/de/resources/articles/claude-now-works-in-google-docs-sheets-and-slides">DE</a>
  <a href="/resources/articles/claude-now-works-in-google-docs-sheets-and-slides">Google Workspace</a>
  <a href="/resources/articles/claude-now-works-in-google-docs-sheets-and-slides">dup</a>
  <a href="https://claude.com/resources/articles/claude-code-mods/">Mods</a>
  <a href="/resources/articles/category/enterprise">cat</a>
  <a href="https://evil.example.com/resources/articles/x">outro host</a>
  <a href="/resources/articles/old-post">Old</a>
`;

const page = (title: string, date: string | null) =>
  `<html><head><meta property="og:title" content="${title}"/>` +
  (date ? `<meta property="article:published_time" content="${date}"/>` : "") +
  `<meta property="og:description" content="Resumo de ${title}"/></head><body></body></html>`;

const PAGES: Record<string, string> = {
  [INDEX_URL]: INDEX_HTML,
  "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides": page(
    "Claude now works in Google Docs, Sheets and Slides",
    "2026-10-06",
  ),
  "https://claude.com/resources/articles/claude-code-mods": page("Claude Code mods", "2026-10-07T15:30:12Z"),
  "https://claude.com/resources/articles/old-post": page("Old post", "2026-09-01"),
};

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const body = PAGES[url];
  return body === undefined ? new Response("nf", { status: 404 }) : new Response(body, { status: 200 });
}) as typeof fetch;

test("#9870: feed de claude.com/resources/articles/ configurado para Anthropic", () => {
  assert.ok(feed, "feed index-page de /resources/articles/ ausente");
  assert.equal(feed.lab, "Anthropic");
  assert.equal(feed.pathPrefix, "/resources/articles/");
  assert.ok(feed.take > 0 && feed.take <= 15, "volume fixo e pequeno de GETs por gate");
  assert.equal(isOfficialHost("https://claude.com/resources/articles/post-exemplo"), true);
  // claude.com/blog redireciona para /resources/articles e o sitemap não tem mais /blog/ — feed morto removido.
  assert.ok(
    !LATE_REFRESH_FEEDS.some((f) => f.method === "sitemap" && f.url.startsWith("https://claude.com/") && f.pathPrefix === "/blog/"),
    "feed sitemap /blog/ da claude.com devolvia zero sempre",
  );
});

test("#9870: por que não sitemap — entrada sem lastmod nunca é selecionada", () => {
  const out = selectSitemapEntries(
    [{ loc: "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides", lastmod: null }],
    CUTOFF,
    "/resources/articles/",
    15,
  );
  assert.deepEqual(out, []);
});

test("extractIndexPageLinks: ordem do índice, sem dup/índice/categoria/localizado/outro host", () => {
  assert.deepEqual(extractIndexPageLinks(INDEX_HTML, INDEX_URL, "/resources/articles/", 8), [
    "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides",
    "https://claude.com/resources/articles/claude-code-mods",
    "https://claude.com/resources/articles/old-post",
  ]);
  assert.equal(extractIndexPageLinks(INDEX_HTML, INDEX_URL, "/resources/articles/", 1).length, 1);
});

test("extractPublishedTime: og article:published_time, JSON-LD datePublished, ou null", () => {
  assert.equal(extractPublishedTime(page("x", "2026-10-06")), "2026-10-06");
  assert.equal(extractPublishedTime('<script>{"datePublished":"2026-10-06T12:00:00Z"}</script>'), "2026-10-06T12:00:00Z");
  assert.equal(extractPublishedTime("<html></html>"), null);
  assert.equal(extractPublishedTime('<meta property="article:published_time" content="ontem"/>'), null);
});

test("REGRESSÃO #9870: o artigo do Google Workspace (06/10) aparece como fresco no refresh tardio", async () => {
  assert.ok(feed);
  const r = await fetchFeed(feed, CUTOFF, NOW, fakeFetch);
  assert.equal(r.error, undefined, r.error);
  const gw = r.articles.find((a) => a.url.endsWith("/claude-now-works-in-google-docs-sheets-and-slides"));
  assert.ok(gw, JSON.stringify(r.articles));
  assert.equal(gw.title, "Claude now works in Google Docs, Sheets and Slides");
  assert.equal(gw.summary, "Resumo de Claude now works in Google Docs, Sheets and Slides");
  assert.equal(gw.source, "Claude Articles");
  const { fresh } = filterLateArticles(r.articles, CUTOFF, new Set(), new Set(), NOW.toISOString());
  assert.deepEqual(
    fresh.map((a) => a.url.split("/").pop()),
    ["claude-code-mods", "claude-now-works-in-google-docs-sheets-and-slides"],
    "o antigo (01/09) fica de fora pelo corte",
  );
});

test("#9870: índice fora do ar → feed com erro (fail-soft), artigo fora do ar → sem data", async () => {
  assert.ok(feed);
  const down = (async () => new Response("x", { status: 503 })) as typeof fetch;
  const r = await fetchFeed(feed, CUTOFF, NOW, down);
  assert.deepEqual(r.articles, []);
  assert.match(r.error ?? "", /HTTP 503/);

  const onlyIndex = (async (input: string | URL | Request) =>
    String(input) === INDEX_URL ? new Response(INDEX_HTML) : new Response("x", { status: 500 })) as typeof fetch;
  const r2 = await fetchFeed(feed, CUTOFF, NOW, onlyIndex);
  assert.equal(r2.error, undefined);
  assert.ok(r2.articles.every((a) => a.published_at === null));
});
