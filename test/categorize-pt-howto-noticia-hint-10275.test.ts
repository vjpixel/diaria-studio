/**
 * #10275 — os padrões PT de how-to/listicle de #10163 (PT_USER_GUIDE_TITLE_RE e
 * os verbos novos de "como <verbo>" só-título) entravam em isTutorialByKeyword,
 * que roda ANTES do check de type_hint=noticia/opiniao em isNewsNotTutorial —
 * notícia ia pra USE MELHOR. Negativos usam os títulos reais citados na issue;
 * os positivos com type_hint=noticia são os casos reais de #10163 que precisam
 * continuar em USE MELHOR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize, categoryToBucket } from "../scripts/lib/launch-heuristics.ts";

type A = Parameters<typeof categorize>[0];
const bucketOf = (a: A) => categoryToBucket(categorize(a));

describe("#10275 — padrões PT de how-to não vencem type_hint de notícia", () => {
  for (const type_hint of ["noticia", "opiniao"] as const) {
    it(`'Samsung anuncia sete funções de IA do Galaxy S27' (${type_hint}) → radar`, () => {
      assert.equal(
        bucketOf({
          url: "https://exemplo-noticias.com.br/tecnologia/samsung-anuncia-sete-funcoes-de-ia-do-galaxy-s27/",
          title: "Samsung anuncia sete funções de IA do Galaxy S27",
          type_hint,
        }),
        "radar",
      );
    });

    it(`'IA na prática: bancos já usam agentes…' (${type_hint}) → radar`, () => {
      assert.equal(
        bucketOf({
          url: "https://exemplo-noticias.com.br/economia/ia-na-pratica-bancos-ja-usam-agentes-para-atender-clientes/",
          title: "IA na prática: bancos já usam agentes para atender clientes",
          type_hint,
        }),
        "radar",
      );
    });

    it(`'Como salvar o jornalismo da IA' (${type_hint}) → radar`, () => {
      assert.equal(
        bucketOf({
          url: "https://exemplo-noticias.com.br/opiniao/como-salvar-o-jornalismo-da-ia/",
          title: "Como salvar o jornalismo da IA",
          type_hint,
        }),
        "radar",
      );
    });
  }

  it("verbo de anúncio anula as demais alternativas de PT_USER_GUIDE ('Google lança … testamos 5 apps')", () => {
    assert.equal(
      bucketOf({
        url: "https://exemplo-noticias.com.br/tecnologia/google-lanca-assistente-testamos-5-apps/",
        title: "Google lança assistente e testamos 5 apps rivais",
        type_hint: "noticia",
      }),
      "radar",
    );
  });
});

describe("#10275 — casos reais de #10163 com type_hint=noticia seguem USE MELHOR", () => {
  it("'Sete funções de IA no celular para facilitar a rotina' (260716, noticia)", () => {
    assert.equal(
      bucketOf({
        url: "https://exame.com/tecnologia/examelab/sete-funcoes-de-ia-no-celular-para-facilitar-a-rotina/",
        title: "Sete funções de IA no celular para facilitar a rotina",
        type_hint: "noticia",
      }),
      "use_melhor",
    );
  });

  it("'…o que você está entregando de graça para a IA e como se proteger' (261014, noticia)", () => {
    assert.equal(
      bucketOf({
        url: "https://g1.globo.com/tecnologia/noticia/2026/10/12/trend-dos-anos-80-no-chatgpt-o-que-voce-esta-entregando-de-graca-para-a-ia-e-como-se-proteger.ghtml",
        title: "'Trend' dos anos 80 no ChatGPT: o que você está entregando de graça para a IA e como se proteger",
        type_hint: "noticia",
      }),
      "use_melhor",
    );
  });

  it("'saiba como salvar o seu' com type_hint=noticia segue USE MELHOR (marcador de chamada ao leitor)", () => {
    assert.equal(
      bucketOf({
        url: "https://canaltech.com.br/inteligencia-artificial/fim-dos-gpts-personalizados-openai-vai-matar-recurso-no-chatgpt-saiba-como-salvar-o-seu/",
        title: "Fim dos GPTs personalizados: OpenAI vai matar recurso no ChatGPT; saiba como salvar o seu",
        type_hint: "noticia",
      }),
      "use_melhor",
    );
  });

  it("'Lovable na prática: o guia…' sem type_hint segue USE MELHOR", () => {
    assert.equal(
      bucketOf({
        url: "https://exame.com/inteligencia-artificial/lovable-na-pratica-o-guia-para-profissionais-criarem-apps-com-inteligencia-artificial/",
        title: "Lovable na prática: o guia para profissionais criarem apps com inteligência artificial",
      }),
      "use_melhor",
    );
  });
});
