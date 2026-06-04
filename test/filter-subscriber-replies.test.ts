/**
 * filter-subscriber-replies.test.ts (#1797)
 *
 * Cobre a heurística determinística que decide quais threads do Gmail são
 * respostas de assinante (pra rascunhar resposta pessoal — nunca enviar).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeSubscriberReply,
  filterSubscriberReplies,
} from "../scripts/filter-subscriber-replies.ts";

describe("looksLikeSubscriberReply (#1797)", () => {
  it("Re: de pessoa real → true", () => {
    assert.ok(
      looksLikeSubscriberReply({ subject: "Re: Diar.ia de hoje", from: "leitor@empresa.com.br" }),
    );
  });

  it("assunto sem 'Re:' → false (não é resposta)", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Sugestão de pauta", from: "leitor@x.com" }));
  });

  it("remetente automático → false", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "no-reply@beehiiv.com" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "mailer-daemon@googlemail.com" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "notifications@github.com" }));
  });

  it("o próprio editor → false (não rascunhar resposta a si mesmo)", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "vjpixel@gmail.com" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "pixel@memelab.com.br" }));
  });

  it("sem remetente → false", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x" }));
  });

  it("'RE:' / 're:' case-insensitive", () => {
    assert.ok(looksLikeSubscriberReply({ subject: "RE: edição", from: "a@b.com" }));
  });
});

describe("filterSubscriberReplies (#1797)", () => {
  it("filtra só as respostas de assinante, conta total", () => {
    const threads = [
      { thread_id: "1", subject: "Re: Diar.ia", from: "leitor1@x.com" },
      { thread_id: "2", subject: "Re: Diar.ia", from: "no-reply@beehiiv.com" }, // automático
      { thread_id: "3", subject: "Nova pauta", from: "leitor2@x.com" }, // não é Re:
      { thread_id: "4", subject: "Re: edição de ontem", from: "leitor3@y.com.br" },
      { thread_id: "5", subject: "Re: teste", from: "vjpixel@gmail.com" }, // editor
    ];
    const { total, replies } = filterSubscriberReplies(threads);
    assert.equal(total, 5);
    assert.equal(replies.length, 2, "só thread 1 e 4 são respostas de assinante");
    assert.deepEqual(replies.map((r) => r.thread_id).sort(), ["1", "4"]);
  });

  it("nenhuma resposta → array vazio, total preservado", () => {
    const threads = [{ subject: "Re: x", from: "no-reply@x.com" }];
    const { total, replies } = filterSubscriberReplies(threads);
    assert.equal(total, 1);
    assert.equal(replies.length, 0);
  });
});
