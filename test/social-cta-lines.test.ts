/**
 * social-cta-lines.test.ts (#3991)
 *
 * Testa a injeção determinística de CTA/linha de canal no publish — o
 * mecanismo central da unificação do texto social (issue #3991): o texto
 * genérico (revisado pelo editor em 03-social.md) nunca contém CTA de canal;
 * cada publisher monta {corpo}\n\n{linha do canal}\n\n{tags} na hora do
 * publish via `injectChannelLine`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitBodyAndTags,
  injectChannelLine,
  CHANNEL_CTA_LINES,
  FACEBOOK_CTA_LINE,
  INSTAGRAM_CTA_LINE,
  LINKEDIN_CTA_LINE,
} from "../scripts/lib/social-cta-lines.ts";

describe("splitBodyAndTags (#3991)", () => {
  it("separa corpo de 1 linha de hashtags no final", () => {
    const { body, tags } = splitBodyAndTags("Texto editorial aqui.\n\n#IA #Agentes");
    assert.equal(body, "Texto editorial aqui.");
    assert.equal(tags, "#IA #Agentes");
  });

  it("separa corpo de múltiplas linhas de hashtags no final", () => {
    const { body, tags } = splitBodyAndTags("Corpo.\n\n#IA\n#Agentes #DevTools");
    assert.equal(body, "Corpo.");
    assert.equal(tags, "#IA\n#Agentes #DevTools");
  });

  it("sem hashtags → tags vazio, body é o texto inteiro (trim)", () => {
    const { body, tags } = splitBodyAndTags("Só texto, sem tags.\n");
    assert.equal(body, "Só texto, sem tags.");
    assert.equal(tags, "");
  });

  it("hashtag no MEIO do texto (não no final) não é tratada como bloco de tags", () => {
    const { body, tags } = splitBodyAndTags("Falamos de #IA no meio do texto.\n\nConclusão sem tags.");
    assert.equal(tags, "");
    assert.ok(body.includes("#IA no meio"));
  });

  it("tolera linhas em branco entre corpo e o bloco de hashtags", () => {
    const { body, tags } = splitBodyAndTags("Corpo aqui.\n\n\n#IA #Agentes\n");
    assert.equal(body, "Corpo aqui.");
    assert.equal(tags, "#IA #Agentes");
  });

  it("normaliza CRLF antes de dividir", () => {
    const { body, tags } = splitBodyAndTags("Corpo CRLF.\r\n\r\n#IA #Agentes");
    assert.equal(body, "Corpo CRLF.");
    assert.equal(tags, "#IA #Agentes");
  });

  it("hashtag com hífen (#multi-agent) é reconhecida como tag", () => {
    const { tags } = splitBodyAndTags("Corpo.\n\n#multi-agent #IA");
    assert.equal(tags, "#multi-agent #IA");
  });

  it("texto vazio → body e tags vazios", () => {
    const { body, tags } = splitBodyAndTags("");
    assert.equal(body, "");
    assert.equal(tags, "");
  });
});

describe("CHANNEL_CTA_LINES / constantes (#3991)", () => {
  it("Facebook mantém o CTA de e-mail (#602/#3486 preservado)", () => {
    assert.equal(FACEBOOK_CTA_LINE, "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.");
    assert.equal(CHANNEL_CTA_LINES.facebook, FACEBOOK_CTA_LINE);
  });

  it("Instagram mantém 'link na bio' + follow (#3486 preservado)", () => {
    assert.equal(INSTAGRAM_CTA_LINE, "Edição completa no link da bio. Segue @diar.ia pra não perder a próxima.");
    assert.equal(CHANNEL_CTA_LINES.instagram, INSTAGRAM_CTA_LINE);
  });

  it("LinkedIn é null — preserva #595/#3627 (sem URL/menção no corpo do post principal)", () => {
    assert.equal(LINKEDIN_CTA_LINE, null);
    assert.equal(CHANNEL_CTA_LINES.linkedin, null);
  });
});

describe("injectChannelLine (#3991)", () => {
  it("Facebook: injeta a linha de e-mail ENTRE corpo e tags", () => {
    const out = injectChannelLine("Fato interessante sobre IA.\n\n#IA #Agentes", "facebook");
    const lines = out.split("\n\n");
    assert.equal(lines[0], "Fato interessante sobre IA.");
    assert.equal(lines[1], FACEBOOK_CTA_LINE);
    assert.equal(lines[2], "#IA #Agentes");
  });

  it("Instagram: injeta a linha de 'link na bio' ENTRE corpo e tags", () => {
    const out = injectChannelLine("Fato interessante sobre IA.\n\n#IA #Agentes", "instagram");
    const lines = out.split("\n\n");
    assert.equal(lines[0], "Fato interessante sobre IA.");
    assert.equal(lines[1], INSTAGRAM_CTA_LINE);
    assert.equal(lines[2], "#IA #Agentes");
  });

  it("LinkedIn: NÃO injeta nenhuma linha (preserva #595) — só corpo + tags", () => {
    const out = injectChannelLine("Fato interessante sobre IA.\n\n#IA #Agentes", "linkedin");
    assert.equal(out, "Fato interessante sobre IA.\n\n#IA #Agentes");
    assert.ok(!out.includes("diar.ia.br"));
    assert.ok(!out.includes("Diar.ia"));
  });

  it("sem hashtags no texto genérico → estrutura vira {corpo}\\n\\n{linha do canal} (Facebook)", () => {
    const out = injectChannelLine("Fato interessante sobre IA, sem tags.", "facebook");
    assert.equal(out, "Fato interessante sobre IA, sem tags.\n\n" + FACEBOOK_CTA_LINE);
  });

  it("sem hashtags + LinkedIn (ctaLine null) → texto sai intacto (idempotente)", () => {
    const out = injectChannelLine("Fato interessante sobre IA, sem tags.", "linkedin");
    assert.equal(out, "Fato interessante sobre IA, sem tags.");
  });

  it("os 3 canais a partir do MESMO texto genérico produzem só a linha de canal como diferença", () => {
    const generic = "Mesmo fato, mesmo corpo, todos os canais.\n\n#InteligenciaArtificial";
    const li = injectChannelLine(generic, "linkedin");
    const fb = injectChannelLine(generic, "facebook");
    const ig = injectChannelLine(generic, "instagram");

    // Todos preservam o corpo editorial idêntico.
    for (const out of [li, fb, ig]) {
      assert.ok(out.includes("Mesmo fato, mesmo corpo, todos os canais."));
      assert.ok(out.includes("#InteligenciaArtificial"));
    }
    // Só FB e IG carregam CTA — LinkedIn não.
    assert.ok(!li.includes("diar.ia.br") && !li.includes("bio"));
    assert.ok(fb.includes("https://diar.ia.br."));
    assert.ok(ig.includes("link da bio"));
  });
});
