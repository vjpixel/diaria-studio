/**
 * test/site-home-dek-bullets-13324.test.ts (#13324)
 *
 * Linha fina da home em bullets: D2 e D3 saem como lista, um título por
 * item, lidos da forma estruturada (`<meta name="dek-item">`) que a página
 * da edição grava a partir dos `<h2 id="d2|d3">` — nunca da string "D2 | D3"
 * separada por `|` (um título pode conter `|`). Página sem a meta cai no
 * `<p>` de antes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEK_ITEM_META_NAME,
  backfillDekItems,
  extractSecondaryDestaqueTitles,
  renderDekItemMetas,
} from "../scripts/lib/site-destaque-anchors.ts";
import {
  HOME_DEK_ITEM_META_NAME,
  buildHomeFeed,
  buildIndexHtml,
  extractPageDek,
  extractPageDekItems,
  renderDek,
  type HomeFeedEntry,
} from "../scripts/lib/site-home-page.ts";
import { renderHeadlineInner } from "../scripts/lib/newsletter-render-html.ts";
import { buildEditionArchivePost } from "../scripts/lib/edition-site-page.ts";
import { buildArchivePageHtml } from "../scripts/lib/site-archive-pages.ts";
import { backfillArchivePageOnDisk } from "../scripts/lib/site-archive-page-backfill.ts";
import { runDekItemsBackfill } from "../scripts/backfill-archive-page-links-seo.ts";

const ROOT = join(import.meta.dirname, "..");

/** Corpo como o render real da newsletter sai: uma manchete por título. */
function bodyWithHeadlines(titles: string[]): string {
  const rows = titles.map(
    (t, i) => `<tr><td>${renderHeadlineInner(t, `https://fonte.example/${i + 1}`)}<p>Texto ${i + 1}.</p></td></tr>`,
  );
  return `<html><head></head><body><table>${rows.join("")}</table></body></html>`;
}

function pageFor(titles: string[], subtitle: string): string {
  const built = buildEditionArchivePost({
    html: bodyWithHeadlines(titles),
    postUrl: "https://diar.ia.br/p/edicao-teste-13324",
    title: titles[0],
    subtitle,
    publishedAtIso: "2026-11-10T09:00:00.000Z",
  });
  assert.ok(built.ok);
  return buildArchivePageHtml(built.post);
}

describe("#13324 — a página da edição grava D2/D3 estruturados", () => {
  it("3 destaques dão 2 dek-item, na ordem, e a dek antiga continua", () => {
    const page = pageFor(["D1 título", "D2 título", "D3 título"], "D2 título | D3 título");
    assert.deepEqual(extractPageDekItems(page), ["D2 título", "D3 título"]);
    assert.equal(extractPageDek(page), "D2 título | D3 título");
  });

  it("2 destaques dão 1 dek-item", () => {
    const page = pageFor(["D1 título", "D2 título"], "D2 título");
    assert.deepEqual(extractPageDekItems(page), ["D2 título"]);
  });

  it("só D1: sem dek-item", () => {
    const page = pageFor(["D1 título"], "");
    assert.deepEqual(extractPageDekItems(page), []);
  });

  it("título com `|` não quebra em dois bullets", () => {
    const page = pageFor(["D1", "Gemini | Claude: quem ganha", "D3 & cia <3"], "Gemini | Claude: quem ganha | D3 & cia <3");
    assert.deepEqual(extractPageDekItems(page), ["Gemini | Claude: quem ganha", "D3 & cia <3"]);
  });
});

describe("#13324 — extractSecondaryDestaqueTitles", () => {
  it("quem grava e quem lê usam o mesmo nome de meta", () => {
    assert.equal(HOME_DEK_ITEM_META_NAME, DEK_ITEM_META_NAME);
  });

  it("ignora a âncora no próprio <a> (render antigo, sem h2)", () => {
    const html = '<a id="d1" class="headline">A</a><a id="d2" class="headline">B</a>';
    assert.deepEqual(extractSecondaryDestaqueTitles(html), []);
  });

  it("D3 sem D2 não vira bullet solto", () => {
    assert.deepEqual(extractSecondaryDestaqueTitles('<h2 id="d3">Só o D3</h2>'), []);
  });

  it("tira tag interna e decodifica entidade", () => {
    assert.deepEqual(extractSecondaryDestaqueTitles('<h2 id="d2" style="x"><span>A &amp; B</span></h2>'), ["A & B"]);
  });
});

