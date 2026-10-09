/**
 * #9948 — as exclusões do #9944 (DOCUMENT_TITLE_RE e "users in" no complemento
 * geográfico) valiam em qualquer posição do título e tiravam de LANÇAMENTOS
 * títulos de produto legítimos. Agora o substantivo de documento só conta no
 * SUJEITO (study/survey só como núcleo do sujeito), e "users in" só é geo
 * quando seguido de país/região.
 *
 * #9958 — padrão recorrente de bucket-move RADAR → USE MELHOR: "como
 * transcrever|resumir" no título (caso real 261009, exame.com) é how-to.
 * No summary, ", como resumir matérias" é enumeração ("tal como") — não pode
 * disparar (caso real 260611, "Gemini no Chrome chega ao Brasil…", RADAR).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeWithRule, categoryToBucket, isNewPlatformAvailabilityTitle } from "../scripts/lib/launch-heuristics.ts";
import { startsWithGeoComplement } from "../scripts/lib/launch-vs-news.ts";

const bucketAndRule = (a: Parameters<typeof categorizeWithRule>[0]) => {
  const r = categorizeWithRule(a);
  return { bucket: categoryToBucket(r.category), rule: r.rule };
};

describe("#9948 — exclusões de documento/geo não atingem produto legítimo", () => {
  const positives: Array<{ url: string; title: string }> = [
    { url: "https://openai.com/index/chatgpt-study-mode-android", title: "ChatGPT study mode now available on Android" },
    { url: "https://blogs.microsoft.com/blog/copilot-power-bi", title: "Copilot now works with Power BI reports" },
    { url: "https://blog.google/products/notebooklm/survey-forms", title: "NotebookLM now available for Workspace survey forms" },
    { url: "https://openai.com/index/sora-chatgpt-plus", title: "Sora now available for users in ChatGPT Plus" },
  ];
  for (const c of positives) {
    it(`'${c.title}' → LANÇAMENTOS`, () => {
      assert.equal(isNewPlatformAvailabilityTitle(c), true);
      const r = bucketAndRule(c);
      assert.equal(r.bucket, "lancamento", JSON.stringify(r));
      assert.equal(r.rule, "lancamento-new-platform-availability");
    });
  }

  it("documento como sujeito/núcleo segue excluído", () => {
    for (const title of [
      "The 2026 State of Enterprise AI report is now available for Windows",
      "Release notes: Gemini now works with Gmail",
      "Our economic blueprint is now available for teachers",
      "Our new study is now available on GitHub",
      "The annual developer survey is now available for Android",
    ]) {
      assert.equal(isNewPlatformAvailabilityTitle({ url: "https://example.com", title }), false, title);
    }
  });

  it("'users in' só é geo quando seguido de país/região", () => {
    assert.equal(startsWithGeoComplement(" users in Brazil"), true);
    assert.equal(startsWithGeoComplement(" users in the EU"), true);
    assert.equal(startsWithGeoComplement(" all users in Europe"), true);
    assert.equal(startsWithGeoComplement(" users in ChatGPT Plus"), false);
    assert.equal(
      isNewPlatformAvailabilityTitle({ url: "https://example.com", title: "Sora now available for users in Brazil" }),
      false,
    );
  });
});

describe("#9958 — 'como transcrever|resumir' no título → USE MELHOR", () => {
  it("caso real 261009 (exame.com) vira use_melhor", () => {
    const r = bucketAndRule({
      url: "https://exame.com/tecnologia/examelab/chega-de-ouvir-audio-como-transcrever-whatsapp-e-resumir-reunioes-com-ia/",
      title: "Chega de ouvir áudio: como transcrever WhatsApp e resumir reuniões com IA",
      type_hint: "noticia",
    });
    assert.equal(r.bucket, "use_melhor", JSON.stringify(r));
  });

  it("', como resumir' no summary (enumeração) não vira use_melhor — caso real 260611", () => {
    const r = bucketAndRule({
      url: "https://tecnoblog.net/noticias/gemini-no-chrome-chega-ao-brasil-para-auxiliar-navegacao-na-web",
      title: "Gemini no Chrome chega ao Brasil para auxiliar navegação na web",
      summary:
        "Recurso chega para usuários brasileiros. A barra lateral adiciona ferramentas para auxiliar na navegação, como resumir matérias e artigos, comparar produtos",
      type_hint: "noticia",
    });
    assert.notEqual(r.bucket, "use_melhor", JSON.stringify(r));
  });

  it("', como resumir' no título também não dispara", () => {
    const r = bucketAndRule({
      url: "https://example.com/noticia",
      title: "Navegador ganha recursos de IA, como resumir páginas e traduzir textos",
      type_hint: "noticia",
    });
    assert.notEqual(r.bucket, "use_melhor", JSON.stringify(r));
  });
});
