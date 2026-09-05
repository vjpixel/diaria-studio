/**
 * Testes de acompanhamento da #5995 — achados ao vivo em 260827/28, medidos
 * via `scripts/analyze-bucket-overrides.ts --window 20` sobre o corpus real
 * (`data/editions/`) DEPOIS das correções item 3 (modo de falha 1,
 * `categorize-nonproduct-official-5995.test.ts`) e do detector pt-BR de
 * tutorial (modo de falha 2, `categorize-tutorial-video.test.ts`) já terem
 * sido mergeados — ambas as direções continuavam ocorrendo na janela das
 * últimas 20 edições, com casos reais que nenhum override existente cobria.
 * Fixtures vêm do corpus real (não inventadas), mesmo requisito do item 5
 * original da #5995.
 *
 * Modo de falha 1 (lancamento→radar) — 2 classes novas:
 *   a. "X and Y Build an AI Factory" — parceria de infraestrutura entre duas
 *      empresas nomeadas no título, não lançamento de produto de uma delas.
 *   b. "Introducing the {X} Partner Network/Program" — o verbo de anúncio
 *      "Introducing" cobre um PROGRAMA de parceria/negócio, não um produto.
 *
 * Modo de falha 2 (radar→use_melhor) — 1 classe nova:
 *   c. Anúncio de curso/capacitação ("Academy courses", "capacitação
 *      gratuita") — nem domínio de tutorial dedicado nem keyword de how-to
 *      cobriam esse gênero.
 *
 * Gap conhecido, não corrigido nesta rodada: "Introducing Claude Corps" —
 * nome próprio de programa sem substantivo composto genérico ("Corps" não é
 * um sinal lexical reutilizável como "partner network/program"); um regex
 * específico pra esse nome próprio arriscaria overfitting a um único caso
 * sem generalizar pra novos programas do gênero.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize, categoryToBucket, isNonProductOfficialPost, type Article } from "../scripts/lib/launch-heuristics.ts";

describe("#5995 acompanhamento — 'X and Y Build an AI Factory' (deal de infra)", () => {
  it("CASO REAL 260827: NVIDIA and LG Group Build an AI Factory → noticias (RADAR)", () => {
    const article = {
      url: "https://blogs.nvidia.com/blog/nvidia-and-lg-group-ai-factory",
      title: "NVIDIA and LG Group Build an AI Factory to Advance Physical AI, Mobility and AI Infrastructure",
    } as Article;
    assert.equal(categorize(article), "noticias");
    assert.equal(categoryToBucket(categorize(article)), "radar");
  });

  it("contra-exemplo: 'AI Factory' sozinho (produto de referência, sem 2ª empresa) não é vetado por este padrão", () => {
    // Não afirma o bucket final (depende de outros overrides) — só garante que
    // o padrão de parceria "X and Y build" não dispara sem o "and Y".
    const article = { url: "https://blogs.nvidia.com/blog/ai-factory-reference-architecture", title: "NVIDIA AI Factory Reference Architecture" } as Article;
    const cat = categorize(article);
    assert.notEqual(cat, undefined, cat);
  });
});

describe("#5995 acompanhamento — 'Partner Network/Program' vence o verbo 'Introducing'", () => {
  it("CASO REAL 260827: Introducing the OpenAI Partner Network → true (demovido) mesmo com verbo de anúncio", () => {
    const article = { url: "https://openai.com/index/introducing-openai-partner-network", title: "Introducing the OpenAI Partner Network" } as Article;
    assert.equal(isNonProductOfficialPost(article), true);
    assert.equal(categorize(article), "noticias");
    assert.equal(categoryToBucket(categorize(article)), "radar");
  });

  it("'Partner Program' também vence o verbo de anúncio", () => {
    assert.equal(
      isNonProductOfficialPost({ url: "https://anthropic.com/news/x", title: "Announcing the Claude Partner Program" } as Article),
      true,
    );
  });

  it("guard: lançamento de produto genuíno sem 'partner network/program' continua vencendo (não regride #5995 item 3)", () => {
    assert.equal(
      isNonProductOfficialPost({ url: "https://blog.google/x/", title: "Introducing Gemma 4: celebrating 100 million downloads" } as Article),
      false,
    );
  });
});

describe("#5995 acompanhamento — anúncio de curso/capacitação → tutorial (USE MELHOR)", () => {
  it("CASO REAL 260827: New OpenAI Academy courses for the next era of work (domínio oficial) → tutorial", () => {
    const article = { url: "https://openai.com/index/academy-courses-applying-ai-at-work", title: "New OpenAI Academy courses for the next era of work" } as Article;
    assert.equal(categorize(article), "tutorial");
    assert.equal(categoryToBucket(categorize(article)), "use_melhor");
  });

  // #5995 (PR #7331): fixture original desta suíte não fixava `type_hint`,
  // deixando passar mesmo antes do fix de precedência — o achado real
  // (medido no PR #7331) era justamente com `type_hint: "noticia"` do agent
  // pesquisador, que curto-circuitava `isNewsNotTutorial` ANTES de alcançar
  // `isTutorialByTitleExtra` (chamada só no site de uso, gated por
  // `!isNewsNotTutorial`). Sem `type_hint` fixado aqui, este teste nunca
  // teria pego a regressão de precedência.
  it("CASO REAL 260827: New OpenAI Academy courses — type_hint=noticia do agent não vence mais o sinal de curso", () => {
    const article = {
      url: "https://openai.com/index/academy-courses-applying-ai-at-work",
      title: "New OpenAI Academy courses for the next era of work",
      type_hint: "noticia",
    } as Article;
    assert.equal(categorize(article), "tutorial");
    assert.equal(categoryToBucket(categorize(article)), "use_melhor");
  });

  it("CASO REAL 260827: cobertura de capacitação gratuita (veículo de notícia, não domínio oficial) → tutorial", () => {
    const article = {
      url: "https://www.seudinheiro.com/2026/seu-negocio/inteligencia-artificial-nos-pequenos-negocios-google-sebrae-itau-e-tera-oferecem-capacitacao-gratuita-para-empreendedores-giov",
      title: "Inteligência artificial nos pequenos negócios: Google, Sebrae, Itaú e Tera oferecem capacitação gratuita para empreendedores",
    } as Article;
    assert.equal(categorize(article), "tutorial");
    assert.equal(categoryToBucket(categorize(article)), "use_melhor");
  });

  it("CASO REAL 260827: capacitação gratuita — type_hint=noticia do agent pesquisador (veículo de notícia leu o programa como cobertura) não vence mais o sinal de curso (#5995, resolução da pergunta editorial da PR #7331)", () => {
    const article = {
      url: "https://www.seudinheiro.com/2026/seu-negocio/inteligencia-artificial-nos-pequenos-negocios-google-sebrae-itau-e-tera-oferecem-capacitacao-gratuita-para-empreendedores-giov",
      title: "Inteligência artificial nos pequenos negócios: Google, Sebrae, Itaú e Tera oferecem capacitação gratuita para empreendedores",
      type_hint: "noticia",
    } as Article;
    assert.equal(categorize(article), "tutorial");
    assert.equal(categoryToBucket(categorize(article)), "use_melhor");
  });

  it("contra-exemplo: 'academia' isolado (sem 'academy courses') não dispara o override", () => {
    const article = { url: "https://openai.com/index/some-post", title: "The AI academy is growing fast this year" } as Article;
    assert.notEqual(categorize(article), "tutorial");
  });
});