describe("#13324 — backfillDekItems (páginas já publicadas)", () => {
  const page = `<html><head><title>T</title><meta name="dek" content="B | C"></head><body><h2 id="d1">A</h2><h2 id="d2">B</h2><h2 id="d3">C</h2></body></html>`;

  it("grava logo depois da dek e é idempotente", () => {
    const first = backfillDekItems(page);
    assert.equal(first.changed, true);
    assert.ok(first.html.includes(`<meta name="dek" content="B | C">${renderDekItemMetas(["B", "C"])}`));
    const second = backfillDekItems(first.html);
    assert.equal(second.changed, false);
    assert.equal(second.html, first.html);
  });

  it("página sem h2 do D2 fica igual", () => {
    const html = "<html><head><title>T</title></head><body><p>x</p></body></html>";
    assert.deepEqual(backfillDekItems(html), { html, changed: false });
  });

  it("entra no backfill geral das páginas", () => {
    const r = backfillArchivePageOnDisk(page, { slug: "x" });
    assert.equal(r.addedDekItems, true);
    assert.deepEqual(extractPageDekItems(r.html), ["B", "C"]);
  });

  it("--dek-items-only percorre o diretório e só grava o que mudou", () => {
    const pages: Record<string, string> = { a: page, b: backfillDekItems(page).html };
    const written: string[] = [];
    const r = runDekItemsBackfill("/x", {
      listSlugs: () => Object.keys(pages),
      readPage: (p) => pages[p.split("/").at(-2)!],
      writePage: (p) => written.push(p),
    });
    assert.deepEqual(r, { scanned: 2, changed: 1 });
    assert.equal(written.length, 1);
  });
});

describe("#13324 — a home renderiza bullets", () => {
  const entry = (over: Partial<HomeFeedEntry>): HomeFeedEntry => ({
    slug: "s",
    title: "D1",
    description: "D2 | D3",
    url: "https://diar.ia.br/p/s",
    date: "2026-11-10",
    image: null,
    ...over,
  });

  it("com deks: lista; sem: o <p> de antes", () => {
    assert.equal(renderDek(entry({ deks: ["D2", "D3"] }), "feature"), '<ul class="feature-deks"><li>D2</li><li>D3</li></ul>');
    assert.equal(renderDek(entry({ deks: ["D2"] }), "archive"), '<ul class="archive-deks"><li>D2</li></ul>');
    assert.equal(renderDek(entry({}), "feature"), '<p class="feature-dek">D2 | D3</p>');
    assert.equal(renderDek(entry({ deks: [] }), "archive"), '<p class="archive-dek">D2 | D3</p>');
  });

  it("buildHomeFeed lê as dek-item; página sem a meta não ganha o campo", () => {
    const withItems = `<html><head><title>Novo</title><meta name="dek" content="B | C">${renderDekItemMetas(["B", "C"])}</head><body></body></html>`;
    const old = `<html><head><title>Antigo</title><meta name="dek" content="X | Y"></head><body></body></html>`;
    const sitemap = `<urlset><url><loc>https://diar.ia.br/p/novo</loc><lastmod>2026-11-10</lastmod></url><url><loc>https://diar.ia.br/p/antigo</loc><lastmod>2026-11-09</lastmod></url></urlset>`;
    const feed = buildHomeFeed(sitemap, (s) => (s === "novo" ? withItems : old), 5, { todayBrt: "2026-11-16" });
    assert.deepEqual(feed[0].deks, ["B", "C"]);
    assert.equal("deks" in feed[1], false);
  });

  it("snapshot do card em destaque", () => {
    const html = buildIndexHtml({ feature: entry({ deks: ["MEC proíbe IA", "ChatGPT Wallet"] }), archive: [] });
    const m = html.match(/<a class="feature-title-link"[\s\S]*?<div class="feature-actions">/);
    assert.ok(m);
    assert.equal(
      m[0],
      `<a class="feature-title-link" href="https://diar.ia.br/p/s">
        <h2 class="feature-title">D1</h2>
      </a>
      <ul class="feature-deks"><li>MEC proíbe IA</li><li>ChatGPT Wallet</li></ul>
      <div class="feature-actions">`,
    );
    // traço em tinta neutra, nunca teal (#13324 item 5; teal só na .rule)
    assert.match(html, /\.feature-deks li::before, \.archive-deks li::before \{ content: "\\2013";[^}]*color: var\(--ink-faint\)/);
  });
});

describe("#13324 — acervo real", () => {
  const pagesDir = join(ROOT, "workers", "site", "public", "p");

  it("toda página com <h2 id=d2> já tem as dek-item (backfill aplicado)", () => {
    const faltando = readdirSync(pagesDir)
      .map((s) => join(pagesDir, s, "index.html"))
      .filter((p) => existsSync(p))
      .filter((p) => backfillDekItems(readFileSync(p, "utf8")).changed);
    assert.deepEqual(faltando, []);
  });

  it("a home committed mostra o destaque com bullets", () => {
    const home = readFileSync(join(ROOT, "workers", "site", "public", "index.html"), "utf8");
    assert.match(home, /<ul class="feature-deks"><li>/);
  });
});
