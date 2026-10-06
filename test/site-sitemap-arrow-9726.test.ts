/**
 * test/site-sitemap-arrow-9726.test.ts (#9726, achado do review consolidado do #9721)
 *
 * Regressão: o #9721 normalizou a seta `→` só no HTML da página `/p/{slug}`
 * (`buildArchivePageHtml`). No MESMO publish, `updateSitemapAndHome` grava o
 * `<news:title>` do sitemap a partir de `derivePageTitle(post)` cru — uma
 * edição com `→` no título publicada dentro da janela de 48h (sempre o caso
 * no dia do Stage 6) punha a seta em `workers/site/public/sitemap.xml`, e o
 * check `check-no-arrow-glyph` reprovava o PR automático da página.
 *
 * Invariante: depois de um publish REAL (`productionDeps` → `writePage` +
 * `updateSitemapAndHome`), `sitemap.xml` e `index.html` (home) passam no
 * MESMO scanner do CI (`scanPublishedText`, allowlist vazia).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishEditionSitePage,
  productionDeps,
  homePageRelPathFromSitemap,
  type PublishPageDeps,
  type GitRunner,
  type GhRunner,
  type LockRunner,
  type SleepFn,
} from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import { scanPublishedText } from "../scripts/lib/no-arrow-glyph-scan.ts";
import { ARROW_GLYPH } from "../scripts/lib/shared/arrow-glyph.ts";
import {
  addSitemapEntry,
  buildSitemapXml,
  buildArchiveNeighborNavHtml,
  newsEntryForPost,
} from "../scripts/lib/site-archive-pages.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const SLUG = "gemini-sobe-para-18";
const TITULO_COM_SETA = "Gemini → 18% do tráfego, ChatGPT 87% → 68%";

function fakes() {
  const staged: string[] = [];
  const git: GitRunner = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
    if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
    if (args[0] === "add") {
      staged.push(...args.slice(2));
      return "";
    }
    if (args[0] === "status") return ` M workers/site/public/p/${SLUG}/index.html\n`;
    if (args[0] === "diff") return staged.join("\n");
    return "";
  };
  const gh: GhRunner = (args) => {
    if (args.slice(0, 2).join(" ") === "pr list") return "[]";
    if (args.slice(0, 2).join(" ") === "pr create") return "https://github.com/vjpixel/diaria-studio/pull/1\n";
    return "";
  };
  const lock: LockRunner = () => ({ ok: true, stdout: "", stderr: "" });
  const sleep: SleepFn = () => {};
  return { git, gh, lock, sleep };
}

describe("#9726 sitemap/home de edição com seta no título passam no check-no-arrow-glyph", () => {
  it("REGRESSÃO (cenário real): publish com updateSitemapAndHome real não grava seta no sitemap.xml nem na home", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-sitemap-arrow-9726-"));
    try {
      const { git, gh, lock, sleep } = fakes();
      // Publicada há 1h: dentro da janela de 48h do news sitemap, então o
      // bloco <news:title> É emitido (é o caso do dia do Stage 6).
      const inputs: EditionPageInputs = {
        html: "<p>corpo sem seta</p>",
        postUrl: `https://diar.ia.br/p/${SLUG}`,
        title: TITULO_COM_SETA,
        subtitle: "Subtítulo",
        publishedAtIso: new Date(Date.now() - 3600_000).toISOString(),
      };
      const deps: PublishPageDeps = {
        ...productionDeps(dir, git, gh, lock, sleep),
        readEditionInputs: () => inputs,
      };
      // `skipPublish`: sitemap + home são escritos ANTES do check de publish
      // (é "escrita", não "publicar") — nenhum commit/push/PR/merge-waiter.
      const r = publishEditionSitePage(dir, deps, { sitemap: SITEMAP_REL, skipPublish: true });
      assert.equal(r.code, 0, JSON.stringify(r));

      const sitemap = readFileSync(join(dir, ...SITEMAP_REL.split("/")), "utf8");
      // Pré-condição do cenário: o bloco news de fato saiu (senão o teste
      // passaria vazio, sem exercitar o <news:title>).
      assert.match(sitemap, /<news:title>[^<]*Gemini[^<]*<\/news:title>/, sitemap);
      assert.deepEqual(scanPublishedText(SITEMAP_REL, sitemap, []), []);
      assert.ok(!sitemap.includes(ARROW_GLYPH));

      const homeRel = homePageRelPathFromSitemap(SITEMAP_REL);
      const homePath = join(dir, ...homeRel.split("/"));
      assert.ok(existsSync(homePath));
      const home = readFileSync(homePath, "utf8");
      assert.match(home, /Gemini/);
      assert.deepEqual(scanPublishedText(homeRel, home, []), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("newsEntryForPost devolve título sem seta", () => {
    const now = Date.UTC(2026, 9, 7, 12);
    const news = newsEntryForPost(
      { slug: SLUG, title: TITULO_COM_SETA, subtitle: null, status: "confirmed", publish_date: now / 1000 - 3600 },
      now,
    );
    assert.ok(news);
    assert.ok(!news.title.includes(ARROW_GLYPH), news.title);
    assert.match(news.title, /87% para 68%/);
  });

  it("addSitemapEntry e buildSitemapXml normalizam mesmo SitemapEntry montada à mão (ponto único renderNewsBlock)", () => {
    const now = Date.UTC(2026, 9, 7, 12);
    const entry = {
      loc: `https://diar.ia.br/p/${SLUG}`,
      lastmod: new Date(now - 3600_000).toISOString(),
      news: { title: "A → B", publicationDate: new Date(now - 3600_000).toISOString() },
    };
    const inc = addSitemapEntry(buildSitemapXml([]), entry, { now });
    assert.match(inc, /<news:title>A – B<\/news:title>/);
    assert.deepEqual(scanPublishedText(SITEMAP_REL, inc, []), []);
    const batch = buildSitemapXml([entry]);
    assert.deepEqual(scanPublishedText(SITEMAP_REL, batch, []), []);
  });

  it("nav prev/next (também injetada pelo backfill em página já gravada) sai sem seta no título do vizinho", () => {
    const nav = buildArchiveNeighborNavHtml({ slug: "a", title: "X → Y" }, { slug: "b", title: "1 → 2" });
    assert.ok(!nav.includes(ARROW_GLYPH), nav);
  });
});
