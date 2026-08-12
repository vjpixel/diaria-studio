/**
 * test/artigos-sitemap-5126.test.ts (#5126)
 *
 * `especial.diar.ia.br` (Worker `artigos`, static-assets-only — sem `main`,
 * `[assets]` serve `public/` direto) não tinha `sitemap.xml`, `Sitemap:` no
 * robots.txt, nem uma raiz de verdade — o único artigo publicado
 * (`2026/o-agente/`) estava 100% fora do inventário de crawl (ver corpo da
 * issue #5126). `public/sitemap.xml` e `public/index.html` são mantidos à
 * mão (não há build script pra este Worker — ver README.md) — este teste é
 * o guard que impede um artigo novo em `public/{ano}/{slug}/` de ficar de
 * fora do sitemap/índice por esquecimento.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "artigos", "public");

/**
 * Descobre todo artigo publicado como `public/{ano}/{slug}/index.html` —
 * `{ano}` é um diretório de 4 dígitos sob `public/` (exclui `robots.txt`,
 * `sitemap.xml`, `index.html` da raiz, que não são pastas de ano).
 */
function discoverArticles(): { year: string; slug: string; path: string }[] {
  const articles: { year: string; slug: string; path: string }[] = [];
  for (const yearEntry of readdirSync(PUBLIC_DIR)) {
    const yearPath = join(PUBLIC_DIR, yearEntry);
    if (!/^\d{4}$/.test(yearEntry) || !statSync(yearPath).isDirectory()) continue;
    for (const slugEntry of readdirSync(yearPath)) {
      const slugPath = join(yearPath, slugEntry);
      if (!statSync(slugPath).isDirectory()) continue;
      const indexPath = join(slugPath, "index.html");
      if (existsSync(indexPath)) articles.push({ year: yearEntry, slug: slugEntry, path: indexPath });
    }
  }
  return articles;
}

describe("workers/artigos/public — sitemap.xml e index.html cobrem todo artigo publicado (#5126)", () => {
  const articles = discoverArticles();

  it("pelo menos 1 artigo é descoberto (guard não fica vazio silenciosamente)", () => {
    assert.ok(articles.length >= 1, "nenhum public/{ano}/{slug}/index.html encontrado — discoverArticles() quebrou?");
  });

  it("sitemap.xml existe, é XML válido, e tem <loc> pra raiz + todo artigo descoberto", () => {
    const sitemapPath = join(PUBLIC_DIR, "sitemap.xml");
    assert.ok(existsSync(sitemapPath), `${sitemapPath} ausente`);
    const xml = readFileSync(sitemapPath, "utf8");
    assert.match(xml, /<urlset/);
    assert.match(xml, /<loc>https:\/\/especial\.diar\.ia\.br\/<\/loc>/);
    for (const a of articles) {
      const url = `https://especial.diar.ia.br/${a.year}/${a.slug}/`;
      assert.ok(
        xml.includes(`<loc>${url}</loc>`),
        `sitemap.xml sem <loc> pra ${url} — artigo publicado em public/ mas fora do sitemap`,
      );
    }
  });

  it("todo <url> do sitemap tem <lastmod>", () => {
    const xml = readFileSync(join(PUBLIC_DIR, "sitemap.xml"), "utf8");
    const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)];
    assert.ok(urlBlocks.length >= 1);
    for (const [, block] of urlBlocks) {
      assert.match(block, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, `<url> sem <lastmod>: ${block}`);
    }
  });

  it("robots.txt declara Sitemap: apontando pro sitemap.xml deste host (#5126 item 2)", () => {
    const robots = readFileSync(join(PUBLIC_DIR, "robots.txt"), "utf8");
    assert.match(robots, /Sitemap: https:\/\/especial\.diar\.ia\.br\/sitemap\.xml/);
  });

  it("index.html (raiz) linka todo artigo descoberto", () => {
    const indexHtml = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    for (const a of articles) {
      const href = `/${a.year}/${a.slug}/`;
      assert.ok(
        indexHtml.includes(`href="${href}"`),
        `public/index.html não linka ${href} — artigo publicado mas ausente do índice da raiz`,
      );
    }
  });

  it("cada artigo tem JSON-LD Article com author/datePublished/dateModified/publisher (#5126 item 4)", () => {
    for (const a of articles) {
      const html = readFileSync(a.path, "utf8");
      const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(m, `${a.path} sem <script type="application/ld+json">`);
      const parsed = JSON.parse(m![1]);
      const graph = Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
      const article = graph.find((n: { "@type"?: string }) => n["@type"] === "Article");
      assert.ok(article, `${a.path}: JSON-LD sem node @type Article`);
      assert.ok(article.author?.name, `${a.path}: Article.author.name ausente`);
      assert.match(article.datePublished ?? "", /^\d{4}-\d{2}-\d{2}$/, `${a.path}: datePublished ausente/inválido`);
      assert.match(article.dateModified ?? "", /^\d{4}-\d{2}-\d{2}$/, `${a.path}: dateModified ausente/inválido`);
      assert.ok(article.publisher?.name, `${a.path}: Article.publisher.name ausente`);
    }
  });
});
