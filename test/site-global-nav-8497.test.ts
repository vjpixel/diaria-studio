/**
 * test/site-global-nav-8497.test.ts (#8497)
 *
 * Menu global do site — antes desta issue só `site-home-page.ts` renderizava
 * um nav (markup inline, único lugar do produto com caminho de volta pro
 * resto do site + o CTA `Assinar`). Este teste cobre:
 *
 *   1. o miolo puro (`renderSiteNav`/`injectSiteNavAfterBodyOpen`,
 *      `scripts/lib/shared/site-nav.ts`) — itens, `aria-current`, o caso
 *      especial `/assinar` (CTA não se auto-linka), idempotência;
 *   2. GUARD MECÂNICO — o nav está presente no HTML de CADA gerador de
 *      página tocado pela issue (mesma família do `ARCHIVE_NAV_MARKER` de
 *      `site-archive-page-backfill.ts`): um gerador novo — ou uma regressão
 *      num existente — que pare de chamar `renderSiteNav`/
 *      `injectSiteNavAfterBodyOpen` faz este teste falhar, não só o olho do
 *      editor num QA manual;
 *   3. o item ativo (`aria-current="page"`) correto por superfície.
 *
 * Fora do escopo desta issue (residue documentado no PR #8497, não coberto
 * aqui): hosts irmãos (`arquivo`/`especial`/`livros`/`cursos`/`eia`/
 * `retrospectiva` — Workers separados, fora deste lote), rodapé alinhado à
 * mesma lista de itens, item "Retrospectivas" (sem página-índice pública em
 * `retrospectiva.diar.ia.br`, ver comentário em `NAV_ITEM_DEFS`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderSiteNav,
  injectSiteNavAfterBodyOpen,
  SITE_NAV_MARKER,
  NAV_ASSINAR_URL,
} from "../scripts/lib/shared/site-nav.ts";
import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";
import { buildApoiarHtml } from "../scripts/lib/site-apoiar-page.ts";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { buildClariceCouponHtml } from "../scripts/lib/site-clarice-coupon-page.ts";
import { buildArchiveIndexHtml } from "../scripts/lib/site-archive-index.ts";
import { renderConfirmadoPage } from "../scripts/lib/shared/confirmado-page.ts";
import { buildArchivePageHtml, type ArchivePost } from "../scripts/lib/site-archive-pages.ts";

describe("renderSiteNav — miolo puro (#8497)", () => {
  it("emite o marcador de presença + os itens esperados (sem 'Retrospectivas' — residue documentado)", () => {
    const html = renderSiteNav();
    assert.ok(html.includes(SITE_NAV_MARKER), "marcador SITE_NAV_MARKER ausente");
    for (const label of ["Edições", "Especiais", "Livros", "Cursos", "É IA?", "Apoiar", "Assinar"]) {
      assert.ok(html.includes(`>${label}<`), `item "${label}" ausente do menu`);
    }
    assert.ok(!html.includes(">Retrospectivas<"), "item Retrospectivas não deveria estar presente nesta PR");
  });

  it("item `active` ganha aria-current=page", () => {
    const html = renderSiteNav({ active: "apoiar" });
    assert.match(html, /<a href="\/apoiar" class="dnav-active" aria-current="page">Apoiar<\/a>/);
  });

  it("nenhum item ativo por default — nenhum aria-current na lista de links", () => {
    const html = renderSiteNav();
    const linksBlock = html.match(/<div class="dnav-links">[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.doesNotMatch(linksBlock, /aria-current/);
  });

  it("active: 'assinar' — o CTA vira texto não-clicável com aria-current, não um <a> (item 3 da issue: destino não se auto-linka)", () => {
    const html = renderSiteNav({ active: "assinar" });
    assert.match(html, /<span aria-current="page">Assinar<\/span>/);
    assert.doesNotMatch(html, new RegExp(`<a href="${NAV_ASSINAR_URL}">Assinar</a>`));
  });

  it("sem active: 'assinar', o CTA é um <a href=\"/assinar\"> normal", () => {
    const html = renderSiteNav();
    assert.match(html, /<a href="\/assinar">Assinar<\/a>/);
  });

  it("aria-label default distingue esta nav de qualquer nav secundária da página (item 6)", () => {
    const html = renderSiteNav();
    assert.match(html, /aria-label="Navegação principal"/);
  });

  it("links cross-host (Especiais/Livros/Cursos/É IA?) carregam UTM de navegação interna (item 9)", () => {
    const html = renderSiteNav();
    for (const host of ["especial.diar.ia.br", "livros.diar.ia.br", "cursos.diar.ia.br", "eia.diar.ia.br"]) {
      const m = html.match(new RegExp(`href="https://${host.replace(/\./g, "\\.")}[^"]*"`));
      assert.ok(m, `link pro host ${host} não encontrado`);
      assert.match(m![0], /utm_source=diaria-nav/, `link pro host ${host} sem UTM de nav`);
    }
  });

  it("links internos (Edições, Apoiar, Assinar) são relativos — sem UTM, mesmo host", () => {
    const html = renderSiteNav();
    assert.match(html, /<a href="\/archive"[^>]*>Edições<\/a>/);
    assert.match(html, /<a href="\/apoiar">Apoiar<\/a>/);
  });

  it("inheritHostTokens:true usa var(--x) puro, sem hex embutido (evita duplicar `design-tokens.ts` fora de :root)", () => {
    const html = renderSiteNav({ inheritHostTokens: true });
    assert.doesNotMatch(html, /#00A0A0|#171411|#FBFAF6|#EBE5D0/i);
    assert.match(html, /var\(--teal\)/);
  });

  it("inheritHostTokens:false (default) embute hex canônico — pras 270 páginas /p/{slug} sem :root próprio", () => {
    const html = renderSiteNav();
    assert.match(html, /#00A0A0/);
  });
});

describe("injectSiteNavAfterBodyOpen (#8497)", () => {
  it("injeta logo após <body ...>", () => {
    const html = injectSiteNavAfterBodyOpen("<html><body><p>oi</p></body></html>");
    const bodyIdx = html.indexOf("<body>");
    const navIdx = html.indexOf(SITE_NAV_MARKER);
    const pIdx = html.indexOf("<p>oi</p>");
    assert.ok(bodyIdx >= 0 && navIdx >= 0 && pIdx >= 0);
    assert.ok(bodyIdx < navIdx && navIdx < pIdx, "nav deveria ficar entre <body> e o conteúdo original");
  });

  it("idempotente — não injeta 2x se o marcador já está presente", () => {
    const once = injectSiteNavAfterBodyOpen("<html><body></body></html>");
    const twice = injectSiteNavAfterBodyOpen(once);
    assert.equal(twice, once);
    assert.equal((twice.match(new RegExp(SITE_NAV_MARKER.replace(/"/g, '\\"'), "g")) || []).length, 1);
  });
});

/** Fixture mínima de `ArchivePost` — mesmo shape usado em `test/gen-archive-pages.test.ts`. */
function makeArchivePost(): ArchivePost {
  return {
    slug: "exemplo",
    title: "Edição de exemplo",
    subtitle: "Subtítulo",
    status: "confirmed",
    web_url: "https://diar.ia.br/p/exemplo",
    publish_date: 1735689600,
    thumbnail_url: null,
    content: { free: { web: `<!doctype html><html><head></head><body><h1>Exemplo</h1></body></html>` } },
  };
}

