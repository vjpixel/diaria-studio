/**
 * test/artigos-entidades-5125.test.ts (#5125)
 *
 * Guard irmão de `test/artigos-sitemap-5126.test.ts`, escopado ao conteúdo
 * NOVO desta issue — `public/entidades/{slug}/index.html` — em vez de
 * generalizar `discoverArticles()` daquele arquivo (que exige JSON-LD
 * `Article` como node ÚNICO/primário; uma página de entidade é um ÍNDICE,
 * com `Article` + `FAQPage` + `ItemList` no mesmo `@graph` via
 * `renderGeoJsonLd`, forma distinta da de um artigo avulso — ver
 * `scripts/lib/shared/entity-page.ts`). Mesma função: impede uma entidade
 * nova em `public/entidades/` de ficar de fora do sitemap/índice da raiz
 * por esquecimento.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "artigos", "public");
const ENTIDADES_DIR = join(PUBLIC_DIR, "entidades");

function discoverEntities(): { slug: string; path: string }[] {
  if (!existsSync(ENTIDADES_DIR)) return [];
  const entities: { slug: string; path: string }[] = [];
  for (const slugEntry of readdirSync(ENTIDADES_DIR)) {
    const slugPath = join(ENTIDADES_DIR, slugEntry);
    if (!statSync(slugPath).isDirectory()) continue;
    const indexPath = join(slugPath, "index.html");
    if (existsSync(indexPath)) entities.push({ slug: slugEntry, path: indexPath });
  }
  return entities;
}

describe("workers/artigos/public/entidades — sitemap.xml e index.html cobrem toda entidade publicada (#5125)", () => {
  const entities = discoverEntities();

  it("pelo menos 1 entidade é descoberta (guard não fica vazio silenciosamente)", () => {
    assert.ok(entities.length >= 1, "nenhum public/entidades/{slug}/index.html encontrado — discoverEntities() quebrou?");
  });

  it("sitemap.xml tem <loc> pra toda entidade descoberta, com <lastmod>", () => {
    const xml = readFileSync(join(PUBLIC_DIR, "sitemap.xml"), "utf8");
    for (const e of entities) {
      const url = `https://especial.diar.ia.br/entidades/${e.slug}/`;
      const locIdx = xml.indexOf(`<loc>${url}</loc>`);
      assert.ok(locIdx >= 0, `sitemap.xml sem <loc> pra ${url} — entidade publicada em public/ mas fora do sitemap`);
      const urlBlockEnd = xml.indexOf("</url>", locIdx);
      const urlBlockStart = xml.lastIndexOf("<url>", locIdx);
      const block = xml.slice(urlBlockStart, urlBlockEnd);
      assert.match(block, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, `<url> de ${url} sem <lastmod>`);
    }
  });

  it("index.html (raiz) linka toda entidade descoberta", () => {
    const indexHtml = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    for (const e of entities) {
      const href = `/entidades/${e.slug}/`;
      assert.ok(
        indexHtml.includes(`href="${href}"`),
        `public/index.html não linka ${href} — entidade publicada mas ausente do índice da raiz`,
      );
    }
  });

  it("cada entidade tem JSON-LD com Article (author/datePublished/dateModified/publisher), FAQPage e ItemList", () => {
    for (const e of entities) {
      const html = readFileSync(e.path, "utf8");
      const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(m, `${e.path} sem <script type="application/ld+json">`);
      const parsed = JSON.parse(m![1]);
      const graph = Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
      const article = graph.find((n: { "@type"?: string }) => n["@type"] === "Article");
      assert.ok(article, `${e.path}: JSON-LD sem node @type Article`);
      assert.ok(article.author?.name, `${e.path}: Article.author.name ausente`);
      assert.match(article.datePublished ?? "", /^\d{4}-\d{2}-\d{2}$/, `${e.path}: datePublished ausente/inválido`);
      assert.match(article.dateModified ?? "", /^\d{4}-\d{2}-\d{2}$/, `${e.path}: dateModified ausente/inválido`);
      assert.ok(article.publisher?.name, `${e.path}: Article.publisher.name ausente`);
      const faqPage = graph.find((n: { "@type"?: string }) => n["@type"] === "FAQPage");
      assert.ok(faqPage, `${e.path}: JSON-LD sem node @type FAQPage`);
      const itemList = graph.find((n: { "@type"?: string }) => n["@type"] === "ItemList");
      assert.ok(itemList, `${e.path}: JSON-LD sem node @type ItemList`);
      assert.ok(itemList.numberOfItems > 0, `${e.path}: ItemList vazio`);
    }
  });

  it("robots.txt (mesmo servido por artigos e entidades) declara Sitemap:", () => {
    const robots = readFileSync(join(PUBLIC_DIR, "robots.txt"), "utf8");
    assert.match(robots, /Sitemap: https:\/\/especial\.diar\.ia\.br\/sitemap\.xml/);
  });
});
