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
 * Estendido pelo #8497 residual (hosts irmãos): a PR original (#8503) só
 * cobria o apex (`diar.ia.br`). Este arquivo ganhou:
 *
 *   4. `apexBase` — o modo de `renderSiteNav`/`injectSiteNavAfterBodyOpen`
 *      usado por todo host IRMÃO (URLs absolutas pro apex + UTM);
 *   5. `renderSiteFooterLinks` — rodapé derivado da MESMA lista de itens;
 *   6. GUARD MECÂNICO estendido aos geradores dos hosts irmãos tocados pelo
 *      residual: `arquivo` (`render-archive.ts`, `hub-page.ts`,
 *      `hub-index-page.ts`), `especial` (`entity-page.ts`, home estática e
 *      artigos completos de `workers/artigos`), `cursos`
 *      (`build-cursos-page.ts`), `livros` (`build-livros-page.ts`).
 *
 * Ainda fora do escopo (documentado no PR do residual, REFS não closes):
 * `eia`/`workers/poll` — Worker MULTI-BRAND (diaria/clarice/web/mensal-*,
 * ver `Brand` em `workers/poll/src/lib.ts`) — aplicar a nav do apex sem um
 * gate por `brand === "diaria"` vazaria branding diar.ia.br pras páginas
 * `brand=clarice`, e nenhuma unidade deste lote garantia esse gate; `/gate`
 * (artigos/cursos) — tela transacional de confirmação de e-mail, não uma
 * superfície de descoberta; item "Retrospectivas"/host `retrospectiva` (sem
 * página-índice pública, ver comentário em `NAV_ITEM_DEFS`); "/curadoria" —
 * não existe como rota literal em nenhum Worker do repo (o termo "curadoria"
 * no código é só um rótulo genérico pra família arquivo/cursos/livros/eia,
 * já coberta pelos itens acima sob os próprios nomes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  renderSiteNav,
  injectSiteNavAfterBodyOpen,
  renderSiteFooterLinks,
  SITE_NAV_MARKER,
  NAV_ASSINAR_URL,
  DIARIA_APEX_URL,
} from "../scripts/lib/shared/site-nav.ts";
import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { buildClariceCouponHtml } from "../scripts/lib/site-clarice-coupon-page.ts";
import { buildArchiveIndexHtml } from "../scripts/lib/site-archive-index.ts";
import { renderConfirmadoPage } from "../scripts/lib/shared/confirmado-page.ts";
import { buildArchivePageHtml, type ArchivePost } from "../scripts/lib/site-archive-pages.ts";
import { buildArchiveHtml } from "../workers/arquivo/src/render-archive.ts";
import type { SitemapEntry } from "../scripts/lib/fetch-sitemap.ts";
import { renderHubPage } from "../scripts/lib/shared/hub-page.ts";
import { renderHubIndexPage, renderHubNotFoundPage, type HubIndexEntry } from "../scripts/lib/shared/hub-index-page.ts";
import { renderEntityPage } from "../scripts/lib/shared/entity-page.ts";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import { ENTITY_LOADERS } from "../scripts/build-entity-page.ts";
import { renderCursosPage, type Course } from "../scripts/build-cursos-page.ts";
import { renderLivrosPage, type Book } from "../scripts/build-livros-page.ts";

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
    assert.match(html, /<a href="\/apoiar\/ir" class="dnav-active" aria-current="page">Apoiar<\/a>/);
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
    assert.match(html, /<a href="\/apoiar\/ir">Apoiar<\/a>/);
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

describe("apexBase (#8497 residual — hosts irmãos)", () => {
  it("sem apexBase (default): itens relativos ficam relativos — comportamento do apex preservado", () => {
    const html = renderSiteNav();
    assert.match(html, /<a href="\/archive"[^>]*>Edições<\/a>/);
    assert.match(html, /<a href="\/apoiar\/ir">Apoiar<\/a>/);
    assert.match(html, /<a href="\/assinar">Assinar<\/a>/);
  });

  it("com apexBase: itens antes relativos viram absolutos, com a MESMA UTM dos itens cross-host", () => {
    const html = renderSiteNav({ apexBase: DIARIA_APEX_URL });
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/archive\?utm_source=diaria-nav[^"]*"[^>]*>Edições<\/a>/);
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/apoiar\/ir\?utm_source=diaria-nav[^"]*">Apoiar<\/a>/);
  });

  it("com apexBase: o CTA Assinar também vira absoluto+UTM", () => {
    const html = renderSiteNav({ apexBase: DIARIA_APEX_URL });
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/assinar\?utm_source=diaria-nav[^"]*">Assinar<\/a>/);
  });

  it("com apexBase: itens JÁ cross-host (especiais/livros/cursos/eia) não mudam — continuam apontando pro próprio host deles", () => {
    const semBase = renderSiteNav();
    const comBase = renderSiteNav({ apexBase: DIARIA_APEX_URL });
    for (const host of ["especial.diar.ia.br", "livros.diar.ia.br", "cursos.diar.ia.br", "eia.diar.ia.br"]) {
      const re = new RegExp(`href="https://${host.replace(/\./g, "\\.")}[^"]*"`);
      assert.equal(semBase.match(re)?.[0], comBase.match(re)?.[0], `link pro host ${host} não deveria mudar com apexBase`);
    }
  });

  it("injectSiteNavAfterBodyOpen repassa apexBase pro renderSiteNav interno", () => {
    const html = injectSiteNavAfterBodyOpen("<html><body></body></html>", { apexBase: DIARIA_APEX_URL });
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/archive/);
  });
});

