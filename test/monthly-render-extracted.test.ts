/**
 * test/monthly-render-extracted.test.ts (#1844)
 *
 * Guarda a extração da camada de render de publish-monthly.ts pro módulo
 * scripts/lib/mensal/monthly-render.ts: (a) módulo auto-contido importável direto,
 * (b) o re-export de back-compat de publish-monthly.ts aponta pra MESMA função.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  escHtml as escDirect,
  draftToEmail as d2eDirect,
  splitByLabels as sblDirect,
  renderDestaque,
  normalizeKnownUrl,
  renderInline,
  wrapEmail,
  renderCobrandHeader,
  renderSocialFooter,
} from "../scripts/lib/mensal/monthly-render.ts";
import {
  escHtml as escReexport,
  draftToEmail as d2eReexport,
  splitByLabels as sblReexport,
} from "../scripts/publish-monthly.ts";

describe("monthly-render extraído (#1844)", () => {
  it("re-export de publish-monthly é a MESMA função do módulo", () => {
    assert.strictEqual(escReexport, escDirect);
    assert.strictEqual(d2eReexport, d2eDirect);
    assert.strictEqual(sblReexport, sblDirect);
  });

  it("módulo auto-contido funciona standalone", () => {
    assert.equal(escDirect("a & b < c"), "a &amp; b &lt; c");
    // draftToEmail é puro: draft → { subject, previewText, html }
    const out = d2eDirect("REMETENTE\nDiar.ia\n", "Assunto X", "2606");
    assert.equal(out.subject, "Assunto X");
    assert.ok(typeof out.html === "string" && out.html.length > 0);
  });

  // #2018: caption parametrizada por gerador — antes hardcoded "Criada com Gemini"
  it("#2018: renderDestaque usa caption default 'Criada com IA' quando imageCaption omitido", () => {
    const chunk = "DESTAQUE 1 TECH\nTítulo do destaque\nCorpo do destaque.";
    const html = renderDestaque(chunk, undefined, "https://example.com/img.jpg");
    assert.ok(html.includes("Criada com IA"), `default caption deve ser 'Criada com IA', obtido: ${html.slice(0, 200)}`);
  });

  it("#2018: renderDestaque usa imageCaption passado explicitamente", () => {
    const chunk = "DESTAQUE 1 TECH\nTítulo do destaque\nCorpo do destaque.";
    const html = renderDestaque(chunk, undefined, "https://example.com/img.jpg", "Criada com Gemini");
    assert.ok(html.includes("Criada com Gemini"), `caption explícito deve aparecer, obtido: ${html.slice(0, 200)}`);
    assert.ok(!html.includes("Criada com IA"), "default não deve aparecer quando caption explícito");
  });

  it("#2018: draftToEmail propaga destaqueImageCaption para renderDestaque", () => {
    // isSectionLabel exige **LABEL** (bold markdown) — formato do export do Drive.
    const draft = [
      "**REMETENTE**",
      "Clarice News",
      "",
      "**DESTAQUE 1 | TECH**",
      "Título tech",
      "Parágrafo de análise.",
      "",
      "O fio condutor: Conclusão final.",
    ].join("\n");
    const imageUrls = { 1: "https://example.com/d1.jpg" };
    const out = d2eDirect(draft, "Assunto", "2606", undefined, undefined, undefined, imageUrls, "Criada com ComfyUI");
    assert.ok(out.html.includes("Criada com ComfyUI"), `caption customizado deve aparecer no HTML: ${out.html.slice(0, 400)}`);
  });
});

describe("wrapEmail — shell de marca co-brand Clarice × Diar.ia (#2645)", () => {
  it("renderCobrandHeader emite o nome 'Clarice' + indicação de parceria com Diar.ia (textual, sem logo)", () => {
    const html = renderCobrandHeader();
    assert.ok(html.includes("Clarice"), `nome Clarice ausente no header: ${html}`);
    assert.ok(/Clarice\s*(&times;|×)\s*Diar\.ia/.test(html), `indicação de parceria Clarice × Diar.ia ausente: ${html}`);
    assert.ok(!html.includes("<img"), "sem asset de logo ainda — header deve ser textual, não <img> (decisão do editor 260701)");
  });

  it("renderSocialFooter emite os 4 canais sociais configurados (Facebook/LinkedIn/Instagram/Threads)", () => {
    const html = renderSocialFooter();
    for (const label of ["Facebook", "LinkedIn", "Instagram", "Threads"]) {
      assert.ok(html.includes(label), `canal ${label} ausente no footer: ${html}`);
    }
    assert.ok(html.includes("facebook.com/diar.ia.br"), "URL do Facebook ausente/incorreta");
    assert.ok(html.includes("linkedin.com/company/diar.ia.br"), "URL do LinkedIn ausente/incorreta");
    assert.ok(html.includes("instagram.com/diaria"), "URL do Instagram ausente/incorreta");
    assert.ok(html.includes("threads.net/@diar.ia.br"), "URL do Threads ausente/incorreta");
  });

  it("wrapEmail integra header co-brand + footer social no documento final", () => {
    const { html } = d2eDirect("**ASSUNTO**\nTeste #2645\n", null, "2605");
    assert.ok(html.includes("Clarice"), "header co-brand ausente no wrapEmail");
    assert.ok(html.includes("Facebook") && html.includes("LinkedIn"), "footer social ausente no wrapEmail");
    // Header vem ANTES do footer no documento (ordem visual capa → corpo → rodapé).
    assert.ok(html.indexOf("Clarice &times; Diar.ia") < html.lastIndexOf("Siga a Clarice"), "header deve preceder o footer");
  });

  it("wrapEmail declara suporte a dark theme (@media prefers-color-scheme + metas color-scheme)", () => {
    const html = wrapEmail("Assunto teste", ["<p>corpo</p>"]);
    assert.ok(html.includes("prefers-color-scheme: dark"), "media query de dark theme ausente");
    assert.ok(html.includes('name="color-scheme"'), "meta color-scheme ausente");
    assert.ok(html.includes('name="supported-color-schemes"'), "meta supported-color-schemes ausente");
    assert.ok(html.includes('class="ds-canvas"'), "classe ds-canvas (alvo do dark mode) ausente no canvas externo");
  });

  it("dark theme escurece só o canvas — card (#FFFFFF) e conteúdo interno preservados (sem regressão #1955)", () => {
    const draft = [
      "**ASSUNTO**",
      "Teste #2645",
      "",
      "**DESTAQUE 1 | TECH**",
      "Título tech",
      "Corpo do destaque.",
      "",
      "O fio condutor: Conclusão.",
    ].join("\n");
    const { html } = d2eDirect(draft, null, "2605");
    assert.match(html, /#FFFFFF/i, "card branco deve seguir presente (canvas escurece, card não)");
    assert.doesNotMatch(html, /#FBFAF6/i, "#FBFAF6 (paper token web) não deve aparecer no email mensal");
    assert.match(html, /#EBE5D0/i, "bege de contraste (boxes internos) deve seguir presente e intocado");
  });
});

describe("normalizeKnownUrl — links de curadoria migrados (#2261)", () => {
  it("reescreve cursos-gratuitos-de-ia (Beehiiv 404) → cursos.diaria.workers.dev", () => {
    assert.equal(
      normalizeKnownUrl("https://diaria.beehiiv.com/cursos-gratuitos-de-ia"),
      "https://cursos.diaria.workers.dev",
    );
  });
  it("reescreve livros-sobre-ia (Beehiiv 404) → livros.diaria.workers.dev, ignorando ?utm", () => {
    assert.equal(
      normalizeKnownUrl("https://diaria.beehiiv.com/livros-sobre-ia?utm_source=x"),
      "https://livros.diaria.workers.dev",
    );
  });
  it("não toca URLs não-migradas", () => {
    assert.equal(normalizeKnownUrl("https://exame.com/ia/x"), "https://exame.com/ia/x");
    assert.equal(normalizeKnownUrl("https://cursos.diaria.workers.dev"), "https://cursos.diaria.workers.dev");
  });
  it("não faz over-match em sufixo com hífen (ex: -de-ia-2024)", () => {
    const other = "https://diaria.beehiiv.com/cursos-gratuitos-de-ia-2024";
    assert.equal(normalizeKnownUrl(other), other, "página diferente não deve ser reescrita");
  });
  it("aceita fim de segmento: trailing slash, ?query, #hash", () => {
    assert.equal(normalizeKnownUrl("https://diaria.beehiiv.com/cursos-gratuitos-de-ia/"), "https://cursos.diaria.workers.dev");
    assert.equal(normalizeKnownUrl("https://diaria.beehiiv.com/cursos-gratuitos-de-ia#x"), "https://cursos.diaria.workers.dev");
  });
  it("renderInline aplica a normalização no href do link de curadoria", () => {
    const html = renderInline("[Cursos gratuitos](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)");
    assert.match(html, /href="https:\/\/cursos\.diaria\.workers\.dev"/);
    assert.doesNotMatch(html, /beehiiv\.com\/cursos/);
  });
});

// #2913: o render mensal passou a aplicar o wordmark da marca (applyBrandWordmark)
// no texto — "diar.ia.br" vira o wordmark com pontos teal, igual à diária.
describe("brand wordmark no render mensal (#2913)", () => {
  it("estiliza 'diar.ia.br' como wordmark (pontos teal #00A0A0)", () => {
    const html = renderInline("em parceria com a diar.ia.br: curadoria");
    assert.match(
      html,
      /<strong>diar<span style="color:#00A0A0">\.<\/span>ia<span style="color:#00A0A0">\.br<\/span><\/strong>/,
    );
  });

  it("estiliza 'diar.ia' (sem .br) também", () => {
    assert.match(renderInline("acesse diar.ia hoje"), /<strong>diar<span style="color:#00A0A0">\./);
  });

  it("NÃO toca a URL dentro de um link (wordmark só em texto fora de link)", () => {
    const html = renderInline("[aqui](http://diar.ia.br)");
    assert.match(html, /href="http:\/\/diar\.ia\.br"/); // href intacto, sem <span> teal
    assert.doesNotMatch(html, /href="[^"]*<span/);
  });
});
