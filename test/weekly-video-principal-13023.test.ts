/**
 * test/weekly-video-principal-13023.test.ts (#13023)
 *
 * Nos dois produtos semanais (newsletter do LinkedIn e post da Stack) o vídeo
 * da semana é apresentado como "principal vídeo da semana", não mais como "o
 * mais assistido". A seleção (`top-edition-video.ts`, o mais visto) não muda:
 * só o texto que chega ao leitor. A descrição que o `stack-writer` escreve
 * também é recusada se chamar o vídeo de "mais assistido"/"mais visto".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderLinkedinWeeklyHtml, LINKEDIN_WEEKLY_VIDEO_LINK_TEXT, type WeeklyLinkedinRenderInput } from "../scripts/lib/weekly-linkedin-render.ts";
import { renderCircleStackPost, CIRCLE_STACK_VIDEO_LEAD, type CircleStackItem, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { renderCircleStackPreviewHtml } from "../scripts/lib/circle-stack-preview-html.ts";
import { parseStackCopy, videoAudienceClaim } from "../scripts/lib/circle-stack-copy.ts";
import { stripHtmlToText } from "../scripts/lib/linkedin-paste-audit.ts";

const AUDIENCIA_RE = /mais\s+(assistid|vist)[oa]/i;
const VIDEO_URL = "https://youtu.be/bbbbbbbbbbb";

function linkedinInput(): WeeklyLinkedinRenderInput {
  return {
    cycle: "26w45",
    headlines: [
      { title: "Golpe da selfie", body: "Corpo 1.", why: "Porque 1.", editionDate: "261103" },
      { title: "Google paga para sair", body: "Corpo 2.", why: "Porque 2.", editionDate: "261104" },
      { title: "Multa no STF", body: "Corpo 3.", why: "Porque 3.", editionDate: "261105" },
    ],
    weeklyEditions: [
      { editionDate: "261103", url: "https://diar.ia.br/p/a", destaques: ["Golpe da selfie"] },
      { editionDate: "261104", url: "https://diar.ia.br/p/b", destaques: ["Google paga para sair"] },
      { editionDate: "261105", url: "https://diar.ia.br/p/c", destaques: ["Multa no STF"] },
    ],
    opening: "Desde o ano passado, escrevo a diar.ia.br, newsletter de IA.",
    closing: "Fecho.",
    video: { title: "T", url: VIDEO_URL, editionDate: "261103" },
  };
}

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261104", url: "https://ex.com/x", title: "Título", body: "Corpo.", why: "", ...over,
});

const D1 = item({
  url: "https://www.anthropic.com/news/claude-x",
  title: "Anthropic lança o Claude X com janela de 2 milhões de tokens",
  body: "O Claude X lê 2 milhões de tokens.",
  why: "Projetos inteiros cabem numa conversa.",
  destaqueN: 1,
});

const stackSel = (): CircleStackSelection => ({
  cycle: "26w45",
  contentWindow: ["261102", "261103", "261104", "261105", "261106"],
  destaques: [D1],
  lancamentos: [item({ url: "https://blog.n8n.io/n8n-3", title: "n8n 3.0 em beta", body: "O n8n abriu o beta." })],
  useMelhor: [],
  radar: [],
  weeklyEditions: [],
  video: { title: "Claude X comentado", url: "https://www.youtube.com/watch?v=abc", editionDate: "261104", views: 120, description: "O Claude X lê 2 milhões de tokens." },
});

describe("#13023/#13045 — LinkedIn semanal: frase do vídeo", () => {
  it("a frase fixa da seção (#13045) não fala em audiência nem em 'principal vídeo da semana'", () => {
    // #13045: o rótulo "principal vídeo da semana" fica só na seção da Stack.
    assert.equal(LINKEDIN_WEEKLY_VIDEO_LINK_TEXT, "YouTube da diar.ia.br");
    const { html } = renderLinkedinWeeklyHtml(linkedinInput());
    const text = stripHtmlToText(html);
    assert.ok(text.includes("Eu comento o destaque acima no YouTube da diar.ia.br."), text);
    assert.doesNotMatch(text, /principal vídeo da semana/i);
    assert.doesNotMatch(text, AUDIENCIA_RE);
  });
});

describe("#13023 — Stack: principal vídeo da semana", () => {
  it("título da seção no post publicado", () => {
    assert.equal(CIRCLE_STACK_VIDEO_LEAD, "## Principal vídeo da semana");
    const { markdown } = renderCircleStackPost(stackSel());
    assert.ok(markdown.split("\n").includes("## Principal vídeo da semana"));
    assert.doesNotMatch(markdown, AUDIENCIA_RE);
  });

  it("título da seção na prévia do editor", () => {
    const html = renderCircleStackPreviewHtml({
      selection: stackSel(),
      previewTitle: "T",
      publishMonday: "261109",
      publishState: "draft",
      warnings: [],
      mdPath: "data/weekly/26w45/circle-stack-26w45.md",
    });
    assert.match(html, /<h2>Principal vídeo da semana<\/h2>/);
    assert.doesNotMatch(html, AUDIENCIA_RE);
  });

  it("descrição do vídeo que fala em audiência é recusada", () => {
    for (const bad of ["O vídeo mais assistido da semana fala do Claude X.", "No mais visto, o Claude X lê 2 milhões de tokens.", "A mais vista trata do Claude X."]) {
      assert.ok(videoAudienceClaim(bad), bad);
      const s = stackSel();
      const raw = JSON.stringify({
        cycle: s.cycle,
        opening: "O Claude X chegou com janela maior.",
        notes: [{ url: "https://blog.n8n.io/n8n-3", stackNote: "O beta já roda fluxos existentes." }],
        videoDescription: bad,
      });
      const r = parseStackCopy(raw, s);
      assert.equal(r.copy, null, bad);
      assert.match(r.problems.join("\n"), /principal vídeo da semana \(#13023\)/);
    }
    assert.equal(videoAudienceClaim("O Claude X lê 2 milhões de tokens e mais vistoso fica o painel."), null);
    assert.equal(videoAudienceClaim("O Claude X lê 2 milhões de tokens."), null);
  });

  it("o prompt do stack-writer não chama o vídeo de 'mais assistido' e proíbe o termo", () => {
    const prompt = readFileSync(new URL("../.claude/agents/stack-writer.md", import.meta.url), "utf8");
    assert.match(prompt, /principal vídeo da semana/);
    assert.match(prompt, /Não chame o vídeo de "mais assistido" nem de "mais visto"/);
    const semProibicao = prompt.replace(/Não chame o vídeo de "mais assistido" nem de "mais visto"/, "");
    assert.doesNotMatch(semProibicao, AUDIENCIA_RE);
  });
});
