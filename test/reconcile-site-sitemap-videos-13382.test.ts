/**
 * test/reconcile-site-sitemap-videos-13382.test.ts (#13382)
 *
 * REGRESSÃO: `reconcile-site-sitemap.ts` reescreve a home quando acrescenta
 * edição órfã ao sitemap. Antes do #13382 ele chamava `buildIndexHtml` sem o
 * campo opcional `videos` — a home commitada perdia a seção "Vídeos" (e o
 * link "Ver todos os vídeos") até o regen das 06:00, e o tsc não pegava.
 * Roda a CLI de verdade sobre um acervo de fixture com uma edição órfã que
 * tem vídeo e confere `id="videos"` na home escrita.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cliMain } from "../scripts/reconcile-site-sitemap.ts";
import { buildVideoEmbedHtml, buildVideoObjectJsonLd } from "../scripts/lib/site-page-video.ts";

function page(title: string, date: string, videoId?: string): string {
  const video = videoId
    ? buildVideoObjectJsonLd({ videoId, name: `Vídeo ${title}`, description: `${title}.`, uploadDate: `${date}T09:00:00Z` })
    : "";
  const embed = videoId ? buildVideoEmbedHtml(videoId, title) : "";
  return `<!doctype html><html><head><meta property="article:published_time" content="${date}"><title>${title}</title><meta name="description" content="${title}.">${video}</head><body>${embed}<p>corpo</p></body></html>`;
}

function sitemapWith(slugs: string[]): string {
  const urls = slugs.map((s) => `  <url><loc>https://diar.ia.br/p/${s}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

describe("#13382 — reconcile-site-sitemap mantém a seção Vídeos na home", () => {
  it("edição órfã com vídeo: a home regenerada tem id=\"videos\" e o vídeo", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-videos-13382-"));
    const pagesDir = join(root, "p");
    const pages: Record<string, string> = {
      "edicao-antiga": page("Edição antiga", "2026-11-01"),
      "edicao-orfa-com-video": page("Edição órfã", "2026-11-10", "MJXHg3HekNE"),
    };
    for (const [slug, html] of Object.entries(pages)) {
      mkdirSync(join(pagesDir, slug), { recursive: true });
      writeFileSync(join(pagesDir, slug, "index.html"), html, "utf8");
    }
    const sm = join(root, "sitemap.xml");
    const home = join(root, "index.html");
    writeFileSync(sm, sitemapWith(["edicao-antiga"]), "utf8");
    try {
      assert.equal(cliMain(["--pages-dir", pagesDir, "--sitemap", sm, "--home", home]), 0);
      const html = readFileSync(home, "utf8");
      assert.ok(html.includes("/p/edicao-orfa-com-video"), "a órfã tem de ter entrado na home");
      assert.match(html, /id="videos"/, "a home regenerada pelo reconcile perdeu a seção Vídeos");
      assert.ok(html.includes("MJXHg3HekNE"), "o vídeo da órfã tem de aparecer na seção");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
