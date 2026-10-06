/**
 * test/publish-edition-site-page-arrow-9721.test.ts (#9721, review do PR #9724, finding P2)
 *
 * Regressão: o check `check-no-arrow-glyph` reprova qualquer `→` em
 * `workers/site/public/**`, e a página de uma edição nova sai por PR
 * automático (`publish-edition-site-page.ts`, auto-merge #8158). Uma seta
 * EDITORIAL no texto de um destaque (`5,4% → 18%`) passava intacta pelo
 * render e travava esse PR no CI, deixando `/p/{slug}` em 404.
 *
 * Invariante: a página que `publishEditionSitePage` grava passa no MESMO
 * scanner do check de CI (`scanPublishedText`, com allowlist vazia), para
 * qualquer seta no título, no corpo ou em posição de CTA.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publishEditionSitePage, type PublishPageDeps } from "../scripts/publish-edition-site-page.ts";
import type { EditionPageInputs } from "../scripts/lib/edition-site-page.ts";
import { scanPublishedText } from "../scripts/lib/no-arrow-glyph-scan.ts";
import { normalizeArrowsForSite, ARROW_GLYPH } from "../scripts/lib/shared/arrow-glyph.ts";
import { buildArchivePageHtml } from "../scripts/lib/site-archive-pages.ts";

const SLUG = "gemini-sobe-de-5-para-18";
const PAGE_PATH = `workers/site/public/p/${SLUG}/index.html`;

const INPUTS_COM_SETA: EditionPageInputs = {
  html: [
    "<p>Gemini: 5,4% → <b>18%</b> do tráfego.</p>",
    "<p>Fatia do ChatGPT: 87% → 68%, segundo a Similarweb.</p>",
    '<p>Antes 5,4% → <a href="https://exemplo.com/a">18%</a> agora.</p>',
    "<p>Fluxo: prompt → modelo → resposta.</p>",
    '<p>Veja o ranking → <a href="https://exemplo.com/r">aqui</a></p>',
    '<p><a href="https://exemplo.com/l">Leia mais →</a></p>',
    '<p>→ <a href="https://exemplo.com/c">Garanta seu ingresso</a></p>',
  ].join("\n"),
  postUrl: `https://diar.ia.br/p/${SLUG}`,
  title: "Gemini → 18% do tráfego",
  subtitle: "ChatGPT cai de 87% → 68%",
  publishedAtIso: "2026-10-07T09:00:00Z",
};

function runPublish(inputs: EditionPageInputs): string {
  const escritas: string[] = [];
  const deps: PublishPageDeps = {
    readEditionInputs: () => inputs,
    writePage: (_slug, html) => void escritas.push(html),
    publish: () => ({ pushed: true, prUrl: "https://github.com/vjpixel/diaria-studio/pull/1", prNumber: 1, prCreated: true }),
    log: () => {},
  };
  const r = publishEditionSitePage("/x", deps, { skipPublish: true });
  assert.equal(r.code, 0, `publish devia ter sucesso: ${JSON.stringify(r)}`);
  assert.equal(escritas.length, 1);
  return escritas[0];
}

describe("#9721 página /p/ de edição com seta passa no check-no-arrow-glyph", () => {
  it("REGRESSÃO: a página gravada não tem nenhuma seta (mesmo scanner do CI, sem allowlist)", () => {
    const html = runPublish(INPUTS_COM_SETA);
    assert.deepEqual(scanPublishedText(PAGE_PATH, html, []), []);
    assert.ok(!html.includes(ARROW_GLYPH));
  });

  it("transição numérica vira 'para', inclusive com tag inline ou link no meio", () => {
    const html = runPublish(INPUTS_COM_SETA);
    assert.match(html, /5,4% para <b>18%<\/b>/);
    assert.match(html, /87% para 68%/);
    // o lead-in de CTA (`texto → <a>` vira `texto: <a>`) não pode trocar o sentido
    assert.match(html, /5,4% para <a href="https:\/\/exemplo\.com\/a">18%<\/a>/);
    assert.doesNotMatch(html, /5,4%: /);
  });

  it("CTA perde a seta pelo mesmo critério da newsletter; encadeamento editorial vira meia-risca", () => {
    const html = runPublish(INPUTS_COM_SETA);
    assert.match(html, />Leia mais<\/a>/);
    assert.match(html, /<p><a href="https:\/\/exemplo\.com\/c">Garanta seu ingresso<\/a>/);
    assert.match(html, /Veja o ranking: <a/);
    assert.match(html, /prompt – modelo – resposta/);
  });

  it("título (<title>/JSON-LD/meta) também sai sem seta", () => {
    const html = runPublish(INPUTS_COM_SETA);
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    assert.ok(!title.includes(ARROW_GLYPH), title);
    assert.ok(title.includes("Gemini"), title);
  });

  it("gerador em lote (buildArchivePageHtml) aplica a mesma normalização", () => {
    const html = buildArchivePageHtml({
      slug: SLUG,
      title: "A → B",
      subtitle: null,
      status: "confirmed",
      web_url: `https://diar.ia.br/p/${SLUG}`,
      publish_date: 1791190800,
      content: { free: { web: "<!doctype html><html><head></head><body><p>1 → 2</p></body></html>" } },
    });
    assert.deepEqual(scanPublishedText(PAGE_PATH, html, []), []);
  });
});

describe("#9721 normalizeArrowsForSite", () => {
  it("é idempotente e não toca texto sem seta", () => {
    const sem = "<p>nada aqui</p>";
    assert.equal(normalizeArrowsForSite(sem), sem);
    const once = normalizeArrowsForSite(INPUTS_COM_SETA.html);
    assert.equal(normalizeArrowsForSite(once), once);
  });

  it("seta solta (sem espaço em volta) vira meia-risca", () => {
    assert.equal(normalizeArrowsForSite("A→B"), "A–B");
  });
});
