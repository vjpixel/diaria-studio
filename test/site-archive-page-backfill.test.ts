/**
 * test/site-archive-page-backfill.test.ts (#8352, #8353 item 1, #8354, #8359)
 *
 * Cobre `scripts/lib/site-archive-page-backfill.ts` (miolo puro) e as
 * funções puras exportadas por `scripts/backfill-archive-page-links-seo.ts`
 * (parse de sitemap + orquestração via `runBackfill`, com I/O injetado —
 * nunca toca `workers/site/public/` real).
 *
 * Fixture central: uma página "estilo Kit legado" — tem `<title>`,
 * `<meta name="description">`, `<link rel="canonical">` (o que
 * `buildEditionArchivePost`/`buildArchivePageHtml` já injetavam antes de
 * #8336/#8352/#8354 existirem), mas NENHUM `og:type`, NENHUM `<h1>`, e
 * NENHUM JSON-LD — exatamente o achado medido ao vivo nas 11 páginas reais
 * do #8359 (issue #8354 tem o `{ '0': 11, '1': 259 }` medido ao vivo em 270 páginas).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillArchivePageOnDisk,
  extractPageTitle,
  extractHeroImageUrl,
  ARCHIVE_NAV_MARKER,
} from "../scripts/lib/site-archive-page-backfill.ts";
import { parseSitemapPageEntries, lastmodToUnixSeconds, runBackfill } from "../scripts/backfill-archive-page-links-seo.ts";
import { renderSiteNav, SITE_NAV_MARKER } from "../scripts/lib/shared/site-nav.ts";

/** Mimetiza o HTML real das 11 páginas Kit legadas (medido ao vivo, #8354) —
 * <head> com title/description/dek/canonical mas sem OG/h1/JSON-LD. */
function legacyKitPageFixture(
  overrides: { title?: string; description?: string; dek?: string; canonical?: string; heroImageUrl?: string | null } = {},
): string {
  const title = overrides.title ?? "10 mil agentes da OpenAI resolvem enigma de 90 anos";
  const description = overrides.description ?? "10 mil agentes da OpenAI resolvem enigma de 90 anos. Teaser D2 | D3";
  const dek = overrides.dek ?? "Teaser D2 | D3";
  const canonical = overrides.canonical ?? "https://diar.ia.br/p/10-mil-agentes-da-openai-resolvem-enigma-de-90-anos";
  const heroImageUrl =
    overrides.heroImageUrl === null ? undefined : (overrides.heroImageUrl ?? "https://eia.diar.ia.br/img/img-260911-04-d1-2x1-abc.jpg");
  const heroImg = heroImageUrl ? `<img class="hero" src="${heroImageUrl}" alt="">` : "";
  return (
    `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8">` +
    `<title>${title}</title>` +
    `<meta name="description" content="${description}">` +
    `<meta name="dek" content="${dek}">` +
    `<link rel="canonical" href="${canonical}"></head>\n` +
    `<body>\n${heroImg}\n<p>Corpo da edição, sem h1 nenhum neste formato.</p>\n</body></html>`
  );
}

/** Mimetiza uma das 259 páginas já enriquecidas (já passou por #8336/#8352/#8354). */
function alreadyEnrichedPageFixture(): string {
  return (
    `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8">` +
    `<title>Edição já enriquecida</title>` +
    `<meta name="description" content="Descrição já certa">` +
    `<link rel="canonical" href="https://diar.ia.br/p/ja-enriquecida">` +
    `<meta property="og:type" content="article">` +
    `<script type="application/ld+json">{"@type":"NewsArticle"}</script></head>\n` +
    `<body><h1>Edição já enriquecida</h1><p>Corpo.</p></body></html>`
  );
}

describe("extractPageTitle", () => {
  it("extrai e desescapa o <title>", () => {
    assert.equal(extractPageTitle("<title>A &amp; B</title>"), "A & B");
  });

  it("undefined quando não há <title>", () => {
    assert.equal(extractPageTitle("<html><body></body></html>"), undefined);
  });
});

