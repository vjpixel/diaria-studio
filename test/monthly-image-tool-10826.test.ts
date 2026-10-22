/**
 * #10826 — o rodapé (PARA ENCERRAR) da edição mensal citava "Gemini para criar
 * imagens" mesmo com as imagens saindo do ChatGPT, e o mapa de legendas do
 * mensal divergia do helper da diária (`shared/image-tool-name.ts`) em
 * `openai`/`cloudflare`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IMAGE_TOOL_NAMES,
  imageCreditCaption,
  imageToolNameFromCaption,
} from "../scripts/lib/shared/image-tool-name.ts";
import {
  captionForGenerator,
  draftToEmail,
  applyMonthlyImageToolToCredits,
  CLARICE_UTM_PROFILE,
} from "../scripts/lib/mensal/monthly-render.ts";
import { draftToWebArticle } from "../scripts/lib/mensal/monthly-web-render.ts";

const TOOLS =
  "Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz.";

const DRAFT = `**ASSUNTO**\nAssunto\n\n**PREVIEW**\nPreview\n\n**PARA ENCERRAR**\n\n${TOOLS}\n`;

describe("#10826 — legenda do mensal usa o mapa compartilhado da diária", () => {
  for (const gen of Object.keys(IMAGE_TOOL_NAMES)) {
    it(`${gen}: captionForGenerator === imageCreditCaption`, () => {
      assert.equal(captionForGenerator(gen), imageCreditCaption(gen));
    });
  }
  it("gerador desconhecido cai em 'Criada com IA'", () => {
    assert.equal(captionForGenerator("nao-existe"), "Criada com IA");
  });
});

describe("#10826 — imageToolNameFromCaption", () => {
  it("extrai o nome de 'Criada com X' e devolve null fora desse formato", () => {
    assert.equal(imageToolNameFromCaption("Criada com ChatGPT"), "ChatGPT");
    assert.equal(imageToolNameFromCaption("Criada com Cloudflare FLUX"), "Cloudflare FLUX");
    assert.equal(imageToolNameFromCaption(undefined), null);
    assert.equal(imageToolNameFromCaption("Foto: Reuters"), null);
  });
});

describe("#10826 — rodapé do mensal segue o gerador real", () => {
  it("cenário da issue: imagens do Codex → e-mail diz ChatGPT, não Gemini", () => {
    const { html } = draftToEmail(DRAFT, null, "2610", undefined, undefined, undefined, undefined, captionForGenerator("codex"));
    assert.match(html, /ChatGPT para criar imagens/);
    assert.doesNotMatch(html, /Gemini para criar imagens/);
  });

  it("página web (retrospectiva) aplica o mesmo ajuste", () => {
    const web = draftToWebArticle({
      draft: DRAFT,
      yymm: "2610",
      utmProfile: CLARICE_UTM_PROFILE,
      leaderboardBrand: "clarice",
      destaqueImageCaption: captionForGenerator("codex"),
    });
    assert.match(web.bodyHtml, /ChatGPT para criar imagens/);
    assert.doesNotMatch(web.bodyHtml, /Gemini para criar imagens/);
  });

  it("sem legenda (caller que não resolve gerador) o texto sai intacto", () => {
    assert.equal(applyMonthlyImageToolToCredits(TOOLS, undefined), TOOLS);
    const { html } = draftToEmail(DRAFT, null, "2610");
    assert.match(html, /Gemini para criar imagens/);
  });

  it("Gemini continua Gemini quando o gerador é gemini", () => {
    assert.equal(applyMonthlyImageToolToCredits(TOOLS, captionForGenerator("gemini")), TOOLS);
  });
});
