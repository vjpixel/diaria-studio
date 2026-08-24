/**
 * test/render-newsletter-5176-calibration.test.ts
 *
 * Regressão dedicada à calibragem #5176 (260812-260813): parâmetros de
 * espaçamento do e-mail diário (issue #5176), com os 3 pontos de decisão
 * do editor (briefing 260813) já resolvidos — container 656px, recuo
 * lateral 16px, paridade mobile Beehiiv×Brevo via inline.
 *
 * Cobre o comportamento NOVO que os testes já existentes (atualizados nesta
 * mesma PR pros novos valores literais) não isolam explicitamente:
 *   1. Headings estruturais via o truque `<a><h2>`/`<a><h3>` (o `<a>` por
 *      FORA do heading) — manchete e item de Radar/Use melhor/Lançamentos.
 *   2. `pPad`/margem de parágrafo do corpo do destaque CONDICIONAIS ao
 *      `esp` (Beehiiv vs Brevo).
 *   3. Largura do container/seções calibrada (656px container, 16px recuo
 *      lateral) e o mesmo recuo emitido IGUAL em desktop/mobile.
 *   4. Limiares dos lints `checkWideTables`/`checkHtmlSize` acompanhando a
 *      calibragem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderHeadlineInner,
  renderSectionItem,
  renderBodyParasInner,
  renderHTML,
  DS_STYLE_BLOCK,
} from "../scripts/lib/newsletter-render-html.ts";
import { LAYOUT } from "../scripts/lib/shared/design-tokens.ts";
import { checkWideTables, checkHtmlSize } from "../scripts/lint-newsletter-html.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

describe("#5176 — headings estruturais via <a><h2>/<a><h3>", () => {
  it("renderHeadlineInner: <a> por FORA do <h2> (não <h2><a>)", () => {
    const html = renderHeadlineInner("Título do destaque", "https://example.com/d1");
    // A ordem correta é <a ...><h2 ...>texto</h2></a> — o <a> abre primeiro.
    assert.match(html, /^<a class="headline"[^>]*><h2[^>]*>Título do destaque<\/h2><\/a>$/);
    // Nunca o inverso.
    assert.doesNotMatch(html, /<h2[^>]*><a\b/);
  });

  it("renderHeadlineInner: <h2> carrega a tipografia (font-family/size/line-height), <a> carrega layout/cor/sublinhado", () => {
    const html = renderHeadlineInner("Título", "https://example.com/d1");
    const h2Match = html.match(/<h2 style="([^"]+)">/);
    assert.ok(h2Match, "h2 deve existir com style próprio");
    assert.match(h2Match![1], /font-size:26px/);
    assert.match(h2Match![1], /color:inherit/, "h2 herda a cor do <a>, não reafirma");
    const aMatch = html.match(/<a class="headline"[^>]*style="([^"]+)"/);
    assert.ok(aMatch, "a deve existir com style próprio");
    assert.match(aMatch![1], /text-decoration:underline/);
    assert.match(aMatch![1], /text-decoration-color:#00A0A0/);
  });

  it("renderSectionItem (com url): <a> por FORA do <h3>, sublinhado via text-decoration (não border-bottom)", () => {
    const html = renderSectionItem(
      { title: "Item do Radar", url: "https://example.com/radar-item", description: null },
      true,
    );
    assert.match(html, /<a[^>]*><h3[^>]*>Item do Radar<\/h3><\/a>/);
    assert.doesNotMatch(html, /<h3[^>]*><a\b/, "nunca <h3><a> — quebraria o sublinhado (#5176)");
    assert.match(html, /text-decoration:underline/);
    assert.doesNotMatch(html, /border-bottom:1px solid #00A0A0/, "sublinhado migrou de border-bottom pra text-decoration");
  });

  it("renderSectionItem (sem url): <h3> standalone, sem <a> (nada a sublinhar)", () => {
    const html = renderSectionItem({ title: "Item sem link", url: null, description: null } as any, true);
    assert.match(html, /<h3[^>]*>Item sem link<\/h3>/);
    assert.doesNotMatch(html, /<a\b/);
  });

  it("renderSectionItem: font-size do <h3> é LAYOUT.radarSize (22px — NÃO os 20px do JSON bruto calibrado, ver design-tokens.ts)", () => {
    const html = renderSectionItem({ title: "X", url: "https://x.com", description: null }, true);
    assert.match(html, new RegExp(`font-size:${LAYOUT.radarSize}px`));
    assert.equal(LAYOUT.radarSize, 22, "radarSize deve ficar em 22 — 20 conflita com o type-scale travado ({12,16,22,26}px)");
  });
});

describe("#5176 — pPad/margem do corpo do destaque condicionais ao esp", () => {
  it("esp beehiiv (default): <p> ganha padding:4px 0 (compensa o padding que o Beehiiv injeta) + margem 8px entre parágrafos", () => {
    const html = renderBodyParasInner("Parágrafo 1.\n\nParágrafo 2.");
    assert.match(html, /margin:18px 0 0;padding:4px 0;/, "1º parágrafo: margem 18px + padding 4px");
    assert.match(html, /margin:8px 0 0;padding:4px 0;/, "2º parágrafo: margem 8px + padding 4px");
  });

  it("esp explícito \"beehiiv\": idêntico ao default (sem esp)", () => {
    const semEsp = renderBodyParasInner("Só um parágrafo.");
    const comEsp = renderBodyParasInner("Só um parágrafo.", "beehiiv");
    assert.equal(semEsp, comEsp);
  });

  it("esp brevo: <p> SEM padding (Brevo não injeta padding no <p>) + margem 12px entre parágrafos", () => {
    const html = renderBodyParasInner("Parágrafo 1.\n\nParágrafo 2.", "brevo");
    assert.match(html, /^<p style="margin:18px 0 0;font-family:/, "1º parágrafo brevo: sem padding algum antes de font-family");
    assert.doesNotMatch(html, /padding:/, "nenhum <p> do corpo deve ter padding no canal Brevo");
    assert.match(html, /margin:12px 0 0;font-family:/, "2º parágrafo brevo: margem 12px (fator 0,75), sem padding");
  });

  it("esp kit (#464, achado do review #6080): mesma calibragem do Brevo (NÃO CALIBRADO ainda contra envio real, ver docstring de P_PAD_BY_ESP)", () => {
    const html = renderBodyParasInner("Parágrafo 1.\n\nParágrafo 2.", "kit");
    assert.match(html, /^<p style="margin:18px 0 0;font-family:/, "1º parágrafo kit: sem padding, mesmo perfil do brevo");
    assert.doesNotMatch(html, /padding:/, "kit usa o mesmo perfil sem padding do brevo");
    assert.match(html, /margin:12px 0 0;font-family:/, "2º parágrafo kit: margem 12px (fator 0,75, mesmo do brevo)");
  });

  it("renderHTML propaga opts.esp até o corpo dos destaques (Brevo)", () => {
    const content: NewsletterContent = {
      title: "T",
      subtitle: "S",
      coverImage: "04-d1-2x1.jpg",
      destaques: [
        {
          n: 1,
          category: "RISCO",
          title: "Manchete",
          body: "Parágrafo 1.\n\nParágrafo 2.",
          why: "",
          url: "https://example.com/d1",
          emoji: "⚠️",
          imageFile: "04-d1-2x1.jpg",
        },
      ],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
    } as any;
    const htmlBrevo = renderHTML(content, { esp: "brevo" });
    const htmlBeehiiv = renderHTML(content, { esp: "beehiiv" });
    // No corpo do D1, Brevo não deve ter nenhum <p> com padding; Beehiiv deve.
    assert.doesNotMatch(htmlBrevo, /margin:12px 0 0;padding:/, "Brevo: margem 12px sem padding");
    assert.match(htmlBrevo, /margin:12px 0 0;font-family:/);
    assert.match(htmlBeehiiv, /margin:8px 0 0;padding:4px 0;font-family:/);
  });
});

describe("#5176 — largura calibrada (container 656px, recuo lateral 16px) e paridade mobile", () => {
  it("LAYOUT expõe os valores decididos pelo editor", () => {
    assert.equal(LAYOUT.containerWidth, 656);
    assert.equal(LAYOUT.sidePad, 16);
  });

  it("renderHTML: container em max-width:656px + wrapper MSO width=656", () => {
    const html = renderHTML({
      title: "T",
      subtitle: "S",
      coverImage: "04-d1-2x1.jpg",
      destaques: [
        {
          n: 1,
          category: "RISCO",
          title: "Manchete",
          body: "Corpo.",
          why: "",
          url: "https://example.com/d1",
          emoji: "⚠️",
          imageFile: "04-d1-2x1.jpg",
        },
      ],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
    } as any);
    assert.match(html, /max-width:656px/);
    assert.match(html, /width="656"/);
  });

  it("recuo lateral inline é o MESMO em toda seção `class=\"pad\"` (16px)", () => {
    const html = renderHTML({
      title: "T",
      subtitle: "S",
      coverImage: "04-d1-2x1.jpg",
      destaques: [
        {
          n: 1,
          category: "RISCO",
          title: "Manchete",
          body: "Corpo.",
          why: "Razão.",
          url: "https://example.com/d1",
          emoji: "⚠️",
          imageFile: "04-d1-2x1.jpg",
        },
      ],
      eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
      sections: [],
    } as any);
    const lateralValues = [...html.matchAll(/class="pad" style="padding:[0-9]+px (\d+)px/g)].map((m) => m[1]);
    assert.ok(lateralValues.length > 0, "deve haver pelo menos 1 seção padded");
    assert.ok(lateralValues.every((v) => v === "16"), `todo recuo lateral de seção deve ser 16px, achou: ${[...new Set(lateralValues)].join(",")}`);
  });

  it("#5176 decisão 3 (paridade mobile via inline): .pad do media query emite o MESMO valor do inline (16px)", () => {
    // A media query só roda no Brevo (Beehiiv remove o <style> do e-mail
    // entregue) — emitir o mesmo valor nos dois lugares torna essa
    // diferença de execução irrelevante pro recuo final.
    assert.match(
      DS_STYLE_BLOCK,
      /\.pad\s*\{\s*padding-left:16px\s*!important;\s*padding-right:16px\s*!important;\s*\}/,
    );
  });
});

describe("#5176 — lints acompanham a calibragem", () => {
  it("checkWideTables: limiar subiu de 600 pra 656", () => {
    assert.deepEqual(checkWideTables(`<table width="656"><tr><td>x</td></tr></table>`), []);
    assert.equal(checkWideTables(`<table width="657"><tr><td>x</td></tr></table>`).length, 1);
  });

  it("checkHtmlSize: limiares deslocados pra baixo pelo overhead do wrapper Beehiiv (~44KB)", () => {
    // Abaixo do novo piso de warning (16KB) — passa.
    assert.deepEqual(checkHtmlSize("x".repeat(10 * 1024)), []);
    // Entre 16KB e 58KB — warning (equivale a ~60-102KB ENTREGUE).
    const warn = checkHtmlSize("x".repeat(20 * 1024));
    assert.equal(warn.length, 1);
    assert.equal(warn[0].severity, "warning");
    // 58KB+ — error (equivale a 102KB+ ENTREGUE, onde o Gmail corta).
    const err = checkHtmlSize("x".repeat(59 * 1024));
    assert.equal(err.length, 1);
    assert.equal(err[0].severity, "error");
  });
});
