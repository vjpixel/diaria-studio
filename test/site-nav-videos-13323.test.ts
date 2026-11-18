/**
 * test/site-nav-videos-13323.test.ts (#13323, item 2)
 *
 * Item "Vídeos" no menu global (`site-nav.ts`) e a propagação dele para as
 * páginas já commitadas (`refreshSiteNavLinks` / `scripts/refresh-site-nav.ts`).
 * A 1ª PR da issue (#13360) deixou o item de fora porque o menu é HTML
 * embutido em ~345 páginas commitadas de 4 Workers e `injectSiteNavAfterBodyOpen`
 * nunca reinjeta numa página que já tem o menu. O guard do fim deste arquivo
 * trava o caso geral: toda página commitada com o menu carrega os itens de
 * `NAV_ITEM_DEFS` de hoje, então o próximo item novo sem o refresh quebra aqui.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderSiteNav, refreshSiteNavLinks, DIARIA_APEX_URL, SITE_NAV_MARKER } from "../scripts/lib/shared/site-nav.ts";
import { buildVideosPageHtml } from "../scripts/lib/site-videos-page.ts";
import { buildVideoFeed } from "../scripts/lib/site-home-page.ts";
import { buildVideoEmbedHtml, buildVideoObjectJsonLd } from "../scripts/lib/site-page-video.ts";
import { listHtmlFiles, refreshSiteNavUnder } from "../scripts/refresh-site-nav.ts";

const ROOT = join(import.meta.dirname, "..");

/** Remove a linha do item Vídeos: simula uma página gerada antes do #13323. */
function withoutVideosItem(html: string): string {
  return html.replace(/\n\s*<a href="[^"]*\/videos[^"]*"[^>]*>Vídeos<\/a>/, "");
}

function page(nav: string, body = "<main>conteúdo</main>"): string {
  return `<!DOCTYPE html><html><head><title>x</title></head><body>\n${nav}\n${body}</body></html>`;
}

