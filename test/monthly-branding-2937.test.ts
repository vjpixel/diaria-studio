/**
 * test/monthly-branding-2937.test.ts (#2937, regressão #633)
 *
 * Correções de branding do template mensal (editor 260703):
 *   - `diar.ia.br` linkado ao Beehiiv (só na mensal — applyBrandWordmark ganhou
 *     param linkHref opcional; diária inalterada).
 *   - caixas "O fio condutor" com inicial maiúscula (capitalizeFirstLetter).
 *   - títulos de destaque sem sublinhado (não são link).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capitalizeFirstLetter, renderDestaque } from "../scripts/lib/mensal/monthly-render.ts";
import { applyBrandWordmark } from "../scripts/lib/newsletter-render-html.ts";

describe("capitalizeFirstLetter (#2937)", () => {
  it("capitaliza inicial minúscula", () => {
    assert.equal(capitalizeFirstLetter("em um mês, tudo mudou."), "Em um mês, tudo mudou.");
    assert.equal(capitalizeFirstLetter("a OpenAI passou o mês."), "A OpenAI passou o mês.");
  });
  it("idempotente se já maiúscula", () => {
    assert.equal(capitalizeFirstLetter("O mês mostrou o Brasil."), "O mês mostrou o Brasil.");
  });
  it("pula marcadores markdown iniciais", () => {
    assert.equal(capitalizeFirstLetter("**bold** e resto"), "**Bold** e resto");
  });
  it("capitaliza inicial acentuada", () => {
    assert.equal(capitalizeFirstLetter("época de mudança"), "Época de mudança");
  });
  it("string vazia / sem letras é segura", () => {
    assert.equal(capitalizeFirstLetter(""), "");
    assert.equal(capitalizeFirstLetter("123 !?"), "123 !?");
  });
  it("abertura numérica NÃO capitaliza a palavra seguinte (#2951)", () => {
    // Regressão: o regex antigo produzia "30% Das empresas…" (letra errada no meio).
    assert.equal(
      capitalizeFirstLetter("30% das empresas brasileiras adotaram IA em 2026."),
      "30% das empresas brasileiras adotaram IA em 2026.",
    );
    assert.equal(capitalizeFirstLetter("1 em cada 3 startups já usa."), "1 em cada 3 startups já usa.");
  });
});

describe("applyBrandWordmark linkHref (#2937)", () => {
  it("com linkHref: envolve num link pro Beehiiv, sem sublinhar", () => {
    const out = applyBrandWordmark("veja diar.ia.br hoje", "https://diaria.beehiiv.com");
    assert.match(out, /<a href="https:\/\/diaria\.beehiiv\.com"[^>]*>/);
    assert.match(out, /text-decoration:none/);
    assert.match(out, /<strong>diar/);
  });
  it("substitui 'Diar.ia' pelo wordmark diar.ia.br (negrito + pontos teal)", () => {
    const out = applyBrandWordmark("a Diar.ia publica", "https://diaria.beehiiv.com");
    assert.match(out, /diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span>/);
  });
  it("sem linkHref: comportamento inalterado (diária — wordmark sem link)", () => {
    const out = applyBrandWordmark("veja diar.ia.br hoje");
    assert.doesNotMatch(out, /<a href/);
    assert.match(out, /<strong>diar/);
  });
  it("linkHref com '$' é inserido literal (replace via função, não $-interpretado)", () => {
    const out = applyBrandWordmark("veja diar.ia.br", "https://x.com/?u=$1&v=$$");
    assert.match(out, /href="https:\/\/x\.com\/\?u=\$1&v=\$\$"/);
  });
});

describe("renderDestaque branding (#2937)", () => {
  it("título do destaque não tem text-decoration:underline (não é link)", () => {
    const chunk = ["**DESTAQUE 1 | BRASIL**", "Brasil entra no mapa global da IA", "", "Primeiro parágrafo."].join("\n");
    const html = renderDestaque(chunk);
    const h2 = html.match(/<h2[^>]*>/);
    assert.ok(h2, "deve renderizar um <h2> de título");
    assert.doesNotMatch(h2[0], /text-decoration:underline/);
  });
  it("caixa 'O fio condutor' capitaliza a inicial do parágrafo", () => {
    const chunk = [
      "**DESTAQUE 1 | BRASIL**",
      "Título do destaque",
      "",
      "Parágrafo principal.",
      "",
      "O fio condutor: em um mês, tudo mudou.",
    ].join("\n");
    const html = renderDestaque(chunk);
    assert.match(html, /O fio condutor<\/p><p[^>]*>Em um mês/);
  });
});
