/**
 * test/render-box-divulgacao.test.ts (#2978, marcador-agnóstico desde #3204,
 * sistema de marcadores removido em #3475)
 *
 * `renderBoxDivulgacao(box, imageUrl?)` é o dispatcher único pros 2 boxes de
 * divulgação (slot 1 = gap D1/D2, slot 2 = gap D2/D3). O FORMATO é decidido
 * pela ESTRUTURA do próprio conteúdo (`shouldForceCtaPill`), não por marcador
 * emoji:
 *   - 2+ links, ou último parágrafo é só um link → prateleira multi-parágrafo
 *     com CTA pill (renderIntroCallout com forceCtaPill=true).
 *   - caso contrário → bold-line (renderMidCallout).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBoxDivulgacao } from "../scripts/lib/newsletter-render-html.ts";

describe("renderBoxDivulgacao — dispatcher por estrutura (#2978/#3475)", () => {
  it("último parágrafo só-link → formato carrinho (pill CTA)", () => {
    const box = `Equipe sua casa com a Alexa+

Estou testando a Alexa+ há alguns dias e a diferença é grande.

[Conhecer a Alexa+ e ver as ofertas](https://link.amazon/B0fmBTpob)`;
    const html = renderBoxDivulgacao(box);
    assert.match(html, /border-radius:999px/, "vira botão pill (formato carrinho)");
    assert.match(html, /Conhecer a Alexa\+ e ver as ofertas<\/a>/);
  });

  it("1 link só, sem CTA-only paragraph → formato bold-line (box teal, sem pill)", () => {
    const box = "A Diar.ia mantém uma curadoria de livros sobre IA. [Confira a página de livros](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(box);
    assert.ok(!html.includes("border-radius:999px"), "bold-line não usa pill do carrinho");
    assert.match(html, /livros\.diaria\.workers\.dev/);
  });

  it("patrocinado (link de afiliado) → formato bold-line", () => {
    const box = "Escreva melhor com a Clarice.ai. [Acesse](https://clarice.ai/precos-planos?via=diaria).";
    const html = renderBoxDivulgacao(box);
    assert.ok(!html.includes("border-radius:999px"));
    assert.match(html, /clarice\.ai\/precos-planos/);
  });

  it("CTA editorial (1 link, sem CTA-only paragraph) → formato bold-line", () => {
    const box = "Venha pro sorteio ao vivo! [Participe](https://meet.google.com/xyz).";
    const html = renderBoxDivulgacao(box);
    assert.ok(!html.includes("border-radius:999px"));
    assert.match(html, /meet\.google\.com/);
  });

  it("formato carrinho: o parâmetro imageUrl é ignorado (usa renderIntroCallout, não renderMidCallout)", () => {
    // #2978: imagem só é suportada no formato bold-line (renderMidCallout);
    // o dispatcher NÃO passa imageUrl pro path do carrinho.
    const box = "Compre agora\n\n[Ver oferta](https://link.amazon/x)";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/img.jpg");
    assert.ok(!html.includes("cdn.example.com"), "imagem não é usada no formato carrinho");
  });

  it("bold-line com imagem: usa o path com imagem (renderMidCallout)", () => {
    const box = "Nossa curadoria. [Confira](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    assert.match(html, /cdn\.example\.com\/livros\.jpg/);
  });

  it("2+ links: renderiza 1 botão por link, SEM a imagem (#3028)", () => {
    const box =
      "Livros em oferta.\n\nO primeiro tem 48% de desconto; o segundo, R$ 217 a menos.\n\n" +
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

  it("1 parágrafo com 2 links inline: link markdown cru não vaza no texto (#3028)", () => {
    const box = "Confira [Livro A](https://amzn.to/aaa) e [Livro B](https://amzn.to/bbb) com desconto.";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    assert.match(html, /amzn\.to\/aaa/, "1º link presente");
    assert.match(html, /amzn\.to\/bbb/, "2º link presente");
  });

  it("1 link + imagem NÃO muda (regressão #3028): continua no path com imagem", () => {
    const box = "Nossa curadoria. [Confira](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(box, "https://cdn.example.com/livros.jpg");
    assert.match(html, /cdn\.example\.com\/livros\.jpg/, "box de 1 link mantém a imagem");
  });
});

describe("renderBoxDivulgacao — título serif restaurado por sinal estrutural (#3475 follow-up)", () => {
  // Box "recomendação de leitura": (1) linha de título sem link, (2) parágrafo
  // liderado por link do livro, (3) comentário. O título serif 26px foi
  // RESTAURADO via sinal estrutural (1ª linha sem link + 2º parágrafo liderado
  // por link), NÃO pelo marcador emoji 📖 (removido em #3475).
  const RECOMENDACAO = `Recomendação de leitura

[**2041: Como a IA Vai Mudar Sua Vida**](https://link.amazon/B05FlAaJ7), de Kai-Fu Lee e Chen Qiufan.

Estou terminando agora e gosto da estrutura: cada capítulo abre com um conto.`;

  it("1ª linha vira título serif 26px, SEM depender de emoji no fonte", () => {
    const html = renderBoxDivulgacao(RECOMENDACAO);
    assert.match(
      html,
      /<p style="[^"]*font-family:Georgia[^"]*font-size:26px[^"]*">Recomendação de leitura<\/p>/,
      "título serif 26px ausente na 1ª linha",
    );
    // não é o formato carrinho (1 link não-CTA-only → sem pill)
    assert.ok(!html.includes("border-radius:999px"), "não deve virar botão pill");
    // conteúdo preservado
    assert.ok(html.includes("link.amazon/B05FlAaJ7"), "link do livro preservado");
    assert.ok(html.includes("cada capítulo abre com um conto"), "comentário preservado");
  });

  it("detecção é agnóstica ao emoji: título serif sai com ou sem 📖 na 1ª linha", () => {
    // O ponto do #3475: a DETECÇÃO do título é ESTRUTURAL, não pelo emoji. Um
    // 📖 legado no fonte não muda nada (aparece cru — não há mais strip); o
    // título serif é aplicado igual, por estrutura. A fonte canônica não tem emoji.
    assert.match(renderBoxDivulgacao(RECOMENDACAO), /font-size:26px/, "sem emoji: título aplicado");
    assert.match(renderBoxDivulgacao(`📖 ${RECOMENDACAO}`), /font-size:26px/, "com 📖 legado: título aplicado igual");
  });

  it("box livros de 1 parágrafo (bold-line) NÃO ganha título serif indevidamente", () => {
    const livros = "A diar.ia.br mantém uma curadoria de livros sobre IA. [Confira a página](https://livros.diaria.workers.dev).";
    const html = renderBoxDivulgacao(livros);
    assert.doesNotMatch(html, /font-size:26px/, "box de 1 parágrafo não deve ganhar título 26px");
  });

  it("nota pessoal multi-parágrafo (sem 2º parágrafo liderado por link) NÃO ganha título serif (#3460 preservado)", () => {
    // A nota do editor corre em prosa; se tem link, ele fica no meio da frase,
    // nunca abrindo o parágrafo. Não deve virar título.
    const nota = "Olá! Eu sou o Pixel, editor dessa newsletter.\n\nConsidere [apoiar](https://apoia.se/diaria) se puder — todo dia trago as notícias mais importantes.";
    const html = renderBoxDivulgacao(nota);
    assert.doesNotMatch(html, /font-size:26px/, "nota pessoal não deve ganhar título serif");
  });
});

describe("renderBoxDivulgacao — peso de fonte do box só-texto (#3373)", () => {
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

describe("renderBoxDivulgacao — lista de bullets no corpo (#3374)", () => {
  const box = `A diar.ia.br lançou o programa de apoio.

Quem contribui ganha benefícios como:

- Artigo Especial - um mergulho fundo num tema do momento
- Bastidores da produção
- Panorama do Mês

[Conheça em apoia.se/diaria](https://apoia.se/diaria)`;

  it("bloco `- item` vira <ul><li> real, não <p> com hífen literal", () => {
    const html = renderBoxDivulgacao(box);
    assert.match(html, /<ul/, "lista vira <ul>");
    assert.equal((html.match(/<li /g) ?? []).length, 3, "3 itens viram 3 <li>");
    assert.match(html, /<li[^>]*>Artigo Especial - um mergulho fundo num tema do momento<\/li>/);
    assert.ok(!/<p[^>]*>-\s/.test(html), "item não vaza como <p> com hífen literal");
  });

  it("CTA-only final vira botão pill (não fica preso na lista nem some)", () => {
    const html = renderBoxDivulgacao(box);
    assert.match(html, /border-radius:999px/);
    assert.match(html, /apoia\.se\/diaria/);
    assert.equal((html.match(/<li /g) ?? []).length, 3, "CTA não virou um 4º <li>");
  });

  it("título e intro (parágrafos não-lista) continuam <p>, não viram <li>", () => {
    const html = renderBoxDivulgacao(box);
    assert.match(
      html,
      /<p[^>]*>[\s\S]*?lançou o programa de apoio[\s\S]*?<\/p>/,
      "título vira <p>, não <li>",
    );
    assert.match(
      html,
      /<p[^>]*>Quem contribui ganha benefícios como:<\/p>/,
      "intro vira <p>, não <li>",
    );
  });

  it("parágrafo com hífen no MEIO do texto (não bullet) não vira lista", () => {
    const noList = renderBoxDivulgacao(
      "Título aqui.\n\nUm texto qualquer - com um hífen no meio - mas sem marcador de lista.\n\n[Link](https://example.com)",
    );
    assert.ok(!noList.includes("<ul"), "hífen no meio da frase não confunde com bullet");
  });
});

describe("renderBoxDivulgacao — bold repassado no path de 2+ links (#3391)", () => {
  // shouldForceCtaPill(box) força o path carrinho pra QUALQUER box com 2+
  // links, mesmo de 1 parágrafo só (#3028) — esse box cai no branch de 1
  // parágrafo de renderIntroCallout, que usa `bold` pra decidir font-weight.
  const box = "📚 Confira [Livro A](https://amzn.to/aaa) e [Livro B](https://amzn.to/bbb) com desconto.";

  it("bold=false: font-weight:400 no HTML (editor pediu peso normal via ausência de **...**)", () => {
    const html = renderBoxDivulgacao(box, null, false);
    assert.match(html, /font-weight:400/);
    assert.ok(!html.includes("font-weight:600"));
  });

  it("bold=true (default): font-weight:600 no HTML — regressão do visual histórico", () => {
    const html = renderBoxDivulgacao(box);
    assert.match(html, /font-weight:600/);
    assert.ok(!html.includes("font-weight:400"));
  });
});

describe("renderBoxDivulgacao — lista de bullets DEPOIS do CTA (#3391)", () => {
  it("bloco `- item` após o botão CTA vira <ul><li>, não texto corrido com hífen literal", () => {
    const box = `Título aqui.

Corpo antes do CTA.

[Conheça](https://apoia.se/diaria)

- Item 1
- Item 2`;
    const html = renderBoxDivulgacao(box);
    assert.match(html, /border-radius:999px/, "CTA vira botão pill");
    assert.match(html, /<ul/, "lista depois do CTA vira <ul>");
    assert.equal((html.match(/<li /g) ?? []).length, 2, "2 itens viram 2 <li>");
    assert.ok(!/<p[^>]*>-\s*Item/.test(html), "item não vaza como <p> com hífen literal");
    assert.match(html, /<li[^>]*>Item 1<\/li>/);
    assert.match(html, /<li[^>]*>Item 2<\/li>/);
  });
});

describe("renderBoxDivulgacao — plainFirstParagraph propaga em TODOS os ramos (#5882)", () => {
  // Mesma FORMA estrutural do box "Convide um amigo" (frase + parágrafo
  // CTA-only), mas com copy DIFERENTE da frase original — reproduz o cenário
  // da issue #5882: trocar 1 palavra da copy não pode derrubar a supressão
  // do título, porque a supressão não depende mais de regex casando o texto
  // exato (isConviteAmigoBox, aposentada) — é uma propriedade declarada
  // repassada pelo CALLER via `plainFirstParagraph`.
  const boxCopyAlterada = `Conhece alguém que ia curtir esta newsletter?

[Convide pelo WhatsApp →](https://wa.me/?text=x)`;

  it("ramo shouldForceCtaPill (2+ links/CTA-only): plainFirstParagraph=true suprime o título mesmo com copy alterada", () => {
    const html = renderBoxDivulgacao(boxCopyAlterada, null, false, false, false, null, true);
    assert.doesNotMatch(html, /font-size:26px/, "plainFirstParagraph=true deve suprimir o título, independente da copy");
  });

  it("sanity: MESMA copy alterada, SEM plainFirstParagraph (default false) — 1º parágrafo vira título serif (mostra a regressão que a detecção por regex sofria)", () => {
    const html = renderBoxDivulgacao(boxCopyAlterada);
    assert.match(html, /font-size:26px/, "sem o flag declarado, o dispatcher trata o 1º parágrafo como título — comportamento pré-existente preservado");
  });

  // Box "sem título" que PERDE a estrutura CTA-only (link não é CTA-only —
  // tem texto além do link no mesmo parágrafo —, sem imagem) — cai no ramo
  // DEFAULT de renderBoxDivulgacao (chamada ~1033), que por sua vez cai no
  // early-return sem imagem de renderMidCallout (chamada ~1043). Os DOIS
  // pontos hardcoded `false` antes desta issue. Estrutura link-led no 2º
  // parágrafo (mesmo sinal de `firstLineIsSectionTitle` do describe acima)
  // pra garantir que, SEM `plainFirstParagraph`, o título REALMENTE aparece
  // (a exceção #3460 "nota pessoal" só se aplica a box sem NENHUM parágrafo
  // liderado por link — não serviria pra provar a propagação).
  const boxSemCtaOnly = `Conhece alguém que ia curtir esta newsletter?

[**Confira o motivo**](https://example.com/x), publicado essa semana.

Vale a leitura completa.`;

  it("ramo default (sem CTA-pill, sem imagem): plainFirstParagraph propaga até renderIntroCallout via renderMidCallout", () => {
    const withFlag = renderBoxDivulgacao(boxSemCtaOnly, null, false, false, false, null, true);
    assert.doesNotMatch(withFlag, /font-size:26px/, "plainFirstParagraph deve suprimir título mesmo no ramo default sem imagem");
  });

  it("sanity: ramo default SEM plainFirstParagraph — título serif aplicado (comportamento pré-existente)", () => {
    const withoutFlag = renderBoxDivulgacao(boxSemCtaOnly);
    assert.match(withoutFlag, /font-size:26px/, "sem o flag, o 1º parágrafo vira título no ramo default");
  });

  // Ramo forceImage (imagem explícita atribuída ao slot) com imagem RETRATO
  // (portrait=true) — por si só `!portrait` é false, então SEM o flag
  // declarado o título normalmente aparece; `plainFirstParagraph` precisa
  // vencer mesmo assim (box "sem título" que ganha imagem de slot).
  it("ramo forceImage + portrait: plainFirstParagraph=true suprime o título mesmo com imagem retrato forçada", () => {
    const html = renderBoxDivulgacao(boxSemCtaOnly, "https://cdn.example.com/capa.jpg", true, true, true, null, true);
    assert.doesNotMatch(html, /font-size:26px/, "box declarado sem título não pode reganhar título ao ganhar imagem de slot");
  });

  it("sanity: ramo forceImage + portrait SEM plainFirstParagraph — título serif aplicado (comportamento pré-existente)", () => {
    const html = renderBoxDivulgacao(boxSemCtaOnly, "https://cdn.example.com/capa.jpg", true, true, true);
    assert.match(html, /font-size:26px/, "sem o flag, imagem retrato forçada mostra título — comportamento pré-existente preservado");
  });

  it("ramo forceImage horizontal (portrait=false): plainFirstParagraph já era suprimido por `!portrait` — continua suprimido", () => {
    const html = renderBoxDivulgacao(boxSemCtaOnly, "https://cdn.example.com/header.jpg", true, true, false, null, false);
    assert.doesNotMatch(html, /font-size:26px/, "imagem horizontal forçada já suprimia título independente de plainFirstParagraph — regressão de comportamento histórico");
  });
});
