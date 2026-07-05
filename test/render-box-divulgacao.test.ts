/**
 * test/render-box-divulgacao.test.ts (#2978)
 *
 * `renderBoxDivulgacao(box, imageUrl?)` é o dispatcher único pros 2 boxes de
 * divulgação (slot 1 = gap D1/D2, slot 2 = gap D2/D3). O FORMATO é decidido
 * pelo marcador do próprio box, não pelo slot:
 *   - 🛒 → prateleira multi-parágrafo com CTA pill (renderIntroCallout com
 *     forceCtaPill=true), marcador estrutural removido do HTML.
 *   - 📚/📣/🎉 → bold-line (renderMidCallout).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBoxDivulgacao } from "../scripts/lib/newsletter-render-html.ts";

describe("renderBoxDivulgacao — dispatcher por marcador (#2978)", () => {
  it("🛒 → formato carrinho (pill CTA), marcador removido do HTML", () => {
    const box = `🛒 Equipe sua casa com a Alexa+

Estou testando a Alexa+ há alguns dias e a diferença é grande.

[Conhecer a Alexa+ e ver as ofertas](https://link.amazon/B0fmBTpob)`;
    const html = renderBoxDivulgacao(box);
    assert.match(html, /border-radius:999px/, "vira botão pill (formato carrinho)");
    assert.match(html, /Conhecer a Alexa\+ e ver as ofertas<\/a>/);
    assert.ok(!html.includes("🛒"), "marcador estrutural não vaza pro HTML");
  });

  it("📚 → formato bold-line (box teal, sem pill)", () => {
    const box = "📚 A Diar.ia mantém uma curadoria de livros sobre IA. [Confira a página de livros](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(box);
    assert.ok(!html.includes("border-radius:999px"), "bold-line não usa pill do carrinho");
    assert.match(html, /livros\.diaria\.workers\.dev/);
    assert.ok(!/^📚/.test(html), "marcador não vaza cru");
  });

  it("📣 (patrocinado) → formato bold-line", () => {
    const box = "📣 Escreva melhor com a Clarice.ai. [Acesse](https://clarice.ai/precos-planos?via=diaria).";
    const html = renderBoxDivulgacao(box);
    assert.ok(!html.includes("border-radius:999px"));
    assert.match(html, /clarice\.ai\/precos-planos/);
  });

  it("🎉 (CTA editorial) → formato bold-line", () => {
    const box = "🎉 Venha pro sorteio ao vivo! [Participe](https://meet.google.com/xyz).";
    const html = renderBoxDivulgacao(box);
    assert.ok(!html.includes("border-radius:999px"));
    assert.match(html, /meet\.google\.com/);
  });

  it("🛒 com imagem: o parâmetro imageUrl é ignorado pelo formato carrinho (usa renderIntroCallout, não renderMidCallout)", () => {
    // #2978: imagem só é suportada no formato bold-line (renderMidCallout);
    // o dispatcher NÃO passa imageUrl pro path do carrinho.
    const box = "🛒 Compre agora\n\n[Ver oferta](https://link.amazon/x)";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/img.jpg");
    assert.ok(!html.includes("cdn.example.com"), "imagem não é usada no formato carrinho");
  });

  it("📚 com imagem: usa o path com imagem (renderMidCallout)", () => {
    const box = "📚 Nossa curadoria. [Confira](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    assert.match(html, /cdn\.example\.com\/livros\.jpg/);
  });
});
