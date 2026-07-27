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
  extractEmail,
  stripQuotedAndSignature,
  isTrivialReply,
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

  it("#1969: variante Gmail do editor (ponto/+tag/case) também → false", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "vj.pixel@gmail.com" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "vjpixel+diaria@gmail.com" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: '"Pixel" <Vj.Pixel@googlemail.com>' }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "diaria.editor@gmail.com" }));
  });

  it("sem remetente → false", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x", from: "" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Re: x" }));
  });

  it("'RE:' / 're:' case-insensitive", () => {
    assert.ok(looksLikeSubscriberReply({ subject: "RE: edição", from: "a@b.com" }));
  });

  // ── review #1827: variantes de prefixo + header From com display-name ──

  it("variantes de prefixo: 'Res:', 'RE :', 'Re[2]:'", () => {
    assert.ok(looksLikeSubscriberReply({ subject: "Res: edição", from: "a@b.com" }), "Res: (Outlook PT)");
    assert.ok(looksLikeSubscriberReply({ subject: "RE : edição", from: "a@b.com" }), "espaço antes do :");
    assert.ok(looksLikeSubscriberReply({ subject: "Re[2]: edição", from: "a@b.com" }), "Re[N]:");
  });

  it("forward (Fwd:/Enc:) NÃO é resposta", () => {
    assert.ok(!looksLikeSubscriberReply({ subject: "Fwd: edição", from: "a@b.com" }));
    assert.ok(!looksLikeSubscriberReply({ subject: "Enc: edição", from: "a@b.com" }));
  });

  it("From com display-name: matcha o EMAIL, não o nome (review #1827)", () => {
    // nome 'Bounceiro' contém 'bounce' mas o EMAIL é humano → não excluir.
    assert.ok(
      looksLikeSubscriberReply({ subject: "Re: x", from: '"João Bounceiro" <joao@empresa.com>' }),
    );
    // automático identificado pelo EMAIL no header, mesmo com display-name.
    assert.ok(
      !looksLikeSubscriberReply({ subject: "Re: x", from: '"Diar.ia" <no-reply@beehiiv.com>' }),
    );
    // editor com display-name → excluído.
    assert.ok(
      !looksLikeSubscriberReply({ subject: "Re: x", from: '"Pixel" <vjpixel@gmail.com>' }),
    );
  });

  it("extractEmail extrai de '\"Nome\" <email>' e tolera email cru", () => {
    assert.equal(extractEmail('"João" <joao@x.com>'), "joao@x.com");
    assert.equal(extractEmail("joao@x.com"), "joao@x.com");
    assert.equal(extractEmail("  JOAO@X.COM  "), "joao@x.com");
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

// ── #4095: stripQuotedAndSignature — limpeza de citação/assinatura ─────────

describe("stripQuotedAndSignature (#4095)", () => {
  it("ausente/vazio → string vazia, nunca lança", () => {
    assert.equal(stripQuotedAndSignature(undefined), "");
    assert.equal(stripQuotedAndSignature(null), "");
    assert.equal(stripQuotedAndSignature(""), "");
  });

  it("sem citação nenhuma → texto preservado (trim)", () => {
    assert.equal(stripQuotedAndSignature("  Gostei muito da edição de hoje!  "), "Gostei muito da edição de hoje!");
  });

  it("remove bloco citado prefixado com '>' preservando o texto novo acima", () => {
    const body = [
      "Show, adorei a matéria sobre o Karpathy!",
      "",
      "> Diar.ia — 27/07",
      "> Destaque 1: ...",
      "> Destaque 2: ...",
    ].join("\n");
    assert.equal(stripQuotedAndSignature(body), "Show, adorei a matéria sobre o Karpathy!");
  });

  it("remove citação aninhada ('>>') também", () => {
    const body = ["oi", "", ">> texto citado duplamente aninhado", "> outro nível"].join("\n");
    assert.equal(stripQuotedAndSignature(body), "oi");
  });

  it("corta no header 'Em {data}, {nome} escreveu:' (single-line) e tudo que vem depois (mesmo sem '>')", () => {
    const body = [
      "Qual foi o erro de hoje? Achei que era a data do lançamento.",
      "",
      "Em qui., 27 de jul. de 2026 às 08:00, Pixel <diariaeditor@gmail.com> escreveu:",
      "",
      "Diar.ia — 27/07",
      "",
      "Destaque 1: O agente que atacou sozinho",
      "https://diar.ia.br/p/destaque-1",
      "",
      "Destaque 2: ...",
    ].join("\n");
    const cleaned = stripQuotedAndSignature(body);
    assert.equal(cleaned, "Qual foi o erro de hoje? Achei que era a data do lançamento.");
    assert.ok(!cleaned.includes("Destaque"), "newsletter citada não deve sobreviver");
  });

  it("variante EN 'On ..., X wrote:' também corta", () => {
    const body = [
      "Thanks for the edition!",
      "",
      "On Sun, Jul 27, 2026 at 8:00 AM Pixel <diariaeditor@gmail.com> wrote:",
      "",
      "Diar.ia — 27/07 full newsletter content here",
    ].join("\n");
    assert.equal(stripQuotedAndSignature(body), "Thanks for the edition!");
  });

  it("remove assinatura mobile ('Enviado do meu iPhone') e tudo depois", () => {
    const body = [
      "Adorei, parabéns pelo trabalho!",
      "",
      "Enviado do meu iPhone",
      "",
      "> Diar.ia — 27/07",
      "> conteúdo citado",
    ].join("\n");
    assert.equal(stripQuotedAndSignature(body), "Adorei, parabéns pelo trabalho!");
  });

  it("remove assinatura plain-text delimitada por '--' isolado", () => {
    const body = [
      "Valeu pela dica de hoje.",
      "",
      "--",
      "Fulano de Tal",
      "Cargo na Empresa X",
    ].join("\n");
    assert.equal(stripQuotedAndSignature(body), "Valeu pela dica de hoje.");
  });

  it("regressão do caso da issue: reply 'oi' inteiro some sob a newsletter citada sem a limpeza", () => {
    // Reprodução do problema descrito no #4095: sem stripQuotedAndSignature,
    // o corpo bruto (texto novo + newsletter inteira citada) tem milhares de
    // caracteres — qualquer heurística de TAMANHO classificaria como "tem
    // conteúdo". Com a limpeza, sobra só o "oi" real.
    const newsletterQuoted = Array.from({ length: 50 }, (_, i) => `> Parágrafo ${i} da newsletter citada.`).join("\n");
    const body = `oi\n\nEm qui., 27 de jul. de 2026 às 08:00, Pixel <diariaeditor@gmail.com> escreveu:\n\n${newsletterQuoted}`;
    const cleaned = stripQuotedAndSignature(body);
    assert.equal(cleaned, "oi");
    assert.ok(cleaned.length < 10, "corpo limpo deve ser curto, não milhares de caracteres");
  });
});

// ── #4095: isTrivialReply — classificação de conteúdo trivial ───────────────

describe("isTrivialReply (#4095)", () => {
  it("corpo vazio/whitespace → true", () => {
    assert.equal(isTrivialReply(""), true);
    assert.equal(isTrivialReply("   \n  "), true);
    assert.equal(isTrivialReply(undefined), true);
    assert.equal(isTrivialReply(null), true);
  });

  it("saudação isolada → true ('oi', 'olá', 'e aí')", () => {
    assert.equal(isTrivialReply("oi"), true);
    assert.equal(isTrivialReply("Oi!"), true);
    assert.equal(isTrivialReply("olá"), true);
    assert.equal(isTrivialReply("Olá!"), true);
    assert.equal(isTrivialReply("e aí"), true);
    assert.equal(isTrivialReply("bom dia"), true);
  });

  it("agradecimento isolado → true ('obrigado', 'vlw', 'show', 'top')", () => {
    assert.equal(isTrivialReply("Obrigado!"), true);
    assert.equal(isTrivialReply("obrigada"), true);
    assert.equal(isTrivialReply("vlw"), true);
    assert.equal(isTrivialReply("valeu"), true);
    assert.equal(isTrivialReply("show"), true);
    assert.equal(isTrivialReply("top"), true);
  });

  it("só emoji → true ('👏👏')", () => {
    assert.equal(isTrivialReply("👏👏"), true);
    assert.equal(isTrivialReply("🙏"), true);
    assert.equal(isTrivialReply("😂😂😂"), true);
  });

  it("só pontuação → true ('...', '!!!')", () => {
    assert.equal(isTrivialReply("..."), true);
    assert.equal(isTrivialReply("!!!"), true);
  });

  it("pergunta curta de uma linha → false (não é trivial, mesmo curta)", () => {
    assert.equal(isTrivialReply("Qual foi o erro de hoje?"), false);
    assert.equal(isTrivialReply("Isso é verdade mesmo?"), false);
  });

  it("saudação/agradecimento SEGUIDO de conteúdo real → false (não trunca substância)", () => {
    assert.equal(
      isTrivialReply("Oi, tudo bem? Queria saber se o destaque de hoje tem fonte oficial."),
      false,
    );
    assert.equal(
      isTrivialReply("Valeu pela indicação do livro, vou comprar."),
      false,
    );
  });

  it("resposta de conteúdo normal → false", () => {
    assert.equal(
      isTrivialReply("Acho que o correto era 1998, não 1990 — conferi na Wikipedia."),
      false,
    );
  });
});

// ── #4095: filterSubscriberReplies marca trivial sem remover do array ──────

describe("filterSubscriberReplies — marcação trivial (#4095)", () => {
  it("reply trivial ganha trivial:true mas continua no array (crédito de erro intencional não pode pular)", () => {
    const threads = [
      { thread_id: "1", subject: "Re: Diar.ia", from: "leitor1@x.com", body: "oi" },
      {
        thread_id: "2",
        subject: "Re: Diar.ia",
        from: "leitor2@x.com",
        body: "Acho que o erro foi a data do lançamento, 1998 e não 1990.",
      },
    ];
    const { replies } = filterSubscriberReplies(threads);
    assert.equal(replies.length, 2, "ambas continuam no array — trivial não remove");
    const r1 = replies.find((r) => r.thread_id === "1");
    const r2 = replies.find((r) => r.thread_id === "2");
    assert.equal(r1?.trivial, true);
    assert.equal(r2?.trivial, false);
  });

  it("reply sem body (undefined) → trivial:true (corpo vazio)", () => {
    const threads = [{ thread_id: "1", subject: "Re: x", from: "leitor@x.com" }];
    const { replies } = filterSubscriberReplies(threads);
    assert.equal(replies[0].trivial, true);
  });

  it("reply real com newsletter inteira citada abaixo do 'oi' ainda é detectada como trivial (limpeza aplicada antes de julgar)", () => {
    const newsletterQuoted = Array.from({ length: 30 }, (_, i) => `> Parágrafo ${i} da newsletter.`).join("\n");
    const body = `oi\n\nEm qui., 27 de jul. de 2026 às 08:00, Pixel <diariaeditor@gmail.com> escreveu:\n\n${newsletterQuoted}`;
    const threads = [{ thread_id: "1", subject: "Re: x", from: "leitor@x.com", body }];
    const { replies } = filterSubscriberReplies(threads);
    assert.equal(replies[0].trivial, true, "sem a limpeza, o corpo de milhares de chars pareceria substancial");
  });
});
