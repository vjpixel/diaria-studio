/**
 * test/discover-news-requisitos-8390.test.ts (#8390)
 *
 * REGRESSÃO dos pré-requisitos de Google Discover/News no apex próprio. Os
 * três defeitos que este arquivo trava são o estado MEDIDO em 18/09/2026:
 *
 * 1. `max-image-preview:large` ausente nas 270 páginas de `/p/{slug}` — sem
 *    ele o Discover não serve o card de imagem grande.
 * 2. `image` ausente no JSON-LD `NewsArticle` que #8336/#8359 já escreviam.
 * 3. `xmlns:news` + `<news:news>` ausentes do `sitemap.xml` — REGRESSÃO do
 *    cutover do apex (26/08, #467): o sitemap da Beehiiv emitia esse markup
 *    por nós e ninguém notou a perda ao assumir a superfície.
 *
 * Os dois LADOS da janela de 48h são exercidos de propósito (dentro → bloco
 * presente; fora → bloco ausente): um teste que só checasse a presença
 * passaria com uma implementação que nunca expira, que é o defeito mais
 * provável de reintroduzir.
 *
 * A data editorial também é exercida pelos dois lados: um post cujo
 * `publish_date` cru é RECENTE mas cuja data editorial (override de
 * `beehiiv-publish-date-overrides.json`, #4796) é ANTIGA não pode entrar no
 * bloco news — é exatamente a forma das 6 edições importadas em bloco pra
 * Beehiiv em 04/09/2025.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArchivePost,
  ARCHIVE_ROBOTS_META,
  NEWS_SITEMAP_WINDOW_MS,
  addSitemapEntry,
  buildArchiveNewsArticleJsonLd,
  buildArchivePageHtml,
  buildSitemapXml,
  newsEntryForPost,
  pruneExpiredNewsBlocks,
  sitemapEntriesForPosts,
  sitemapEntryFromPost,
} from "../scripts/lib/site-archive-pages.ts";
import { parseSitemapPageEntries } from "../scripts/backfill-archive-page-links-seo.ts";
import { parseSitemap } from "../scripts/lib/fetch-sitemap.ts";
import { COVER_IMAGE_WIDTH } from "../scripts/lib/shared/cover-image.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_DIR = join(ROOT, "workers", "site", "public", "p");

const NOW = Date.parse("2026-09-19T12:00:00Z");
/** 1h atrás — dentro da janela de 48h. */
const FRESH_EPOCH_S = Math.floor((NOW - 60 * 60 * 1000) / 1000);
/** 72h atrás — fora da janela. */
const STALE_EPOCH_S = Math.floor((NOW - 72 * 60 * 60 * 1000) / 1000);

function makePost(overrides: Partial<ArchivePost> = {}): ArchivePost {
  return {
    slug: "edicao-de-teste",
    title: "Edição de teste",
    subtitle: "Subtítulo",
    status: "confirmed",
    web_url: "https://diar.ia.br/p/edicao-de-teste",
    publish_date: FRESH_EPOCH_S,
    thumbnail_url: "https://eia.diar.ia.br/img/img-260919-04-d1-2x1-abc.jpg",
    content: { free: { web: "<html><head></head><body><p>corpo</p></body></html>" } },
    ...overrides,
  } as ArchivePost;
}

