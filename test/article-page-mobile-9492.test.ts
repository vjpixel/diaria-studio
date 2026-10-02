import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectWebMobileCss, WEB_MOBILE_CSS_MARKER } from "../scripts/lib/mensal/build-article-page.ts";
import { wrapEmail } from "../scripts/lib/mensal/monthly-render.ts";

describe("artigo mensal web: CSS mobile (#9492)", () => {
  const html = wrapEmail("Assunto", ["<p>corpo</p>"]);
  const web = injectWebMobileCss(html);

  it("injeta o bloco responsivo antes de </head>", () => {
    assert.ok(web.indexOf(WEB_MOBILE_CSS_MARKER) < web.indexOf("</head>"));
    assert.match(web, /max-width: 480px/);
  });

  it("os seletores casam o markup real do wrapEmail", () => {
    assert.ok(html.includes('width="600"'));
    assert.ok(html.includes("padding:36px 32px"));
    assert.ok(html.includes("padding:20px 10px"));
    assert.match(web, /table\[width="600"\]/);
    assert.match(web, /td\[style\*="padding:36px 32px"\]/);
  });

  it("o HTML de e-mail não é alterado", () => {
    assert.ok(!html.includes(WEB_MOBILE_CSS_MARKER));
  });
});

import { renderPaywall } from "../workers/retrospectiva/src/render-mensal.ts";
describe("gate web: CSS mobile (#9492)", () => {
  it("paywall reduz padding e empilha botão abaixo de 480px", () => {
    const h = renderPaywall("2607");
    assert.match(h, /@media \(max-width: 480px\)[\s\S]*\.wrap \{ padding:24px 12px/);
    assert.match(h, /name="viewport"/);
  });
});
