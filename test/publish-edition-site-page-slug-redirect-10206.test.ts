/**
 * #10206: republicar a página com slug novo grava `/p/{velho} /p/{novo} 301`
 * em `_redirects` — posts sociais já agendados com o slug velho não dão 404.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSlugRedirect,
  redirectsRelPathFromSitemap,
  supersedePreviousSitePage,
  type GhRunner,
} from "../scripts/publish-edition-site-page.ts";

const SITEMAP_REL = "workers/site/public/sitemap.xml";
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("#10206 addSlugRedirect", () => {
  it("acrescenta a linha, é idempotente e ignora slug igual", () => {
    const out = addSlugRedirect("/p/a /p/b 301\n", "velho", "novo");
    assert.equal(out, "/p/a /p/b 301\n/p/velho /p/novo 301\n");
    assert.equal(addSlugRedirect(out, "velho", "outro"), out);
    assert.equal(addSlugRedirect("x\n", "a", "a"), "x\n");
    assert.equal(addSlugRedirect("", "velho", "novo"), "/p/velho /p/novo 301\n");
  });
  it("caminho do _redirects é irmão do sitemap", () => {
    assert.equal(redirectsRelPathFromSitemap(SITEMAP_REL), "workers/site/public/_redirects");
  });
});

describe("#10206 supersedePreviousSitePage", () => {
  it("grava o redirect velho -> novo em _redirects", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-10206-"));
    dirs.push(root);
    mkdirSync(join(root, "workers", "site", "public"), { recursive: true });
    writeFileSync(join(root, "workers", "site", "public", "_redirects"), "/p/x /p/y 301\n");
    const gh: GhRunner = () => "";
    const out = supersedePreviousSitePage(root, gh, {
      oldSlug: "titulo-velho",
      newSlug: "titulo-novo",
      sitemapRelPath: SITEMAP_REL,
    });
    assert.equal(out.redirectAdded, true);
    assert.equal(
      readFileSync(join(root, "workers", "site", "public", "_redirects"), "utf8"),
      "/p/x /p/y 301\n/p/titulo-velho /p/titulo-novo 301\n",
    );
  });
});
