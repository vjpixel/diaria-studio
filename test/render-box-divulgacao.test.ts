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

  it("📚 com 2+ links: renderiza 1 botão por link, SEM a imagem (#3028)", () => {
    const box =
      "📚 Livros em oferta.\n\nO primeiro tem 48% de desconto; o segundo, R$ 217 a menos.\n\n" +
      "[Ver livro A](https://amzn.to/aaa) · [Ver livro B](https://amzn.to/bbb)";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    // Ambos os links viram botão (não some o 2º como no path com imagem).
    assert.match(html, /amzn\.to\/aaa/, "1º link presente");
    assert.match(html, /amzn\.to\/bbb/, "2º link presente (o path antigo o descartava)");
    // A screenshot da página NÃO é usada neste caminho.
    assert.ok(!html.includes("cdn.example.com"), "imagem não é usada em box multi-link");
    // As descrições ficam no corpo, não são engolidas.
    assert.match(html, /48% de desconto/, "descrições preservadas no corpo");
  });

  it("📚 de 1 parágrafo com 2 links inline: não vaza o marcador 📚 no texto (#3028)", () => {
    const box = "📚 Confira [Livro A](https://amzn.to/aaa) e [Livro B](https://amzn.to/bbb) com desconto.";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    assert.ok(!html.includes("📚"), "marcador 📚 não vaza cru no HTML");
    assert.match(html, /amzn\.to\/aaa/, "1º link presente");
    assert.match(html, /amzn\.to\/bbb/, "2º link presente");
  });

  it("📚 com 1 link + imagem NÃO muda (regressão #3028): continua no path com imagem", () => {
    const box = "📚 Nossa curadoria. [Confira](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    assert.match(html, /cdn\.example\.com\/livros\.jpg/, "box de 1 link mantém a imagem");
  });
});

describe("renderBoxDivulgacao — peso de fonte do box só-texto (#3372)", () => {
  const box = "🙋🏼‍♀️ Apoie a curadoria. [Conheça](https://apoia.se/diaria).";

  it("default (sem 3º arg) preserva o visual histórico: font-weight:600", () => {
    const html = renderBoxDivulgacao(box);
    assert.match(html, /font-weight:600/);
    assert.ok(!html.includes("font-weight:400"));
  });

  it("bold=true explícito: font-weight:600", () => {
    const html = renderBoxDivulgacao(box, null, true);
    assert.match(html, /font-weight:600/);
  });

  it("bold=false: font-weight:400, sem afetar o resto do conteúdo", () => {
    const html = renderBoxDivulgacao(box, null, false);
    assert.match(html, /font-weight:400/);
    assert.ok(!html.includes("font-weight:600"));
    assert.match(html, /apoia\.se\/diaria/, "conteúdo do box preservado");
  });

  it("bold não afeta o path com CTA pill (🛒) — irrelevante pra estrutura título+corpo", () => {
    const cartBox = "🛒 Compre agora\n\n[Ver oferta](https://link.amazon/x)";
    const boldHtml = renderBoxDivulgacao(cartBox, null, true);
    const noBoldHtml = renderBoxDivulgacao(cartBox, null, false);
    assert.equal(boldHtml, noBoldHtml, "path carrinho ignora o parâmetro bold");
  });
});
