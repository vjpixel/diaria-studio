/**
 * #10783 — rodapé (PARA ENCERRAR) e legenda do hero citam a MESMA ferramenta
 * de imagem, derivada de `image_generator` / sidecar do gerador efetivo.
 * #10781 — convite social de uma versão anterior de `SOCIAL_INVITE` (antes do
 * YouTube, #10761) mantém a caixa "painel" ao re-renderizar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyImageToolToCredits,
  imageCreditCaption,
  imageToolName,
  IMAGE_TOOL_NAMES,
} from "../scripts/lib/shared/image-tool-name.ts";
import {
  editionImageGenerator,
  imageGeneratorCredit,
  renderEncerrar,
} from "../scripts/lib/newsletter-render-html.ts";
import { buildParaEncerrar } from "../scripts/stitch-newsletter.ts";
import {
  CURADORIA_PILLS,
  SOCIAL_INVITE,
  isSocialInviteParagraph,
} from "../scripts/lib/shared/encerramento-snippet.ts";

const TOOLS_PARAGRAPH =
  "Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz.";

describe("#10783 — ferramenta de imagem do rodapé = da legenda", () => {
  for (const gen of Object.keys(IMAGE_TOOL_NAMES)) {
    it(`${gen}: rodapé e legenda nomeiam a mesma ferramenta`, () => {
      const footer = applyImageToolToCredits(TOOLS_PARAGRAPH, gen);
      const caption = imageGeneratorCredit(gen);
      const tool = caption.replace(/^Criada com /, "");
      assert.equal(tool, imageToolName(gen));
      assert.ok(footer.includes(`, ${tool} para criar imagens`), footer);
    });
  }

  it("codex (o config atual): o rodapé deixa de dizer Gemini", () => {
    const footer = applyImageToolToCredits(TOOLS_PARAGRAPH, "codex");
    assert.match(footer, /resumos, ChatGPT para criar imagens e Wispr Flow/);
    assert.doesNotMatch(footer, /Gemini/);
    assert.equal(imageGeneratorCredit("codex"), "Criada com ChatGPT");
  });

  it("gerador desconhecido ou misto cai no genérico, nos dois lugares", () => {
    assert.equal(imageCreditCaption("mixed"), "Criada com IA");
    assert.match(applyImageToolToCredits(TOOLS_PARAGRAPH, "mixed"), /resumos, IA para criar imagens/);
    assert.match(applyImageToolToCredits(TOOLS_PARAGRAPH, null), /resumos, IA para criar imagens/);
  });

  it("placeholder {{IMAGE_TOOL}} é resolvido", () => {
    assert.equal(
      applyImageToolToCredits("usei {{IMAGE_TOOL}} para criar imagens", "codex"),
      "usei ChatGPT para criar imagens",
    );
  });

  it("idempotente e não toca menção a ferramenta fora de 'para criar imagens'", () => {
    const text = "Testei o Gemini ontem. Usei Gemini para criar imagens.";
    const once = applyImageToolToCredits(text, "codex");
    assert.equal(once, "Testei o Gemini ontem. Usei ChatGPT para criar imagens.");
    assert.equal(applyImageToolToCredits(once, "codex"), once);
  });

  it("editionImageGenerator: sidecars concordantes → esse; divergentes → mixed", () => {
    assert.equal(editionImageGenerator([{ imageGenerator: "gemini" }, { imageGenerator: "gemini" }, {}]), "gemini");
    assert.equal(editionImageGenerator([{ imageGenerator: "gemini" }, { imageGenerator: "codex" }]), "mixed");
  });

  it("stitch: buildParaEncerrar aplica o gerador ao slot A (override com texto legado)", () => {
    const out = buildParaEncerrar({ slotA: TOOLS_PARAGRAPH }, null, undefined, "codex");
    assert.match(out, /resumos, ChatGPT para criar imagens/);
    assert.doesNotMatch(out, /Gemini para criar imagens/);
  });
});

/** Versão de `SOCIAL_INVITE` anterior ao #10761 (sem YouTube) — o texto que
 *  está em `02-reviewed.md` das edições 261001..261021. */
const PREVIOUS_SOCIAL_INVITE =
  "Para acompanhar as 3 principais notícias de IA todos os dias, siga a **diar.ia.br** no [LinkedIn](https://www.linkedin.com/company/diaria/), [Instagram](https://www.instagram.com/diar.ia.br/), [Threads](https://www.threads.net/@diar.ia.br), [Facebook](https://www.facebook.com/diar.ia.br) ou [X](https://x.com/diariabr).";

function encerrarWith(invite: string): string {
  return `Texto de apoio qualquer.\n\n${CURADORIA_PILLS}\n\n${invite}`;
}

describe("#10781 — convite social de versão anterior mantém a caixa painel", () => {
  it("isSocialInviteParagraph reconhece a constante atual, a anterior e a redação legada", () => {
    assert.ok(isSocialInviteParagraph(SOCIAL_INVITE));
    assert.ok(isSocialInviteParagraph(PREVIOUS_SOCIAL_INVITE));
    assert.ok(isSocialInviteParagraph("Agora que chegou até aqui, siga a gente."));
    assert.ok(!isSocialInviteParagraph("Texto de apoio qualquer."));
  });

  it("render do convite ANTERIOR sai dentro da caixa, igual ao atual", () => {
    const boxRe = /border-radius:12px;padding:[^"]*;">\s*<p[^>]*>Para acompanhar as 3 principais/;
    assert.match(renderEncerrar(encerrarWith(SOCIAL_INVITE)), boxRe);
    assert.match(renderEncerrar(encerrarWith(PREVIOUS_SOCIAL_INVITE)), boxRe);
  });
});
