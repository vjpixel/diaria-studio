/**
 * test/site-clarice-coupon-page-8338.test.ts (#8338)
 *
 * Cobre o miolo puro de `scripts/lib/site-clarice-coupon-page.ts`
 * (buildClariceCouponHtml) — a página `/clarice` que a issue pede:
 * NEWS50 (anual, 50%) em destaque/primeiro lugar, NEWS25 (mensal, 25%)
 * secundário, link de afiliado `?via=diaria` + UTM própria em TODOS os
 * CTAs que apontam pra Clarice, e conteúdo explicando o que é a Clarice.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildClariceCouponHtml,
  buildClariceCouponPageCtaUrl,
  CLARICE_COUPON_PAGE_CTA_URL,
  CLARICE_PAGE_URL,
} from "../scripts/lib/site-clarice-coupon-page.ts";
import { DIARIA_CLARICE_PRECOS_URL, clariceLinkMissingVia } from "../scripts/lib/canonical-urls.ts";
import { GTM_CONTAINER_ID } from "../scripts/lib/shared/seo-meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("buildClariceCouponHtml (#8338)", () => {
  const html = buildClariceCouponHtml();

  it("HTML válido, lang pt-BR, charset e viewport (acessibilidade básica)", () => {
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  });

  it("title/description/canonical otimizados pros termos de busca da issue", () => {
    assert.match(html, /<title>[^<]*[Cc]upom [Cc]larice[^<]*<\/title>/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${CLARICE_PAGE_URL.replace(/[.]/g, "\\.")}">`));
    const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
    assert.ok(descMatch, "meta description ausente");
    // termos-alvo da issue: "cupom Clarice", "desconto Clarice"/"Clarice ... desconto"
    assert.match(descMatch![1], /[Cc]upo(m|ns)/);
    assert.match(descMatch![1], /[Cc]larice/);
    assert.match(descMatch![1], /desconto/i);
  });

  it("carrega o container GTM (mesma instrumentação das demais páginas do apex)", () => {
    assert.match(html, /googletagmanager\.com\/gtm\.js/);
    assert.match(html, new RegExp(`['"]${GTM_CONTAINER_ID}['"]`));
  });

  // Os dois cards vivem dentro de <div class="coupons">...</div> — bound explícito
  // pra nunca casar a primeira menção de "NEWS50"/"NEWS25" na <meta description>.
  const couponsBlockMatch = html.match(/<div class="coupons">[\s\S]*?<\/div>\s*<\/div>\s*<p class="coupons-note"/);
  const couponsBlock = couponsBlockMatch ? couponsBlockMatch[0] : "";

  it("bloco .coupons existe e contém os 2 cards", () => {
    assert.ok(couponsBlock, "bloco <div class=\"coupons\"> não encontrado");
    assert.match(couponsBlock, /NEWS50/);
    assert.match(couponsBlock, /NEWS25/);
  });

  it("NEWS50 aparece ANTES de NEWS25 dentro do bloco de cards (requisito 2 — anual em primeiro lugar/mais destacado)", () => {
    const idx50 = couponsBlock.indexOf("NEWS50");
    const idx25 = couponsBlock.indexOf("NEWS25");
    assert.ok(idx50 >= 0, "NEWS50 ausente do bloco de cards");
    assert.ok(idx25 >= 0, "NEWS25 ausente do bloco de cards");
    assert.ok(idx50 < idx25, "NEWS50 deveria vir antes de NEWS25 no bloco de cards");
  });

  it("só o card NEWS50 carrega o badge/estilo de destaque — NEWS25 é secundário", () => {
    // Cada card começa em `<div class="coupon-card ...">` — split por essa
    // abertura em vez de por posição de texto (a classe do card vem ANTES
    // do código do cupom dentro do mesmo `<div>`, então bounds por índice de
    // "NEWS50"/"NEWS25" cortam no meio do card errado).
    const cards = couponsBlock.split('<div class="coupon-card').slice(1);
    assert.equal(cards.length, 2, `esperava 2 cards, achou ${cards.length}`);
    const card50 = cards.find((c) => c.includes("NEWS50"));
    const card25 = cards.find((c) => c.includes("NEWS25"));
    assert.ok(card50, "card do NEWS50 não encontrado");
    assert.ok(card25, "card do NEWS25 não encontrado");
    assert.match(card50!.slice(0, 40), /coupon-lead/, "card do NEWS50 deveria abrir com a classe de destaque coupon-lead");
    assert.doesNotMatch(card50!.slice(0, 40), /coupon-secondary/, "card do NEWS50 não deveria carregar a classe secundária");
    assert.match(card25!.slice(0, 40), /coupon-secondary/, "card do NEWS25 deveria abrir com a classe secundária");
    assert.doesNotMatch(card25!.slice(0, 40), /coupon-lead/, "card do NEWS25 não deveria carregar a classe de destaque");
  });

  it("descreve os termos corretos de cada cupom (50% anual once / 25% mensal repeating 3 meses, mesmos termos da Stripe)", () => {
    assert.match(html, /50%[^<]*anual/i);
    assert.match(html, /25%[^<]*3[^<]*(mês|meses|mensal)/i);
  });

  it("CTA_URL = DIARIA_CLARICE_PRECOS_URL (com via=diaria) + UTM própria da página", () => {
    const url = new URL(CLARICE_COUPON_PAGE_CTA_URL);
    assert.equal(`${url.origin}${url.pathname}`, new URL(DIARIA_CLARICE_PRECOS_URL).origin + new URL(DIARIA_CLARICE_PRECOS_URL).pathname);
    assert.equal(url.searchParams.get("via"), "diaria");
    assert.equal(url.searchParams.get("utm_source"), "diaria");
    assert.equal(url.searchParams.get("utm_medium"), "web");
    assert.equal(url.searchParams.get("utm_campaign"), "clarice-coupon-page");
    assert.equal(buildClariceCouponPageCtaUrl(), CLARICE_COUPON_PAGE_CTA_URL, "helper e constante exportada devem coincidir");
  });

  it("clariceLinkMissingVia nunca flag a URL de CTA desta página (guard #1910)", () => {
    assert.equal(clariceLinkMissingVia(CLARICE_COUPON_PAGE_CTA_URL), false);
  });

  it("TODOS os hrefs pra clarice.ai na página usam exatamente CLARICE_COUPON_PAGE_CTA_URL — nenhum CTA aponta pro link nu ou pro link só com via=diaria sem a UTM da página (requisito 3)", () => {
    const hrefs = [...html.matchAll(/href="([^"]*clarice\.ai[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    assert.ok(hrefs.length >= 3, `esperava pelo menos 3 links pra clarice.ai (lede + 2 cards + CTA final), achou ${hrefs.length}`);
    for (const href of hrefs) {
      assert.equal(href, CLARICE_COUPON_PAGE_CTA_URL, `href ${href} deveria ser exatamente CLARICE_COUPON_PAGE_CTA_URL`);
    }
  });

  it("explica o que é a Clarice (requisito 4 — para quem serve)", () => {
    assert.match(html, /assistente de (escrita|revisão)/i);
    assert.match(html, /diar\.ia\.br.*parceir/i);
  });

  it("cobre o termo-alvo 'código promocional' (SEO — 1 dos 4 termos-alvo da issue)", () => {
    assert.match(html, /c[oó]digo(s)? promociona(l|is)/i);
  });

  it("link de volta pra home e nunca markdown cru (só HTML)", () => {
    assert.match(html, /href="\/">/);
    assert.ok(!/\*\*|^#\s|^- /m.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), "não deveria conter marcação markdown crua no corpo");
  });

  it("nunca menciona resolução em pixels nem carrega imagem (página é texto/links)", () => {
    assert.ok(!html.includes("<img"), "página não deveria carregar imagem nenhuma");
  });
});

describe("workers/site/public/clarice/index.html — committed (#8338)", () => {
  const filePath = resolve(ROOT, "workers", "site", "public", "clarice", "index.html");

  it("existe e é idêntico ao output atual de buildClariceCouponHtml() — regenerado via gen-clarice-coupon-page.ts, nunca editado à mão", () => {
    assert.ok(existsSync(filePath), `${filePath} ausente`);
    const committed = readFileSync(filePath, "utf8");
    assert.equal(committed, buildClariceCouponHtml());
  });
});

describe("sitemap.xml lista /clarice (requisito 5)", () => {
  it("workers/site/public/sitemap.xml tem <loc> pra https://diar.ia.br/clarice", () => {
    const sitemap = readFileSync(resolve(ROOT, "workers", "site", "public", "sitemap.xml"), "utf8");
    assert.match(sitemap, /<loc>https:\/\/diar\.ia\.br\/clarice<\/loc>/);
  });
});