describe("#8390 item 1 — max-image-preview:large", () => {
  it("buildArchivePageHtml injeta a meta robots no head", () => {
    const html = buildArchivePageHtml(makePost());
    assert.ok(html.includes(ARCHIVE_ROBOTS_META), "página gerada sem <meta name=\"robots\">");
    assert.match(html, /<meta name="robots" content="max-image-preview:large">/);
    // Uma única vez — dupla injeção seria tag concorrente no mesmo head.
    assert.equal(html.match(/name="robots"/g)?.length, 1);
  });

  it("as 270 páginas do acervo em disco declaram a meta", () => {
    const slugs = readdirSync(PAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    assert.ok(slugs.length >= 270, `esperava ≥270 páginas, achei ${slugs.length}`);
    const semRobots = slugs.filter(
      (slug) => !readFileSync(join(PAGES_DIR, slug, "index.html"), "utf8").includes(ARCHIVE_ROBOTS_META),
    );
    assert.deepEqual(semRobots, [], `${semRobots.length} página(s) sem max-image-preview:large`);
  });
});

describe("#8390 item 2 — image no JSON-LD NewsArticle", () => {
  it("emite image 1600×800 quando o post tem capa", () => {
    const node = JSON.parse(
      buildArchiveNewsArticleJsonLd(makePost())!.replace(/^<script[^>]*>|<\/script>$/g, ""),
    );
    assert.equal(node["@type"], "NewsArticle");
    assert.equal(node.image.url, "https://eia.diar.ia.br/img/img-260919-04-d1-2x1-abc.jpg");
    assert.equal(node.image.width, COVER_IMAGE_WIDTH);
    assert.ok(node.image.width >= 1200, "Discover exige largura ≥1200px");
    // Os campos que o #8336/#8359 já garantiam seguem lá.
    for (const campo of ["headline", "datePublished", "dateModified", "author", "publisher"]) {
      assert.ok(node[campo] !== undefined, `campo ${campo} sumiu do NewsArticle`);
    }
  });

  it("omite image (sem inventar URL) quando o post não tem capa", () => {
    const node = JSON.parse(
      buildArchiveNewsArticleJsonLd(makePost({ thumbnail_url: null }))!.replace(/^<script[^>]*>|<\/script>$/g, ""),
    );
    assert.equal(node.image, undefined);
  });

  it("as 270 páginas do acervo em disco têm image no NewsArticle", () => {
    const slugs = readdirSync(PAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const semImage = slugs.filter((slug) => {
      const html = readFileSync(join(PAGES_DIR, slug, "index.html"), "utf8");
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (!m) return true;
      const node = JSON.parse(m[1]) as Record<string, { url?: string }>;
      return !node.image?.url;
    });
    assert.deepEqual(semImage, [], `${semImage.length} página(s) com NewsArticle sem image`);
  });
});

describe("#8390 item 3 — <news:news> no sitemap, com janela de 48h", () => {
  it("URL DENTRO da janela ganha o bloco news e o namespace", () => {
    const xml = buildSitemapXml(sitemapEntriesForPosts([makePost()], { now: NOW }));
    assert.match(xml, /<urlset[^>]*xmlns:news="http:\/\/www\.google\.com\/schemas\/sitemap-news\/0\.9"/);
    assert.match(xml, /<news:news>/);
    assert.match(xml, /<news:name>diar\.ia\.br<\/news:name>/);
    assert.match(xml, /<news:language>pt<\/news:language>/);
    assert.match(xml, /<news:title>Edição de teste<\/news:title>/);
    assert.match(xml, /<news:publication_date>2026-09-19T11:00:00\.000Z<\/news:publication_date>/);
  });

  it("URL FORA da janela (72h) não ganha bloco news nem namespace", () => {
    const post = makePost({ slug: "edicao-velha", publish_date: STALE_EPOCH_S });
    const entries = sitemapEntriesForPosts([post], { now: NOW });
    assert.equal(entries[0].news, undefined);
    const xml = buildSitemapXml(entries);
    assert.ok(!xml.includes("<news:news>"), "bloco news emitido pra URL de 72h atrás");
    assert.ok(!xml.includes("xmlns:news"), "namespace declarado sem nenhum bloco news");
    // A URL continua no sitemap normal — expirar do bloco news nunca é
    // despublicar a página.
    assert.match(xml, /<loc>https:\/\/diar\.ia\.br\/p\/edicao-velha<\/loc>/);
  });

  it("a fronteira é exatamente 48h", () => {
    const naBorda = Math.floor((NOW - NEWS_SITEMAP_WINDOW_MS) / 1000);
    assert.equal(newsEntryForPost(makePost({ publish_date: naBorda }), NOW), undefined);
    assert.ok(newsEntryForPost(makePost({ publish_date: naBorda + 60 }), NOW));
  });

  it("usa a data EDITORIAL: override antigo vence publish_date recente (importadas de 04/09/2025)", () => {
    // Slug real coberto por beehiiv-publish-date-overrides.json (#4796): o
    // `publish_date` cru é o dia do import em bloco, não o envio real.
    const overrides = JSON.parse(
      readFileSync(join(ROOT, "scripts", "lib", "beehiiv-publish-date-overrides.json"), "utf8"),
    ) as { overrides: Record<string, string> };
    const [slugImportado, dataEditorial] = Object.entries(overrides.overrides)[0];
    assert.ok(slugImportado, "nenhum override cadastrado — o caso das importadas não está coberto");

    // `publish_date` cru = AGORA (a armadilha: o import em bloco carimbou a
    // data da importação). Sem honrar o override, a edição entraria no bloco
    // news como se fosse notícia de hoje.
    const post = makePost({ slug: slugImportado, publish_date: Math.floor(NOW / 1000) });
    assert.equal(
      newsEntryForPost(post, NOW),
      undefined,
      `edição importada (${slugImportado}, editorial ${dataEditorial}) entrou no bloco news pela data do import`,
    );

    // E o inverso: com `now` logo depois da data EDITORIAL, ela entra —
    // provando que a exclusão acima vem da data certa, não de um filtro por
    // slug.
    const logoDepois = Date.parse(`${dataEditorial}T06:00:00Z`);
    assert.ok(newsEntryForPost(post, logoDepois));
  });

  it("addSitemapEntry poda bloco vencido mesmo quando a entrada nova já existe", () => {
    const antes = buildSitemapXml(sitemapEntriesForPosts([makePost({ slug: "de-ontem" })], { now: NOW }));
    assert.match(antes, /<news:news>/);

    // 3 dias depois, publicando a MESMA edição (idempotência do Stage 6).
    const depois = addSitemapEntry(antes, sitemapEntryFromPost(makePost({ slug: "de-ontem" })), {
      now: NOW + 3 * 24 * 60 * 60 * 1000,
    });
    assert.ok(!depois.includes("<news:news>"), "bloco de 3 dias atrás sobreviveu");
    assert.ok(!depois.includes("xmlns:news"), "namespace órfão ficou no urlset");
    assert.equal(depois.match(/<loc>/g)?.length, 1, "a entrada foi duplicada");
  });

  it("addSitemapEntry acrescenta bloco news + namespace a um sitemap que não tinha nenhum", () => {
    const antes = buildSitemapXml([{ loc: "https://diar.ia.br/p/antiga", lastmod: "2026-01-01" }]);
    assert.ok(!antes.includes("xmlns:news"));
    const depois = addSitemapEntry(antes, sitemapEntryFromPost(makePost(), { now: NOW }), {
      now: NOW,
    });
    assert.match(depois, /xmlns:news=/);
    assert.equal(depois.match(/xmlns:news=/g)?.length, 1, "namespace declarado 2x");
    assert.match(depois, /<news:title>Edição de teste<\/news:title>/);
  });

  it("pruneExpiredNewsBlocks remove bloco com publication_date ilegível (fail-closed)", () => {
    const xml = buildSitemapXml(sitemapEntriesForPosts([makePost()], { now: NOW })).replace(
      /<news:publication_date>[^<]*<\/news:publication_date>/,
      "<news:publication_date>nao-e-data</news:publication_date>",
    );
    const podado = pruneExpiredNewsBlocks(xml, NOW);
    assert.ok(!podado.includes("<news:news>"));
  });

  it("o XML com bloco news continua parseável pelos consumidores do sitemap", () => {
    const xml = buildSitemapXml([
      ...sitemapEntriesForPosts([makePost()], { now: NOW }),
      { loc: "https://diar.ia.br/p/antiga", lastmod: "2026-01-01" },
    ]);
    // parseSitemap (home/feed) — o bloco news não pode roubar loc/lastmod.
    const entries = parseSitemap(xml);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].loc, "https://diar.ia.br/p/edicao-de-teste");
    assert.equal(entries[0].lastmod, "2026-09-19");

    // parseSitemapPageEntries (backfill) — regex própria; sem tolerar filhos
    // depois do <lastmod>, a página com bloco news sumia do backfill EM
    // SILÊNCIO.
    const pages = parseSitemapPageEntries(xml);
    assert.deepEqual(
      pages.map((p) => p.slug),
      ["edicao-de-teste", "antiga"],
    );
    assert.equal(pages[0].lastmod, "2026-09-19");
  });
});
