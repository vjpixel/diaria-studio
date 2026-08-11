/**
 * test/hub-primary-source.test.ts (#4919 Parte A)
 *
 * Fixtures sintéticos com o HTML das 4 gerações de template Beehiiv
 * confirmadas na issue #4919 (medido 10/08/2026, 76 edições do hub
 * Anthropic/Claude): âncora com `class="headline"`, rótulo "Aprofunde",
 * rótulo "Saiba mais", manchete como âncora sem `class`. Regra dura
 * assertada em TODOS: só casamento exato de texto de âncora vira
 * `primarySourceUrl` — nenhum destes testes aceita atribuição por posição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findPrimarySourceUrl, normalizeAnchorText, stripTrackingParams } from "../scripts/lib/hub-primary-source.ts";

describe("findPrimarySourceUrl — template 1: <a class=\"headline\"> (#4919)", () => {
  it("casa a âncora cujo texto é idêntico à manchete", () => {
    const html = `
      <p>Confira as notícias de hoje.</p>
      <a class="headline" href="https://anthropic.com/index/foo?utm_source=diaria.beehiiv.com">Anthropic lança Claude Opus 5</a>
      <p>Por que isso importa: muda o mercado.</p>
    `;
    const url = findPrimarySourceUrl(html, "Anthropic lança Claude Opus 5");
    assert.equal(url, "https://anthropic.com/index/foo?utm_source=diaria.beehiiv.com");
  });
});

describe("findPrimarySourceUrl — template 4: manchete como âncora sem class (#4919)", () => {
  it("casa mesmo sem atributo class", () => {
    const html = `<a href="https://tecnoblog.net/materia?utm_source=diar.ia.br">Google lança Gemini 4</a>`;
    const url = findPrimarySourceUrl(html, "Google lança Gemini 4");
    assert.equal(url, "https://tecnoblog.net/materia?utm_source=diar.ia.br");
  });

  it("comparação é NFC + colapso de espaço + lowercase (texto com espaçamento/caixa diferente ainda casa)", () => {
    const html = `<a href="https://exame.com/x">   anthropic  LANÇA claude  OPUS 5  </a>`;
    const url = findPrimarySourceUrl(html, "Anthropic lança Claude Opus 5");
    assert.equal(url, "https://exame.com/x");
  });
});

describe("findPrimarySourceUrl — template 2: rótulo \"Aprofunde\" (#4919)", () => {
  it("casa a âncora \"Aprofunde\" que segue a manchete, dentro da janela até a próxima manchete", () => {
    const html = `
      <h3>Anthropic lança Claude Opus 5</h3>
      <p>Resumo da notícia aqui.</p>
      <p><a href="https://anthropic.com/index/opus-5?utm_source=diaria.beehiiv.com">Aprofunde</a></p>
      <h3>Meta compra startup de robótica</h3>
      <p>Outro resumo.</p>
      <p><a href="https://techcrunch.com/meta-startup">Aprofunde</a></p>
    `;
    const allHeadlines = ["Anthropic lança Claude Opus 5", "Meta compra startup de robótica"];
    const url = findPrimarySourceUrl(html, "Anthropic lança Claude Opus 5", allHeadlines);
    assert.equal(url, "https://anthropic.com/index/opus-5?utm_source=diaria.beehiiv.com");

    // A 2ª manchete pega o SEU PRÓPRIO "Aprofunde", não o da primeira —
    // prova de que a janela está corretamente limitada.
    const url2 = findPrimarySourceUrl(html, "Meta compra startup de robótica", allHeadlines);
    assert.equal(url2, "https://techcrunch.com/meta-startup");
  });
});

describe("findPrimarySourceUrl — template 3: rótulo \"Saiba mais\" (#4919)", () => {
  it("casa a âncora \"Saiba mais\" que segue a manchete", () => {
    const html = `
      <h3>OpenAI e Anthropic fazem avaliação conjunta de segurança</h3>
      <p>Texto da matéria.</p>
      <p><a href="https://openai.com/index/openai-anthropic-safety-evaluation/?utm_source=diaria.beehiiv.com">Saiba mais</a></p>
    `;
    const url = findPrimarySourceUrl(html, "OpenAI e Anthropic fazem avaliação conjunta de segurança");
    assert.equal(url, "https://openai.com/index/openai-anthropic-safety-evaluation/?utm_source=diaria.beehiiv.com");
  });
});

describe("findPrimarySourceUrl — regra dura: nunca fallback posicional (#4919 item 4)", () => {
  it("manchete sem âncora correspondente + link de patrocinador logo depois: sai SEM url, nunca herda o link vizinho", () => {
    const html = `
      <h3>Anthropic vale US$ 380 bi após nova rodada</h3>
      <p>Texto da matéria, sem link de aprofundamento nesta edição.</p>
      <p><a href="https://deel.com/patrocinador?utm_source=diaria.beehiiv.com">Saiba mais sobre a Deel</a></p>
    `;
    // "Saiba mais sobre a Deel" != "saiba mais" (normalizado) — a Regra B
    // exige texto EXATAMENTE igual ao rótulo conhecido, não "contém".
    const url = findPrimarySourceUrl(html, "Anthropic vale US$ 380 bi após nova rodada");
    assert.equal(url, undefined);
  });

  it("regressão do caso real da issue: link de OUTRA manchete não vaza pra esta quando a própria não tem Aprofunde", () => {
    // Reproduz a forma do erro medido em "como-o-novo-painel-da-onu-pode-afetar-a-ia":
    // um fallback posicional atribuiria a matéria da ONU (que pertence à
    // 2ª manchete) à manchete de valuation (1ª), porque ela vem "depois"
    // no documento. Regra B corretamente não encontra label pra manchete 1
    // (sem "Aprofunde"/"Saiba mais" algum) — mesmo com a manchete 2 tendo
    // link mais adiante no mesmo HTML.
    const html = `
      <h3>Anthropic vale US$ 380 bi após nova rodada</h3>
      <p>Sem CTA de aprofundamento nesta manchete.</p>
      <h3>Painel da ONU pode afetar o futuro da IA</h3>
      <p><a href="https://onu.org/painel-ia">Aprofunde</a></p>
    `;
    const allHeadlines = ["Anthropic vale US$ 380 bi após nova rodada", "Painel da ONU pode afetar o futuro da IA"];
    const url = findPrimarySourceUrl(html, "Anthropic vale US$ 380 bi após nova rodada", allHeadlines);
    assert.equal(url, undefined);
  });

  it("manchete que nem aparece como texto no HTML: sai sem url (sem base pra Regra B)", () => {
    const html = `<p>Edição sem nenhuma referência textual a esta manchete.</p>`;
    const url = findPrimarySourceUrl(html, "Manchete que não está no corpo");
    assert.equal(url, undefined);
  });
});

describe("stripTrackingParams (#4919 item 6)", () => {
  it("remove utm_source próprio (diaria.beehiiv.com)", () => {
    assert.equal(
      stripTrackingParams("https://anthropic.com/index/foo?utm_source=diaria.beehiiv.com"),
      "https://anthropic.com/index/foo",
    );
  });

  it("remove utm_source próprio (diar.ia.br)", () => {
    assert.equal(stripTrackingParams("https://tecnoblog.net/x?utm_source=diar.ia.br"), "https://tecnoblog.net/x");
  });

  it("remove UTM de terceiro copiado no corpo da edição (ex: utm_source=www.therundown.ai)", () => {
    assert.equal(
      stripTrackingParams("https://exame.com/materia?utm_source=www.therundown.ai&utm_medium=newsletter"),
      "https://exame.com/materia",
    );
  });

  it("remove TODOS os utm_*, preserva parâmetro não-utm", () => {
    const stripped = stripTrackingParams(
      "https://x.com/y?ref=diaria&utm_source=a&utm_campaign=b&utm_medium=c&id=42",
    );
    assert.equal(stripped, "https://x.com/y?ref=diaria&id=42");
  });

  it("URL sem query fica intacta", () => {
    assert.equal(stripTrackingParams("https://anthropic.com/index/foo"), "https://anthropic.com/index/foo");
  });

  it("URL malformada volta como veio (não lança)", () => {
    assert.equal(stripTrackingParams("não é uma url"), "não é uma url");
  });
});

describe("normalizeAnchorText (#4919 item 3)", () => {
  it("NFC + colapso de espaço + lowercase", () => {
    assert.equal(normalizeAnchorText("  Anthropic   Lança\nClaude Opus 5  "), "anthropic lança claude opus 5");
  });
});