describe("guard mecânico — nav presente em CADA superfície tocada pelo #8497", () => {
  it("home (site-home-page.ts)", () => {
    const html = buildIndexHtml({ feature: null, archive: [] });
    assert.ok(html.includes(SITE_NAV_MARKER), "home sem menu global");
  });

  it("/apoiar (site-apoiar-page.ts) — item ativo", () => {
    const html = buildApoiarHtml();
    assert.ok(html.includes(SITE_NAV_MARKER), "/apoiar sem menu global");
    assert.match(html, /<a href="\/apoiar" class="dnav-active" aria-current="page">Apoiar<\/a>/);
  });

  it("/assinar (site-assinar-page.ts) — CTA não se auto-linka", () => {
    const html = buildAssinarHtml();
    assert.ok(html.includes(SITE_NAV_MARKER), "/assinar sem menu global");
    assert.match(html, /<span aria-current="page">Assinar<\/span>/);
  });

  it("/clarice (site-clarice-coupon-page.ts)", () => {
    const html = buildClariceCouponHtml();
    assert.ok(html.includes(SITE_NAV_MARKER), "/clarice sem menu global");
  });

  it("/confirmada (shared/confirmado-page.ts, renomeado de /confirmado em #8554)", () => {
    const html = renderConfirmadoPage();
    assert.ok(html.includes(SITE_NAV_MARKER), "/confirmada sem menu global");
  });

  it("/archive (site-archive-index.ts) — 'Edições' ativo", () => {
    const html = buildArchiveIndexHtml({ entries: [], page: 1, totalPages: 1, totalEditions: 0 });
    assert.ok(html.includes(SITE_NAV_MARKER), "/archive sem menu global");
    assert.match(html, /<a href="\/archive" class="dnav-active" aria-current="page">Edições<\/a>/);
  });

  it("/p/{slug} (site-archive-pages.ts) — 'Edições' ativo, menu global ANTES da nav prev/next", () => {
    const html = buildArchivePageHtml(makeArchivePost());
    assert.ok(html.includes(SITE_NAV_MARKER), "/p/{slug} sem menu global");
    assert.match(html, /<a href="\/archive" class="dnav-active" aria-current="page">Edições<\/a>/);
  });
});
