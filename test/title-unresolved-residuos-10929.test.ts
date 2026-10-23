/**
 * #10929: resíduos do #10908 (título de stub não resolvido, "Found").
 *
 * 1. `dedup.ts` (Pass-2b) e `topic-cluster.ts` agrupavam por título: dois
 *    links sem relação com o título "Found" viravam a mesma matéria.
 * 2. Caminho `1q-fallback`/`scorer-select` sem copiar `title_unresolved`: o
 *    invariante `no-placeholder-title-highlights` deixava passar "Found" — o
 *    marcador sobrevive em outro objeto da mesma URL (approved, tmp-categorized).
 * 3. `enrich-inbox-articles.ts`: body cacheado com `<title>Found</title>` era
 *    cache hit, o "Found" virava o título e o assunto do e-mail era pulado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedup } from "../scripts/dedup.ts";
import { clusterArticles } from "../scripts/topic-cluster.ts";
import {
  collectUnresolvedTitleUrls,
  isNonDescriptiveTitle,
  isPlaceholderHighlightItemWithReserve,
} from "../scripts/lib/placeholder-title-guard.ts";
import { checkNoPlaceholderTitleHighlights } from "../scripts/lib/invariant-checks/stage-1.ts";
import { enrichArticles, isRedirectStubHtmlForArticle } from "../scripts/enrich-inbox-articles.ts";
import { bodyCacheFilename } from "../scripts/lib/url-body-cache.ts";

const STUB_A = "https://a.example.com/materia-um";
const STUB_B = "https://b.example.org/outra-coisa";

describe("#10929 item 1 — título de stub ambíguo não agrupa por título", () => {
  it("isNonDescriptiveTitle cobre placeholder e a palavra solta, não título real", () => {
    for (const t of ["Found", "moved", "Redirect", "(inbox)", "", "302 Found"]) assert.equal(isNonDescriptiveTitle(t), true, t);
    for (const t of ["Found: o modelo que acha bugs", "OpenAI lança modelo novo"]) assert.equal(isNonDescriptiveTitle(t), false, t);
  });

  it("dedup Pass-2b: dois links distintos com título 'Found' não viram cluster", () => {
    const { kept, removed } = dedup(
      [
        { url: STUB_A, title: "Found", flag: "editor_submitted" },
        { url: STUB_B, title: "Found", flag: "editor_submitted" },
      ],
      new Set(),
      0.85,
    );
    assert.deepEqual(kept.map((a) => a.url).sort(), [STUB_A, STUB_B].sort());
    assert.equal(removed.length, 0);
    for (const a of kept) assert.equal((a as { cluster_sources?: unknown[] }).cluster_sources, undefined);
  });

  it("dedup Pass-2b: título real igual continua agrupando (não regride #3920)", () => {
    const { kept } = dedup(
      [
        { url: STUB_A, title: "OpenAI lança o GPT-7 com memória longa" },
        { url: STUB_B, title: "OpenAI lança o GPT-7 com memória longa" },
      ],
      new Set(),
      0.85,
    );
    assert.equal(kept.length, 1);
  });

  it("topic-cluster: 'Found' sem summary não junta links sem relação (usa o slug, curto demais)", () => {
    const clusters = clusterArticles(
      [
        { url: "https://a.example.com/x1", title: "Found" },
        { url: "https://b.example.org/y2", title: "Found" },
      ] as never,
      0.3,
    );
    assert.ok(clusters.every((c) => c.members.length === 1), JSON.stringify(clusters));
  });
});

describe("#10929 item 2 — invariante acha o marcador fora do highlight", () => {
  const highlightSemMarcador = { bucket: "radar", url: STUB_A, article: { url: STUB_A, title: "Found" } };

  function withEdition(files: Record<string, unknown>, fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "inv-10929-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, "_internal", name), JSON.stringify(data));
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("marcador só no tmp-categorized.json (scorer-select não copiou, caminho 1q-fallback) → error", () => {
    withEdition(
      {
        "01-approved.json": { highlights: [highlightSemMarcador] },
        "tmp-categorized.json": { radar: [{ url: STUB_A, title: "Found", title_unresolved: "redirect_stub" }] },
      },
      (dir) => {
        const v = checkNoPlaceholderTitleHighlights(dir);
        assert.equal(v.length, 1);
        assert.equal(v[0].severity, "error");
      },
    );
  });

  it("marcador num runners_up da mesma URL dentro do approved → error", () => {
    withEdition(
      {
        "01-approved.json": {
          highlights: [highlightSemMarcador],
          runners_up: [{ url: STUB_A, article: { url: STUB_A, title: "Found", title_unresolved: "redirect_stub" } }],
        },
      },
      (dir) => assert.equal(checkNoPlaceholderTitleHighlights(dir).length, 1),
    );
  });

  it("sem marcador em lugar nenhum, 'Found' segue título real (#10881 item 4)", () => {
    withEdition({ "01-approved.json": { highlights: [highlightSemMarcador] } }, (dir) =>
      assert.equal(checkNoPlaceholderTitleHighlights(dir).length, 0),
    );
  });

  it("título corrigido pelo editor não é barrado pelo marcador da mesma URL", () => {
    const urls = collectUnresolvedTitleUrls({ radar: [{ url: STUB_A, title_unresolved: "redirect_stub" }] });
    assert.ok(urls.has(STUB_A));
    assert.equal(
      isPlaceholderHighlightItemWithReserve({ url: STUB_A, article: { url: STUB_A, title: "Título real do editor" } }, urls),
      false,
    );
  });
});

describe("#10929 item 3 — enrich-inbox descarta cache 'Found' e cai no assunto do e-mail", () => {
  const STUB_HTML = "<html><head><title>Found</title></head><body>Object moved to <a href='/x'>here</a></body></html>";
  const art = {
    url: "https://anti-bot.example.com/materia",
    title: "(inbox)",
    flag: "editor_submitted",
    submitted_subject: "Fwd: Modelo novo da DeepSeek bate o GPT",
  };

  it("isRedirectStubHtmlForArticle: palavra solta só conta como stub no inbox", () => {
    assert.equal(isRedirectStubHtmlForArticle(STUB_HTML, art), true);
    assert.equal(isRedirectStubHtmlForArticle(STUB_HTML, { url: art.url, title: "x", source: "rss" }), false);
  });

  it("cache 'Found' vira cache-miss; refetch falho → título do assunto do e-mail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-10929-"));
    try {
      writeFileSync(join(dir, bodyCacheFilename(art.url)), STUB_HTML, "utf8");
      const { articles, stats, outcomes } = await enrichArticles([art], async () => null, { bodiesDir: dir });
      assert.equal(stats.cache_hits, 0);
      assert.equal(stats.cache_misses, 1);
      assert.equal(articles[0].title, "Modelo novo da DeepSeek bate o GPT");
      assert.equal(outcomes[0].reason, "title_from_submitted_subject");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refetch que ainda devolve a página 'Found' também cai no assunto do e-mail", async () => {
    const { articles } = await enrichArticles([art], async () => STUB_HTML);
    assert.equal(articles[0].title, "Modelo novo da DeepSeek bate o GPT");
  });
});
