/**
 * gen-feed.ts (#8333)
 *
 * Gera `workers/site/public/feed.xml` (RSS 2.0 das edições, servido em
 * `https://diar.ia.br/feed.xml`) a partir do `sitemap.xml` + `public/p/{slug}`
 * já commitados — mesma fonte de `gen-home-page.ts`/`gen-archive-index.ts`.
 * Racional em `scripts/lib/site-feed.ts`. Rodar junto deles.
 *
 * Uso: npx tsx scripts/gen-feed.ts [--sitemap ...] [--pages-dir ...] [--out ...] [--limit 50]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildArchiveIndexFeed } from "./lib/site-archive-index.ts";
import { buildSiteFeedXml, SITE_FEED_LIMIT } from "./lib/site-feed.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function main(argv = process.argv.slice(2)): number {
  const { values } = parseArgs(argv);
  const sitemapPath = values["sitemap"] ? resolve(ROOT, values["sitemap"]) : resolve(ROOT, "workers", "site", "public", "sitemap.xml");
  const pagesDir = values["pages-dir"] ? resolve(ROOT, values["pages-dir"]) : resolve(ROOT, "workers", "site", "public", "p");
  const outPath = values["out"] ? resolve(ROOT, values["out"]) : resolve(ROOT, "workers", "site", "public", "feed.xml");
  const limitRaw = values["limit"];
  const limit = limitRaw !== undefined ? Number(limitRaw) : SITE_FEED_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`gen-feed: --limit inválido: "${limitRaw}" (esperado inteiro >= 1)`);
  }
  if (!existsSync(sitemapPath)) {
    console.error(`gen-feed: sitemap ausente: ${sitemapPath}`);
    return 1;
  }
  const readPageHtml = (slug: string): string | null => {
    const p = join(pagesDir, slug, "index.html");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const entries = buildArchiveIndexFeed(readFileSync(sitemapPath, "utf8"), readPageHtml);
  if (entries.length === 0) {
    console.error("gen-feed: nenhuma edição resolvida — feed vazio seria pior que o 404 atual");
    return 1;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildSiteFeedXml(entries, limit), "utf8");
  console.log(`gen-feed: ${Math.min(limit, entries.length)} item(ns) em ${outPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