describe("extractHeroImageUrl", () => {
  it("acha o src do <img class=\"hero\"> independente da ordem dos atributos", () => {
    assert.equal(
      extractHeroImageUrl(`<img src="https://x/a.jpg" class="hero">`),
      "https://x/a.jpg",
    );
    assert.equal(
      extractHeroImageUrl(`<img class="hero" src="https://x/b.jpg">`),
      "https://x/b.jpg",
    );
  });

  it("pega o PRIMEIRO hero quando há mais de um (D1, não D2/D3)", () => {
    const html = `<img class="hero" src="https://x/d1.jpg"><img class="hero" src="https://x/d2.jpg">`;
    assert.equal(extractHeroImageUrl(html), "https://x/d1.jpg");
  });

  it("undefined quando não há nenhum <img class=\"hero\">", () => {
    assert.equal(extractHeroImageUrl(`<img src="https://x/nao-hero.jpg">`), undefined);
    assert.equal(extractHeroImageUrl(`<p>sem imagem</p>`), undefined);
  });
});

describe("backfillArchivePageOnDisk — página legada estilo Kit (#8352/#8354/#8359)", () => {
  it("adiciona OG/Twitter, JSON-LD e h1 quando faltam", () => {
    const html = legacyKitPageFixture();
    const result = backfillArchivePageOnDisk(html, {
      slug: "10-mil-agentes-da-openai-resolvem-enigma-de-90-anos",
      publishDateUnixSeconds: Math.floor(Date.parse("2026-09-11T00:00:00Z") / 1000),
    });

    assert.equal(result.changed, true);
    assert.equal(result.addedSeo, true);
    assert.match(result.html, /property="og:type" content="article"/);
    assert.match(result.html, /property="og:title" content="10 mil agentes/);
    assert.match(result.html, /name="twitter:card"/);
    assert.match(result.html, /application\/ld\+json/);
    assert.match(result.html, /"datePublished":"2026-09-11"/);
    assert.match(result.html, /<h1[^>]*>10 mil agentes da OpenAI resolvem enigma de 90 anos<\/h1>/);
  });

  it("deriva og:image/twitter:image do primeiro <img class=\"hero\"> do corpo (#8352)", () => {
    const html = legacyKitPageFixture({ heroImageUrl: "https://eia.diar.ia.br/img/img-260911-04-d1-2x1-f4ac3dd2.jpg" });
    const result = backfillArchivePageOnDisk(html, { slug: "x" });
    assert.match(result.html, /property="og:image" content="https:\/\/eia\.diar\.ia\.br\/img\/img-260911-04-d1-2x1-f4ac3dd2\.jpg"/);
    assert.match(result.html, /property="og:image:width" content="1600"/);
    assert.match(result.html, /property="og:image:height" content="800"/);
    assert.match(result.html, /name="twitter:image"/);
  });

  it("sem <img class=\"hero\"> no corpo, omite og:image/twitter:image (nunca escreve valor ausente)", () => {
    const html = legacyKitPageFixture({ heroImageUrl: null });
    const result = backfillArchivePageOnDisk(html, { slug: "x" });
    assert.doesNotMatch(result.html, /og:image/);
    assert.doesNotMatch(result.html, /twitter:image/);
  });

  it("não duplica <meta name=\"description\">/<link rel=\"canonical\">/<meta name=\"dek\"> — substitui, não empilha", () => {
    const html = legacyKitPageFixture();
    const result = backfillArchivePageOnDisk(html, { slug: "10-mil-agentes-da-openai-resolvem-enigma-de-90-anos" });

    assert.equal((result.html.match(/<meta name="description"/g) || []).length, 1);
    assert.equal((result.html.match(/rel="canonical"/g) || []).length, 1);
    assert.equal((result.html.match(/name="dek"/g) || []).length, 1);
    assert.equal((result.html.match(/<title>/g) || []).length, 1);
  });

  it("preserva a description/dek originais (não regenera a partir de outra fonte)", () => {
    const html = legacyKitPageFixture({ description: "Descrição original preservada", dek: "Dek original" });
    const result = backfillArchivePageOnDisk(html, { slug: "x" });
    assert.match(result.html, /content="Descrição original preservada"/);
    assert.match(result.html, /content="Dek original"/);
  });

  it("sem publishDateUnixSeconds, omite article:published_time e JSON-LD (mesmo fail-soft de sempre)", () => {
    const html = legacyKitPageFixture();
    const result = backfillArchivePageOnDisk(html, { slug: "x" });
    assert.doesNotMatch(result.html, /article:published_time/);
    assert.doesNotMatch(result.html, /application\/ld\+json/);
  });

  it("idempotente — 2ª chamada é um no-op (marcador og:type já presente)", () => {
    const html = legacyKitPageFixture();
    const once = backfillArchivePageOnDisk(html, { slug: "x", publishDateUnixSeconds: 1000 });
    const twice = backfillArchivePageOnDisk(once.html, { slug: "x", publishDateUnixSeconds: 1000 });
    assert.equal(twice.addedSeo, false);
    assert.equal(twice.html, once.html);
  });

  it("falha fechada (não altera nada além do robots + #8497 nav) se faltar description ou canonical — nunca visto no corpus real, mas não deve piorar", () => {
    const broken = `<!doctype html><html><head><title>Só título</title></head><body></body></html>`;
    const result = backfillArchivePageOnDisk(broken, { slug: "x" });
    assert.equal(result.addedSeo, false);
    assert.equal(result.addedNav, false);
    // #8390: `max-image-preview:large` NÃO depende de description/canonical
    // (é uma diretiva de robô, não um campo de compartilhamento), então ele
    // entra mesmo aqui — e só ele. A falha fechada que este teste guarda é a
    // do BLOCO DE SEO, que segue não sendo escrito.
    assert.equal(result.addedRobots, true);
    assert.equal(result.addedJsonLdImage, false); // sem JSON-LD nem capa nesta página
    // #8497: o menu global é INDEPENDENTE do bloco de SEO — toda página
    // ganha nav, mesmo a que falhou fechado no SEO por faltar description/canonical.
    assert.equal(result.addedSiteNav, true);
    const expected = broken.replace("</title>", '</title><meta name="robots" content="max-image-preview:large">');
    assert.equal(
      result.html,
      expected.replace(/<body[^>]*>/i, (full) => `${full}\n${renderSiteNav({ active: "edicoes" })}`),
    );
  });
});

describe("backfillArchivePageOnDisk — unidades do #8390 (robots + image no JSON-LD)", () => {
  /** Página no estado PÓS-#8359 e PRÉ-#8390: SEO completo, JSON-LD
   * `NewsArticle` presente mas SEM `image`, og:image declarado, sem robots. */
  function pagina8359(extra: { jsonLd?: string; head?: string; body?: string } = {}): string {
    const jsonLd =
      extra.jsonLd ??
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Edição X","datePublished":"2026-09-11"}</script>';
    return (
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Edição X</title>` +
      `<meta property="og:type" content="article">` +
      `<meta property="og:image" content="https://eia.diar.ia.br/img/capa.jpg">` +
      `${extra.head ?? ""}${jsonLd}</head><body>${extra.body ?? "<p>corpo</p>"}</body></html>`
    );
  }

  it("acrescenta image ao NewsArticle usando o og:image já declarado", () => {
    const r = backfillArchivePageOnDisk(pagina8359(), { slug: "x" });
    assert.equal(r.addedJsonLdImage, true);
    assert.equal(r.addedRobots, true);
    const node = JSON.parse(r.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    assert.equal(node.image.url, "https://eia.diar.ia.br/img/capa.jpg");
    assert.equal(node.image["@type"], "ImageObject");
    // Só UM node JSON-LD — nunca um 2º NewsArticle descrevendo a mesma URL.
    assert.equal(r.html.match(/application\/ld\+json/g)?.length, 1);
  });

  it("sem og:image, cai no <img class=\"hero\"> do corpo", () => {
    const semOg = pagina8359({ body: '<img class="hero" src="https://eia.diar.ia.br/img/hero.jpg">' }).replace(
      '<meta property="og:image" content="https://eia.diar.ia.br/img/capa.jpg">',
      "",
    );
    const r = backfillArchivePageOnDisk(semOg, { slug: "x" });
    assert.equal(r.addedJsonLdImage, true);
    const node = JSON.parse(r.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    assert.equal(node.image.url, "https://eia.diar.ia.br/img/hero.jpg");
  });

  it("no-op quando o node já tem image (2ª passada é idempotente)", () => {
    const uma = backfillArchivePageOnDisk(pagina8359(), { slug: "x" });
    const duas = backfillArchivePageOnDisk(uma.html, { slug: "x" });
    assert.equal(duas.addedJsonLdImage, false);
    assert.equal(duas.addedRobots, false);
    assert.equal(duas.html, uma.html);
  });

  it("no-op quando o node não é NewsArticle (não sequestra JSON-LD de outro tipo)", () => {
    const outroTipo = pagina8359({
      jsonLd: '<script type="application/ld+json">{"@type":"WebSite","name":"diar.ia.br"}</script>',
    });
    const r = backfillArchivePageOnDisk(outroTipo, { slug: "x" });
    assert.equal(r.addedJsonLdImage, false);
    assert.ok(!r.html.includes("ImageObject"));
  });

  it("JSON-LD ilegível: no-op no HTML, mas AVISA (não some no balde de 'não precisava')", () => {
    const quebrado = pagina8359({ jsonLd: '<script type="application/ld+json">{ não é json }</script>' });
    const avisos: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      avisos.push(String(chunk));
      return true;
    };
    try {
      const r = backfillArchivePageOnDisk(quebrado, { slug: "slug-corrompido" });
      assert.equal(r.addedJsonLdImage, false);
      assert.ok(r.html.includes("{ não é json }"), "o node ilegível foi alterado");
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    assert.ok(
      avisos.some((a) => a.includes("slug-corrompido") && a.includes("JSON-LD ilegível")),
      `nenhum aviso nomeando o slug: ${JSON.stringify(avisos)}`,
    );
  });

  it("página que JÁ declara <meta name=\"robots\"> (qualquer valor) não ganha uma 2ª tag", () => {
    const comRobots = pagina8359({ head: '<meta name="robots" content="noindex">' });
    const r = backfillArchivePageOnDisk(comRobots, { slug: "x" });
    assert.equal(r.addedRobots, false);
    assert.equal(r.html.match(/name="robots"/g)?.length, 1);
    assert.ok(r.html.includes('content="noindex"'), "a diretiva do editor foi sobrescrita");
  });
});

describe("backfillArchivePageOnDisk — página já enriquecida (#8352/#8354 já presentes)", () => {
  it("não mexe no SEO/h1 já correto — marcador og:type já presente", () => {
    const html = alreadyEnrichedPageFixture();
    const result = backfillArchivePageOnDisk(html, {
      slug: "ja-enriquecida",
      prev: { slug: "anterior", title: "Anterior" },
    });
    assert.equal(result.addedSeo, false);
    assert.equal((result.html.match(/<h1[^>]*>/g) || []).length, 1);
    assert.equal((result.html.match(/og:type/g) || []).length, 1);
  });

  it("ainda ganha nav se estiver faltando", () => {
    const html = alreadyEnrichedPageFixture();
    const result = backfillArchivePageOnDisk(html, {
      slug: "ja-enriquecida",
      prev: { slug: "anterior", title: "Anterior" },
    });
    assert.equal(result.addedNav, true);
    assert.match(result.html, new RegExp(ARCHIVE_NAV_MARKER.replace(/"/g, '\\"')));
  });
});

describe("backfillArchivePageOnDisk — nav (#8353 item 1)", () => {
  it("sem prev/next resolvidos, não injeta <nav> nenhum", () => {
    const html = legacyKitPageFixture();
    const result = backfillArchivePageOnDisk(html, { slug: "x" });
    assert.equal(result.addedNav, false);
    assert.doesNotMatch(result.html, /archive-nav/);
  });

  it("idempotente — 2ª chamada com os mesmos vizinhos não duplica o <nav>", () => {
    const html = legacyKitPageFixture();
    const ctx = { slug: "x", prev: { slug: "a", title: "A" }, next: { slug: "b", title: "B" } };
    const once = backfillArchivePageOnDisk(html, ctx);
    const twice = backfillArchivePageOnDisk(once.html, ctx);
    assert.equal(twice.addedNav, false);
    assert.equal((twice.html.match(/archive-nav/g) || []).length, 1);
  });
});

describe("parseSitemapPageEntries", () => {
  it("extrai slug + lastmod de cada <url>/p/{slug}, ignora URLs fora de /p/", () => {
    const xml =
      `<?xml version="1.0"?><urlset>` +
      `<url><loc>https://diar.ia.br/p/a</loc><lastmod>2026-09-10</lastmod></url>` +
      `<url><loc>https://diar.ia.br/p/b</loc><lastmod>2026-09-09</lastmod></url>` +
      `<url><loc>https://diar.ia.br/clarice</loc></url>` +
      `</urlset>`;
    const entries = parseSitemapPageEntries(xml);
    assert.deepEqual(entries, [
      { slug: "a", lastmod: "2026-09-10" },
      { slug: "b", lastmod: "2026-09-09" },
    ]);
  });

  it("entrada sem <lastmod> devolve lastmod undefined, não lança", () => {
    const xml = `<urlset><url><loc>https://diar.ia.br/p/sem-data</loc></url></urlset>`;
    assert.deepEqual(parseSitemapPageEntries(xml), [{ slug: "sem-data", lastmod: undefined }]);
  });
});

describe("lastmodToUnixSeconds", () => {
  it("converte YYYY-MM-DD pra unix seconds a meia-noite UTC", () => {
    assert.equal(lastmodToUnixSeconds("2026-09-11"), Math.floor(Date.parse("2026-09-11T00:00:00Z") / 1000));
  });

  it("undefined pra ausente ou inválido", () => {
    assert.equal(lastmodToUnixSeconds(undefined), undefined);
    assert.equal(lastmodToUnixSeconds("não é uma data"), undefined);
  });
});

describe("runBackfill (tmpdir real — existsSync não é injetável, então usa disco de verdade)", () => {
  it("aplica SEO+nav na página legada e só nav na já enriquecida, na ordem do sitemap", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-backfill-test-"));
    try {
      const pagesDir = join(tmp, "p");
      mkdirSync(join(pagesDir, "nova"), { recursive: true });
      mkdirSync(join(pagesDir, "legada"), { recursive: true });
      writeFileSync(join(pagesDir, "nova", "index.html"), alreadyEnrichedPageFixture(), "utf8");
      writeFileSync(
        join(pagesDir, "legada", "index.html"),
        legacyKitPageFixture({ canonical: "https://diar.ia.br/p/legada", title: "Edição legada" }),
        "utf8",
      );
      const sitemapXml =
        `<urlset>` +
        `<url><loc>https://diar.ia.br/p/nova</loc><lastmod>2026-09-11</lastmod></url>` +
        `<url><loc>https://diar.ia.br/p/legada</loc><lastmod>2026-09-05</lastmod></url>` +
        `</urlset>`;

      const result = runBackfill(pagesDir, sitemapXml);

      assert.equal(result.totalInSitemap, 2);
      assert.equal(result.pagesFound, 2);
      assert.equal(result.pagesMissing.length, 0);
      assert.equal(result.changed, 2);
      assert.equal(result.seoChanged, 1); // só "legada"
      assert.equal(result.navChanged, 2); // as duas ganham nav

      const nova = readFileSync(join(pagesDir, "nova", "index.html"), "utf8");
      const legada = readFileSync(join(pagesDir, "legada", "index.html"), "utf8");

      // "nova" é a mais recente — só ganha PREV, apontando pra "legada".
      assert.match(nova, /href="https:\/\/diar\.ia\.br\/p\/legada" rel="prev"/);
      assert.doesNotMatch(nova, /rel="next"/);
      assert.doesNotMatch(nova, /property="og:type" content="[^"]*"[\s\S]*property="og:type"/); // não duplicou

      // "legada" é a mais antiga — só ganha NEXT, apontando pra "nova", e o
      // SEO completo (era o Kit-legado).
      assert.match(legada, /href="https:\/\/diar\.ia\.br\/p\/nova" rel="next"/);
      assert.doesNotMatch(legada, /rel="prev"/);
      assert.match(legada, /property="og:type" content="article"/);
      assert.match(legada, /application\/ld\+json/);
      assert.equal((legada.match(/<h1[^>]*>/g) || []).length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("é idempotente — 2ª chamada não altera nada", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-backfill-test-"));
    try {
      const pagesDir = join(tmp, "p");
      mkdirSync(join(pagesDir, "a"), { recursive: true });
      writeFileSync(join(pagesDir, "a", "index.html"), legacyKitPageFixture({ canonical: "https://diar.ia.br/p/a" }), "utf8");
      const sitemapXml = `<urlset><url><loc>https://diar.ia.br/p/a</loc><lastmod>2026-09-05</lastmod></url></urlset>`;

      runBackfill(pagesDir, sitemapXml);
      const secondRun = runBackfill(pagesDir, sitemapXml);

      assert.equal(secondRun.changed, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--dry-run não escreve nada em disco, mas reporta o que faria", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-backfill-test-"));
    try {
      const pagesDir = join(tmp, "p");
      mkdirSync(join(pagesDir, "a"), { recursive: true });
      const original = legacyKitPageFixture({ canonical: "https://diar.ia.br/p/a" });
      writeFileSync(join(pagesDir, "a", "index.html"), original, "utf8");
      const sitemapXml = `<urlset><url><loc>https://diar.ia.br/p/a</loc><lastmod>2026-09-05</lastmod></url></urlset>`;

      const result = runBackfill(pagesDir, sitemapXml, { dryRun: true });

      assert.equal(result.changed, 1);
      assert.equal(readFileSync(join(pagesDir, "a", "index.html"), "utf8"), original);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("slug do sitemap sem arquivo em disco entra em pagesMissing, não aborta o lote", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-backfill-test-"));
    try {
      const pagesDir = join(tmp, "p");
      mkdirSync(join(pagesDir, "existe"), { recursive: true });
      writeFileSync(join(pagesDir, "existe", "index.html"), alreadyEnrichedPageFixture(), "utf8");
      const sitemapXml =
        `<urlset>` +
        `<url><loc>https://diar.ia.br/p/existe</loc><lastmod>2026-09-05</lastmod></url>` +
        `<url><loc>https://diar.ia.br/p/nao-existe</loc><lastmod>2026-09-06</lastmod></url>` +
        `</urlset>`;

      const result = runBackfill(pagesDir, sitemapXml);

      assert.deepEqual(result.pagesMissing, ["nao-existe"]);
      assert.equal(result.pagesFound, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
