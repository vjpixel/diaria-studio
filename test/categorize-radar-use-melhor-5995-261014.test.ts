/**
 * #5995 / #10163 (rodada 14/10/2026) — direção RADAR → USE MELHOR decidida pelo
 * editor: how-to/listicle em PT para usuário final que caía em
 * `noticias-default` (ou no tie-breaker #8211, que só escolhe entre
 * lançamento/radar).
 *
 * Cada caso positivo é um item REAL do corpus que o editor publicou em USE
 * MELHOR (gabarito do #8419: seção final em `02-reviewed.md`) e que o
 * categorizador de master (673f9b94d) ainda mandava pra RADAR quando
 * reaplicado. Título cru, URL, summary e `type_hint` vêm de
 * `_internal/01-categorized.json`. Os negativos fixam o LIMITE de cada regra —
 * em particular as variantes testadas e REJEITADAS por regredir no corpus.
 *
 * Medição (replay de `categorizeWithRule()` sobre 118 edições):
 *   gabarito #8419 (02-reviewed.md, 757 pares): 669 → 679, 10 melhorias, 0 regressões;
 *   resíduo radar→use_melhor 15 → 9.
 *   gabarito Stage 1 (01-approved.json, 4.629 pares): 4343 → 4351, 9 melhorias,
 *   1 "regressão" ("Como passar pela triagem…", 260728) que o editor moveu pra
 *   USE MELHOR depois, no Stage 4 — o publicado é a decisão final.
 * "^Como funciona o/a X" ficou de fora (ver comentário em PT_USER_GUIDE_TITLE_RE).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize, categorizeWithRule, categoryToBucket } from "../scripts/lib/launch-heuristics.ts";

type A = Parameters<typeof categorize>[0];
const bucketOf = (a: A) => categoryToBucket(categorize(a));

// `rule`: regra esperada. O techtudo `/guia/` (260902) cai em `tutorial-pattern`
// (TUTORIAL_PATTERNS): o padrão já existia, mas `isNewsNotTutorial` o bloqueava
// pelo type_hint=noticia — o sinal novo de título faz o how-to vencer o hint.
const POSITIVE: Array<{ edition: string; article: A; rule?: string }> = [
  {
    edition: "260702",
    article: {
      url: "https://prepara.com.br/blog/ia/ia-para-iniciantes-por-onde-comecar/",
      title: "IA para iniciantes: por onde começar do zero",
    },
  },
  {
    edition: "260702",
    article: {
      url: "https://www.techtudo.com.br/listas/2026/04/ia-para-criar-aplicativos-testamos-7-plataformas-e-elegemos-a-melhor-edapps.ghtml",
      title: "IA para criar apps: testei 7 ferramentas",
    },
  },
  {
    edition: "260716",
    article: {
      url: "https://exame.com/tecnologia/examelab/sete-funcoes-de-ia-no-celular-para-facilitar-a-rotina/",
      title: "Sete funções de IA no celular para facilitar a rotina",
      summary: "Recursos nativos de Android e iPhone já resumem notificações e organizam a agenda sem depender de apps externos",
      type_hint: "noticia",
    },
  },
  {
    edition: "260728",
    article: {
      url: "https://exame.com/carreira/e-possivel-vencer-a-gupy-como-passar-pela-triagem-sem-tentar-enganar-a-ia/",
      title: "É possível vencer a Gupy? Como passar pela triagem sem tentar ‘enganar’ a IA",
      summary: "Currículo completo, resultados concretos e aderência à vaga pesam mais do que truques para vencer o algoritmo",
    },
  },
  {
    edition: "260806",
    article: {
      url: "https://exame.com/inteligencia-artificial/lovable-na-pratica-o-guia-para-profissionais-criarem-apps-com-inteligencia-artificial/",
      title: "Lovable na prática: o guia para profissionais criarem apps com inteligência artificial",
      summary:
        "Ferramenta de inteligência artificial permite criar sistemas, dashboards e automações a partir de comandos escritos em português ou inglês",
    },
  },
  {
    edition: "260902",
    article: {
      url: "https://www.techtudo.com.br/guia/2026/08/ia-para-estudos-conheca-ferramentas-que-podem-ajudar-a-aprender-melhor-edsoftwares.ghtml",
      title: "IA para estudos: conheça ferramentas que podem ajudar a aprender melhor",
      summary:
        "Descubra apps e chatbots indicados para resumos, redações e organização da vida acadêmica, sem substituir o raciocínio próprio na hora de resolver provas e exercícios",
      type_hint: "noticia",
    },
    rule: "tutorial-pattern",
  },
  {
    edition: "260904",
    article: {
      url: "https://exame.com/inteligencia-artificial/sua-ia-concorda-demais-entenda-o-vies-de-bajulacao-e-como-obter-respostas-criticas/",
      title: "Sua IA concorda demais? Entenda o viés de bajulação e como obter respostas críticas",
      summary:
        "O comportamento conhecido como sycophancy ganhou atenção após casos envolvendo modelos de IA e pode ser reduzido com instruções mais específicas nos prompts",
    },
  },
  {
    edition: "260915",
    article: {
      url: "https://canaltech.com.br/apps/como-gravar-transcrever-e-resumir-reunioes-com-ia/",
      title: "Como gravar, transcrever e resumir reuniões com IA",
      summary:
        "As plataformas de videoconferência incorporaram recursos de inteligência artificial para automatizar o registro de reuniões de trabalho.",
    },
  },
  {
    edition: "260929",
    article: {
      url: "https://canaltech.com.br/inteligencia-artificial/fim-dos-gpts-personalizados-openai-vai-matar-recurso-no-chatgpt-saiba-como-salvar-o-seu/",
      title: "Fim dos GPTs personalizados: OpenAI vai matar recurso no ChatGPT; saiba como salvar o seu",
      summary:
        "A OpenAI anunciou o fim dos GPTs personalizados no ChatGPT, recurso que permite criar versões customizadas do chatbot com instruções, arquivos e configurações específicas.",
    },
  },
  {
    edition: "261014",
    article: {
      url: "https://g1.globo.com/tecnologia/noticia/2026/10/12/trend-dos-anos-80-no-chatgpt-o-que-voce-esta-entregando-de-graca-para-a-ia-e-como-se-proteger.ghtml",
      title: "'Trend' dos anos 80 no ChatGPT: o que você está entregando de graça para a IA e como se proteger",
      summary:
        "Milhões de pessoas em todo o mundo têm usado o ChatGPT e outras ferramentas com inteligência artificial para transformar suas selfies em fotos retrô, mas especialistas alertam que os usuários podem estar compartilhando muito mais do que imaginam.",
      type_hint: "noticia",
    },
  },
];

describe("#5995/#10163 261014 — how-to/listicle PT para usuário final vira USE MELHOR", () => {
  for (const { edition, article, rule = "tutorial-keyword" } of POSITIVE) {
    it(`CASO REAL ${edition}: '${article.title}' → use_melhor (${rule})`, () => {
      assert.equal(bucketOf(article), "use_melhor");
      assert.equal(categorizeWithRule(article).rule, rule);
    });
  }
});

describe("#5995/#10163 261014 — limites (variantes testadas e rejeitadas no corpus)", () => {
  it("'N coisas que' NÃO é sinal: 'Sete coisas que você nunca deve digitar no ChatGPT' (260727) segue RADAR", () => {
    assert.equal(
      bucketOf({
        url: "https://veja.abril.com.br/coluna/planeta-ia/sete-coisas-que-voce-nunca-deve-digitar-no-chatgpt/",
        title: "Sete coisas que você nunca deve digitar no ChatGPT",
        summary:
          "A lista que vale para quem usa a ferramenta todo dia, mais os quatro ajustes de configuração que reduzem o risco em menos de cinco minutos",
      }),
      "radar",
    );
  });

  it("'N melhores ferramentas' NÃO é sinal: '16 melhores ferramentas de IA para ganhar tempo em 2026' (260730) segue RADAR", () => {
    assert.equal(
      bucketOf({
        url: "https://conteudo.stone.com.br/ferramentas-de-ia/",
        title: "16 melhores ferramentas de IA para ganhar tempo em 2026",
        summary: "Se você usa um computador com sistema Windows no escritório da loja, o Copilot já está integrado à sua máquina.",
        type_hint: "noticia",
      }),
      "radar",
    );
  });

  it("'veja como se inscrever' NÃO é sinal: 'UnB abre 150 vagas para residência em IA' (260617) segue RADAR", () => {
    assert.equal(
      bucketOf({
        url: "https://g1.globo.com/df/distrito-federal/noticia/2026/06/15/unb-abre-150-vagas-para-residencia-em-inteligencia-artificial-com-bolsa-de-r-15-mil-veja-como-se-inscrever.ghtml",
        title: "UnB abre 150 vagas para residência em Inteligência Artificial",
        summary: "Programa gratuito tem inscrições até 29 de junho, aulas presenciais no campus Gama e início previsto para agosto.",
        type_hint: "noticia",
      }),
      "radar",
    );
  });

  it("'como funciona' só ABRINDO o título: no meio da manchete é explicador de notícia e segue RADAR", () => {
    assert.equal(
      bucketOf({
        url: "https://exemplo-noticias.com.br/tecnologia/nova-lei-de-ia-o-que-muda-e-como-funciona-a-fiscalizacao/",
        title: "Nova lei de IA: o que muda e como funciona a fiscalização",
        type_hint: "noticia",
      }),
      "radar",
    );
  });

  it("verbos novos de 'como <verbo>' respeitam a vírgula: ', como se proteger' (enumeração) não dispara", () => {
    assert.equal(
      bucketOf({
        url: "https://exemplo-noticias.com.br/tecnologia/especialistas-debatem-riscos-da-ia/",
        title: "Especialistas debatem riscos da IA, como se proteger de golpes e regulação",
        type_hint: "noticia",
      }),
      "radar",
    );
  });
});
