/**
 * gen-videos-page.ts (#13323)
 *
 * Gera `workers/site/public/videos/index.html` (todos os vídeos horizontais
 * da diar.ia.br) a partir do acervo já commitado — `sitemap.xml` +
 * `public/p/{slug}/index.html`, as mesmas fontes de `gen-home-page.ts`. Miolo
 * em `scripts/lib/site-videos-page.ts`.
 *
 * Roda junto da home no `regen-home.yml` (06:00 BRT), com o mesmo corte de
 * edição futura.
 *
 * Uso:
 *   npx tsx scripts/gen-videos-page.ts [--sitemap workers/site/public/sitemap.xml] [--pages-dir workers/site/public/p] [--out workers/site/public/videos/index.html]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildVideoFeed } from "./lib/site-home-page.ts";
import { buildVideosPageHtml, VIDEOS_PAGE_FILE } from "./lib/site-videos-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

/** Lê o acervo de `pagesDir` e escreve a página em `outPath`. Devolve quantos vídeos entraram. */
export function writeVideosPage(sitemapPath: string, pagesDir: string, outPath: string): number {
  const sitemapXml = readFileSync(sitemapPath, "utf8");
  const readPageHtml = (slug: string): string | null => {
    const path = join(pagesDir, slug, "index.html");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  const videos = buildVideoFeed(sitemapXml, readPageHtml);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildVideosPageHtml(videos), "utf8");
  return videos.length;
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const sitemapPath = values["sitemap"] ? resolve(ROOT, values["sitemap"]) : join(PUBLIC_DIR, "sitemap.xml");
  const pagesDir = values["pages-dir"] ? resolve(ROOT, values["pages-dir"]) : join(PUBLIC_DIR, "p");
  const outPath = values["out"] ? resolve(ROOT, values["out"]) : join(PUBLIC_DIR, VIDEOS_PAGE_FILE);
  const count = writeVideosPage(sitemapPath, pagesDir, outPath);
  console.log(`gen-videos-page: ${outPath} escrito (${count} vídeos)`);
}

if (isMainModule(import.meta.url)) {
  main();
}
