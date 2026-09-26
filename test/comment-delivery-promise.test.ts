/**
 * #8681 — guard contra a "promessa" de entrega por comentário no Instagram.
 * O repo não tem mecanismo pra responder comentários; legenda/CTA que
 * promete entregar algo (link/edição/material) em troca de um comentário
 * precisa ser bloqueada, tanto no invariante do Stage 4 quanto no publish.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCommentDeliveryPromise, commentDeliveryPromiseMessage } from "../scripts/lib/comment-delivery-promise.ts";

describe("detectCommentDeliveryPromise (#8681)", () => {
  it("bloqueia o caso real da edição 260922", () => {
    const r = detectCommentDeliveryPromise(
      'Quer receber o link da edição do dia? Siga @diar.ia.br e comente "quero" neste post.',
    );
    assert.equal(r.promise, true);
    assert.ok(r.match);
  });

  it("bloqueia variações de aspas/acentuação/conjugação", () => {
    const casos = [
      "Comenta 'quero' que eu te mando o link!",
      "Deixe um comentário que a gente te envia o material completo.",
      "Comentem aqui pra receber a edição do dia no direct.",
      "COMENTE QUERO E EU TE MANDO O LINK DA EDIÇÃO.",
      "Deixa nos comentários que eu mando pra você o link completo.",
    ];
    for (const texto of casos) {
      const r = detectCommentDeliveryPromise(texto);
      assert.equal(r.promise, true, `esperava bloquear: "${texto}"`);
    }
  });

  it("NÃO bloqueia CTAs neutras sem promessa de entrega", () => {
    const casos = [
      "Comente o que você achou dessa notícia.",
      "Conta pra gente nos comentários o que achou!",
      "Curte, comenta e compartilha com quem precisa saber disso.",
      "Segue a gente @diar.ia.br pra não perder a próxima edição.",
      "O que você acha? Comenta aqui embaixo.",
      null,
      undefined,
      "",
    ];
    for (const texto of casos) {
      const r = detectCommentDeliveryPromise(texto as string | null | undefined);
      assert.equal(r.promise, false, `não deveria bloquear: "${texto}"`);
    }
  });

  it("não dispara só com a promessa de entrega, sem pedido de comentário", () => {
    const r = detectCommentDeliveryPromise("Assine grátis pra receber o link da edição do dia na sua caixa de entrada.");
    assert.equal(r.promise, false);
  });

  it("não dispara quando comentário e entrega estão em frases DIFERENTES e sem relação (achado do code-review do #8681)", () => {
    const r = detectCommentDeliveryPromise(
      "Assine grátis pra receber a edição do dia direto no seu e-mail. Comenta aqui o que você achou dessa notícia!",
    );
    assert.equal(r.promise, false);
  });

  it("dispara quando comentário e entrega estão na MESMA frase mesmo com pontuação no meio", () => {
    const r = detectCommentDeliveryPromise("Quer receber o link? Comenta \"quero\" que eu te mando agora mesmo.");
    assert.equal(r.promise, true);
  });

  it("não dispara quando 'mandar' não é dirigido ao leitor, mesmo perto do pedido de comentário (#8844)", () => {
    const r = detectCommentDeliveryPromise(
      "Ihh, isso vou mandar pro grupo! Comenta se você também compartilhou.",
    );
    assert.equal(r.promise, false);
  });

  it("não dispara quando comentário e 'receber' estão longe demais na mesma frase (#8844)", () => {
    const r = detectCommentDeliveryPromise(
      "Quer saber mais sobre isso? Comenta aqui embaixo que a gente te ajuda a entender melhor esse assunto e outros que você quiser receber depois.",
    );
    assert.equal(r.promise, false);
  });

  it("não dispara com 'mando o'/'envio a' sem leitor, mesmo perto do pedido de comentário (#8846)", () => {
    const casos = [
      "Mando o resumo pro grupo depois, viu? Comenta aqui o que achou.",
      "Envio a pauta pro pessoal do escritório amanhã, comenta aqui o que achou.",
    ];
    for (const texto of casos) {
      const r = detectCommentDeliveryPromise(texto);
      assert.equal(r.promise, false, `não deveria bloquear: "${texto}"`);
    }
  });

  it("dispara na pergunta-gancho 'quer receber' mesmo com o pedido de comentário mais longe (#8846)", () => {
    const r = detectCommentDeliveryPromise(
      'Quer receber o link da edição do dia? Siga a gente aqui no Instagram @diar.ia.br, ative as notificações e comente "quero" aqui embaixo neste post.',
    );
    assert.equal(r.promise, true);
  });

  it("NÃO bloqueia CTAs neutras realistas de Instagram (#8846)", () => {
    const casos = [
      "Comente o que achou!",
      "Conta nos comentários se você já usou",
      "Salva pra ler depois e comenta sua opinião",
      "Recebeu a edição de hoje? Comenta o que achou.",
    ];
    for (const texto of casos) {
      const r = detectCommentDeliveryPromise(texto);
      assert.equal(r.promise, false, `não deveria bloquear: "${texto}"`);
    }
  });

  it("commentDeliveryPromiseMessage nomeia a fonte e a ação corretiva", () => {
    const msg = commentDeliveryPromiseMessage("_internal/instagram-test.json (caption)", '"comente" + "receber"');
    assert.match(msg, /_internal\/instagram-test\.json \(caption\)/);
    assert.match(msg, /#8681/);
    assert.match(msg, /tem nenhum mecanismo/i);
  });
});