describe("#13323 — item Vídeos no menu global", () => {
  it("apex: link relativo /videos logo depois de Edições", () => {
    const html = renderSiteNav();
    assert.match(html, /<a href="\/archive">Edições<\/a>\n\s*<a href="\/videos">Vídeos<\/a>/);
  });

  it("host irmão (apexBase): URL absoluta do apex com a UTM de navegação", () => {
    const html = renderSiteNav({ apexBase: DIARIA_APEX_URL });
    assert.match(
      html,
      /<a href="https:\/\/diar\.ia\.br\/videos\?utm_source=diaria-nav&amp;utm_medium=nav&amp;utm_campaign=global-nav">Vídeos<\/a>/,
    );
  });

  it("a página /videos marca o item como ativo (fixture de 3 edições, 1 sem vídeo)", () => {
    const ld = buildVideoObjectJsonLd({ videoId: "aaaaaaaaaaa", name: "Vídeo novo", description: "x.", uploadDate: "2026-11-10T09:00:00Z" });
    const pages: Record<string, string> = {
      nova: `<html><head><title>Edição nova</title>${ld}</head><body>${buildVideoEmbedHtml("aaaaaaaaaaa", "Edição nova")}</body></html>`,
      meio: `<html><head><title>Edição sem vídeo</title></head><body><img src="https://x/y.jpg"></body></html>`,
      velha: `<html><head><title>Edição velha</title></head><body>${buildVideoEmbedHtml("bbbbbbbbbbb", "Edição velha")}</body></html>`,
    };
    const xml = `<urlset>${[["velha", "2026-11-03"], ["meio", "2026-11-05"], ["nova", "2026-11-10"]]
      .map(([s, d]) => `<url><loc>https://diar.ia.br/p/${s}</loc><lastmod>${d}</lastmod></url>`)
      .join("")}</urlset>`;
    const feed = buildVideoFeed(xml, (s) => pages[s] ?? null, Number.POSITIVE_INFINITY, { todayBrt: "2026-11-30" });
    assert.equal(feed.length, 2);
    const html = buildVideosPageHtml(feed);
    assert.match(html, /<a href="\/videos" class="dnav-active" aria-current="page">Vídeos<\/a>/);
    assert.doesNotMatch(html, /class="dnav-active"[^>]*>Edições</);
  });
});

describe("#13323 — refreshSiteNavLinks", () => {
  const variants: Array<[string, Parameters<typeof renderSiteNav>[0]]> = [
    ["apex sem item ativo", { inheritHostTokens: true }],
    ["/p/ com Edições ativo", { active: "edicoes" }],
    ["/assinar (CTA vira span)", { active: "assinar", inheritHostTokens: true }],
    ["host irmão (apexBase)", { apexBase: DIARIA_APEX_URL }],
  ];

  for (const [label, opts] of variants) {
    it(`menu antigo vira o render atual: ${label}`, () => {
      const fresh = page(renderSiteNav(opts));
      const old = withoutVideosItem(fresh);
      assert.notEqual(old, fresh, "fixture precisa simular o menu sem o item");
      assert.equal(refreshSiteNavLinks(old), fresh);
    });
  }

  it("idempotente: página com o menu atual volta idêntica", () => {
    const fresh = page(renderSiteNav({ active: "edicoes" }));
    assert.equal(refreshSiteNavLinks(fresh), fresh);
    assert.equal(refreshSiteNavLinks(refreshSiteNavLinks(withoutVideosItem(fresh))), fresh);
  });

  it("página sem o menu global volta igual", () => {
    const html = page(`<nav class="other"><div class="dnav-links"><a href="/x">X</a></div></nav>`);
    assert.equal(refreshSiteNavLinks(html), html);
  });

  it("não toca o resto da página (CTA, estilo, corpo)", () => {
    const fresh = page(renderSiteNav({ apexBase: DIARIA_APEX_URL }), `<main><div class="dnav-links">fora do nav</div></main>`);
    const old = withoutVideosItem(fresh);
    assert.equal(refreshSiteNavLinks(old), fresh);
  });
});

describe("#13323 — refresh-site-nav.ts (varredura)", () => {
  it("atualiza só as páginas com menu desatualizado e é idempotente", () => {
    const dir = mkdtempSync(join(tmpdir(), "refresh-site-nav-13323-"));
    try {
      mkdirSync(join(dir, "p", "a"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
      const fresh = page(renderSiteNav({ active: "edicoes" }));
      writeFileSync(join(dir, "p", "a", "index.html"), withoutVideosItem(fresh));
      writeFileSync(join(dir, "index.html"), fresh);
      writeFileSync(join(dir, "sem-menu.html"), "<html><body>x</body></html>");
      writeFileSync(join(dir, "node_modules", "x", "index.html"), withoutVideosItem(fresh));

      const dry = refreshSiteNavUnder(dir, { dryRun: true });
      assert.equal(dry.scanned, 3, "node_modules fica fora da varredura");
      assert.equal(dry.withNav, 2);
      assert.deepEqual(dry.changed, [join(dir, "p", "a", "index.html")]);
      assert.notEqual(readFileSync(join(dir, "p", "a", "index.html"), "utf8"), fresh, "dry-run não grava");

      const r = refreshSiteNavUnder(dir);
      assert.equal(r.changed.length, 1);
      assert.equal(readFileSync(join(dir, "p", "a", "index.html"), "utf8"), fresh);
      assert.equal(refreshSiteNavUnder(dir).changed.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13323 — guard: páginas commitadas com o menu atual", () => {
  it("toda página de workers/ com o menu global já tem os itens de NAV_ITEM_DEFS (rode scripts/refresh-site-nav.ts)", () => {
    const stale: string[] = [];
    let withNav = 0;
    for (const file of listHtmlFiles(join(ROOT, "workers"))) {
      const html = readFileSync(file, "utf8");
      if (!html.includes(SITE_NAV_MARKER)) continue;
      withNav++;
      if (refreshSiteNavLinks(html) !== html) stale.push(file.slice(ROOT.length + 1));
    }
    assert.ok(withNav > 300, `esperava >300 páginas com o menu, achei ${withNav}`);
    assert.deepEqual(stale, [], "menu desatualizado: npx tsx scripts/refresh-site-nav.ts");
  });

  it("as páginas commitadas trazem o item Vídeos", () => {
    for (const rel of ["workers/site/public/index.html", "workers/site/public/archive/index.html", "workers/livros/public/index.html"]) {
      assert.match(readFileSync(join(ROOT, rel), "utf8"), />Vídeos<\/a>/, rel);
    }
  });
});
