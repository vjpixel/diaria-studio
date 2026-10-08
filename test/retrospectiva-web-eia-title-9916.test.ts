/**
 * test/retrospectiva-web-eia-title-9916.test.ts
 *
 * #9916: a página web da Retrospectiva mostrava "Clique na imagem que foi
 * gerada por IA" sobre as duas fotos do É IA?, que na web são `<img>` sem link
 * desde o #9864 — a instrução era falsa e o clique não fazia nada. A web passa
 * a perguntar (`WEB_EIA_TITLE`); o e-mail, onde a foto é link de voto, mantém
 * o CTA de clique.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildArticleHtml } from "../scripts/lib/mensal/build-article-page.ts";
import { draftToEmailApoiadoresKit } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { WEB_EIA_TITLE } from "../scripts/lib/mensal/monthly-web-render.ts";

const DIR = resolve(import.meta.dirname, "fixtures/retrospectiva-web-9872");
const DRAFT = readFileSync(resolve(DIR, "draft.md"), "utf8");
const EIA_A = "https://img/a.jpg";
const EIA_B = "https://img/b.jpg";
const CREDIT = "Crédito [X](https://x.org).";

describe("#9916 — É IA? da página web não manda clicar em foto sem link", () => {
  const page = buildArticleHtml(DRAFT, "2609-10", { eiaCredit: CREDIT, eiaImageUrlA: EIA_A, eiaImageUrlB: EIA_B }).html;

  it("regressão: o HTML web não contém 'Clique na imagem'", () => {
    assert.ok(page.includes(`<img src="${EIA_A}"`), "o bloco É IA? com fotos está na página");
    assert.doesNotMatch(page, /Clique na imagem/i);
  });

  it("a página traz a pergunta neutra no lugar, sem verbo de clique", () => {
    assert.ok(page.includes(`<p class="eia-title">${WEB_EIA_TITLE}</p>`));
    assert.doesNotMatch(WEB_EIA_TITLE, /clique|clicar|toque/i);
  });

  it("as fotos continuam sem link na web (premissa da troca, #9864)", () => {
    assert.doesNotMatch(page, /<a\b[^>]*>\s*<img src="https:\/\/img\/[ab]\.jpg"/);
  });

  it("o e-mail, onde a foto é link de voto, mantém o CTA de clique", () => {
    const email = draftToEmailApoiadoresKit(DRAFT, null, "2609", EIA_A, EIA_B, CREDIT).html;
    assert.match(email, /Clique na imagem que foi gerada por IA/);
  });
});