describe("renderSiteFooterLinks (#8497 item residual 8 — rodapé alinhado)", () => {
  it("emite os 5 links esperados, na mesma ordem histórica do rodapé da home", () => {
    const html = renderSiteFooterLinks();
    const labels = [...html.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["É IA?", "Arquivo", "Especial", "Apoiar", "Privacidade"]);
  });

  it("'É IA?' e 'Especial' reusam o MESMO href dos itens 'eia'/'especiais' do menu do topo — nunca uma 2ª cópia literal da URL", () => {
    const nav = renderSiteNav();
    const footer = renderSiteFooterLinks();
    const eiaHrefInNav = nav.match(/href="([^"]+)">É IA\?<\/a>/)?.[1];
    const eiaHrefInFooter = footer.match(/href="([^"]+)">É IA\?<\/a>/)?.[1];
    assert.ok(eiaHrefInNav && eiaHrefInNav === eiaHrefInFooter, "href de 'É IA?' divergiu entre nav e rodapé");
    const especialHrefInFooter = footer.match(/href="([^"]+)">Especial<\/a>/)?.[1];
    assert.match(especialHrefInFooter ?? "", /^https:\/\/especial\.diar\.ia\.br/);
  });

  it("'Apoiar' reusa o mesmo destino relativo `/apoiar/ir` do menu do topo", () => {
    const html = renderSiteFooterLinks();
    assert.match(html, /<a href="\/apoiar\/ir">Apoiar<\/a>/);
  });

  it("com apexBase: 'Apoiar' (único relativo) vira absoluto+UTM — mesmo critério de resolveNavHref", () => {
    const html = renderSiteFooterLinks({ apexBase: DIARIA_APEX_URL });
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/apoiar\/ir\?utm_source=diaria-nav[^"]*">Apoiar<\/a>/);
  });

  it("home (site-home-page.ts) consome renderSiteFooterLinks — não mantém mais os 5 <a> hardcoded", () => {
    const html = buildIndexHtml({ feature: null, archive: [] });
    assert.ok(html.includes(renderSiteFooterLinks()), "rodapé da home divergiu de renderSiteFooterLinks()");
  });
});

describe("guard mecânico — hosts irmãos (#8497 residual, exceto eia/poll e retrospectiva)", () => {
  it("arquivo (render-archive.ts) — nav com apexBase, sem item ativo (sem SiteNavKey própria pro host)", () => {
    const entries: SitemapEntry[] = [{ loc: "https://diar.ia.br/p/exemplo", lastmod: "2026-07-27" }];
    const html = buildArchiveHtml(entries);
    assert.ok(html.includes(SITE_NAV_MARKER), "arquivo sem menu global");
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/archive/, "nav do arquivo deveria apontar pro apex, absoluto");
  });

  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`arquivo/temas/${slug} (hub-page.ts via HUB_LOADERS)`, () => {
      const html = renderHubPage(HUB_LOADERS[slug]());
      assert.ok(html.includes(SITE_NAV_MARKER), `hub ${slug} sem menu global`);
    });
  }

  it("arquivo/temas/ (hub-index-page.ts — índice)", () => {
    const entries: HubIndexEntry[] = [
      { slug: "exemplo", label: "Exemplo", metaDescription: "Descrição.", coverageLabel: "julho de 2026 a agosto de 2026" },
    ];
    const html = renderHubIndexPage(entries);
    assert.ok(html.includes(SITE_NAV_MARKER), "índice de temas sem menu global");
  });

  it("arquivo/temas/{inexistente} (hub-index-page.ts — 404)", () => {
    const html = renderHubNotFoundPage();
    assert.ok(html.includes(SITE_NAV_MARKER), "404 de tema sem menu global");
  });

  for (const slug of Object.keys(ENTITY_LOADERS)) {
    it(`especial/entidades/${slug} (entity-page.ts via ENTITY_LOADERS)`, () => {
      const html = renderEntityPage(ENTITY_LOADERS[slug]());
      assert.ok(html.includes(SITE_NAV_MARKER), `entidade ${slug} sem menu global`);
    });
  }

  it("cursos (build-cursos-page.ts)", () => {
    const course: Course = {
      id: "c1", title: "Curso Teste", platform: "Coursera", url: "https://www.coursera.org/learn/x",
      language: "pt-br", level: "iniciante", format: "video", duration_hours: 3, cost: "free",
      certificate: true, themes: ["Fundamentos"], summary: "Resumo.",
    };
    const html = renderCursosPage([course]);
    assert.ok(html.includes(SITE_NAV_MARKER), "cursos sem menu global");
  });

  it("livros (build-livros-page.ts)", () => {
    const book: Book = {
      id: "b1", title: "Livro Teste", link: "https://amzn.to/abc123", language: "pt-br",
      level: "iniciante", themes: ["História"], rating: 4.5, highlight: "Bestseller.", summary: "Resumo.",
    };
    const html = renderLivrosPage([book]);
    assert.ok(html.includes(SITE_NAV_MARKER), "livros sem menu global");
  });

  it("especial home (workers/artigos/public/index.html — página estática, sem builder TS)", () => {
    const html = readFileSync("workers/artigos/public/index.html", "utf8");
    assert.ok(html.includes(SITE_NAV_MARKER), "home do especial sem menu global");
  });

  it("especial artigos completos (workers/artigos/articles-src/*.html — fonte editável do gate)", () => {
    for (const slug of ["o-agente", "engenharia-de-ilusao"]) {
      const html = readFileSync(`workers/artigos/articles-src/${slug}.html`, "utf8");
      assert.ok(html.includes(SITE_NAV_MARKER), `artigo ${slug} sem menu global`);
    }
  });
});
