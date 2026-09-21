/** Regression coverage for #8594: summary de outra matéria no RADAR. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summaryMatchesArticle } from "../scripts/lib/summary-matches-title.ts";
import { checkRadarSummaryMatchesTitle } from "../scripts/lib/lint-checks/radar-summary-matches-title.ts";
import { enrichArticles } from "../scripts/enrich-inbox-articles.ts";

const EXAME_URL =
  "https://exame.com/inteligencia-artificial/clonagem-de-voz-e-identidade-como-os-golpes-com-ia-mudaram-no-brasil/";
const EXAME_TITLE = "Clonagem de voz e identidade: como os golpes com IA mudaram no Brasil";
const WRONG_SUMMARY =
  "Cofundador da TypeSafe AI, Diogo Almeida ajudou a criar as bases do ChatGPT e Claude; agora, sua nova startup capta US$ 40 milhões para segurança de código · Segundo a CNN, relatório de inteligência feito com IA quase levou as Forças Armadas a um erro grave · Outra matéria qualquer sobre chips e data centers na Ásia";

describe("summaryMatchesArticle (#8594)", () => {
  it("reprova o caso real: digest de outras matérias no item da Exame", () => {
    const r = summaryMatchesArticle({ title: EXAME_TITLE, url: EXAME_URL, summary: WRONG_SUMMARY });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "multi-story-digest");
  });

  it("reprova resumo simples sem relação (2 trechos)", () => {
    const r = summaryMatchesArticle({
      title: EXAME_TITLE,
      url: EXAME_URL,
      summary:
        "Cofundador da TypeSafe AI, Diogo Almeida ajudou a criar as bases do ChatGPT e Claude; agora, sua nova startup capta US$ 40 milhões · Segundo a CNN, relatório de inteligência quase levou as Forças Armadas a erro",
    });
    assert.equal(r.ok, false);
  });

  it("aprova par legítimo PT/PT", () => {
    const r = summaryMatchesArticle({
      title: EXAME_TITLE,
      url: EXAME_URL,
      summary:
        "Golpistas usam clonagem de voz e documentos falsos gerados por IA para enganar bancos e vítimas; casos de fraude de identidade cresceram no Brasil neste ano.",
    });
    assert.equal(r.ok, true);
  });

  it("aprova título EN com summary PT quando há entidades em comum", () => {
    const r = summaryMatchesArticle({
      title: "OpenAI launches GPT-5.6 Sol for developers",
      url: "https://openai.com/index/gpt-5-6-sol/",
      summary:
        "A OpenAI lançou o GPT-5.6 Sol, modelo voltado a desenvolvedores, com janela de contexto maior e preço menor por token na API.",
    });
    assert.equal(r.ok, true);
  });

  it("summary vazio ou pouca evidência não acusa", () => {
    assert.equal(summaryMatchesArticle({ title: "X", url: "https://a.com/x", summary: "" }).ok, true);
    assert.equal(summaryMatchesArticle({ title: "Oi", url: "https://a.com/x", summary: "Texto curto qualquer." }).ok, true);
  });
});

describe("checkRadarSummaryMatchesTitle (#8594)", () => {
  it("acusa o item do caso real e poupa o legítimo", () => {
    const md = [
      "**RADAR**",
      "",
      `[${EXAME_TITLE}](${EXAME_URL}) ${WRONG_SUMMARY}`,
      "",
      "[OpenAI lança GPT-5.6 Sol para desenvolvedores](https://openai.com/index/gpt-5-6-sol/) A OpenAI lançou o GPT-5.6 Sol, modelo voltado a desenvolvedores, com contexto maior e preço menor na API.",
      "",
    ].join("\n");
    const r = checkRadarSummaryMatchesTitle(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].url, EXAME_URL);
  });
});

describe("enrichArticles descarta summary trocado (#8594)", () => {
  it("esvazia o summary, registra em stats e tenta refetch", async () => {
    const html = `<html><head><meta property="og:description" content="Golpistas usam clonagem de voz e identidade falsa gerada por IA para fraudar vítimas no Brasil, alertam especialistas em segurança."></head></html>`;
    const { articles, stats } = await enrichArticles(
      [{ url: EXAME_URL, title: EXAME_TITLE, summary: WRONG_SUMMARY, source: "Exame" }],
      async () => html,
    );
    assert.deepEqual(stats.summary_discarded, [EXAME_URL]);
    assert.ok(!/TypeSafe/.test(String(articles[0].summary ?? "")));
  });

  it("não toca summary legítimo", async () => {
    const good =
      "Golpistas usam clonagem de voz e documentos falsos gerados por IA para enganar bancos e vítimas no Brasil.";
    const { articles, stats } = await enrichArticles(
      [{ url: EXAME_URL, title: EXAME_TITLE, summary: good, source: "Exame" }],
      async () => null,
    );
    assert.equal(stats.summary_discarded, undefined);
    assert.equal(articles[0].summary, good);
  });
});

import { shouldDiscardSummary } from "../scripts/lib/summary-matches-title.ts";

describe("shouldDiscardSummary: só com evidência positiva (#8594)", () => {
  const paraphrases: Array<[string, string, string]> = [
    ["OpenAI lança GPT-5.6 Sol", "https://openai.com/index/gpt-5-6-sol/", "A empresa apresentou um novo modelo voltado a desenvolvedores, com contexto maior e preço menor por token na API."],
    ["Nvidia anuncia nova GPU para data centers", "https://nvidia.com/blog/x", "A fabricante de chips detalhou o novo acelerador, pensado para treinar modelos grandes com menos energia por operação."],
    ["Google lança tutor de IA", "https://blog.google/products/tutor/", "O assistente foi pensado para estudantes e ajuda a resolver exercícios passo a passo, com explicações adaptadas ao nível da turma."],
    ["Senado aprova regulação da IA", "https://www.senado.leg.br/noticias/materias/2026/09/10/regulacao-ia", "O marco legal define obrigações para desenvolvedores e prevê multas proporcionais ao faturamento das empresas infratoras."],
  ];
  for (const [title, url, summary] of paraphrases) {
    it(`paráfrase não é descartada: ${title}`, () => {
      assert.equal(shouldDiscardSummary({ title, url, summary }, []).discard, false);
    });
  }

  it("digest multi-matéria com 1º trecho sem relação é descartado (separadores | e –)", () => {
    const s = "Cofundador da TypeSafe AI capta US$ 40 milhões para segurança de código | Relatório de inteligência feito com IA quase levou as Forças Armadas a erro | Chips e data centers na Ásia";
    assert.equal(shouldDiscardSummary({ title: EXAME_TITLE, url: EXAME_URL, summary: s }).discard, true);
    const s2 = s.replaceAll(" | ", " – ");
    assert.equal(shouldDiscardSummary({ title: EXAME_TITLE, url: EXAME_URL, summary: s2 }).discard, true);
  });

  it("digest cujo 1º trecho é curto usa o 1º trecho com >= 20 chars", () => {
    const s = "Resumo · Cofundador da TypeSafe AI capta US$ 40 milhões para segurança de código · Relatório de inteligência feito com IA quase levou as Forças Armadas a erro";
    assert.equal(shouldDiscardSummary({ title: EXAME_TITLE, url: EXAME_URL, summary: s }).discard, true);
  });

  it("descarta quando o summary casa claramente com OUTRO item do lote", () => {
    const own = { title: EXAME_TITLE, url: EXAME_URL, summary: "Cofundador da TypeSafe AI, Diogo Almeida, capta US$ 40 milhões para startup de segurança de código gerado por IA" };
    const other = { title: "TypeSafe AI capta US$ 40 milhões para segurança de código", url: "https://techcrunch.com/typesafe-ai-capta-40-milhoes" };
    const d = shouldDiscardSummary(own, [own, other]);
    assert.equal(d.discard, true);
    assert.equal(d.otherUrl, other.url);
  });

  it("no-overlap simples NUNCA descarta", () => {
    const r = shouldDiscardSummary({ title: EXAME_TITLE, url: EXAME_URL, summary: "Texto totalmente diferente sobre culinária italiana e massas artesanais feitas em casa com ingredientes frescos." }, []);
    assert.equal(r.discard, false);
  });
});

describe("refinos do heurístico (#8594)", () => {
  it("sigla de 3 letras casa como palavra inteira, não como substring", () => {
    const t = "Nvidia e AWS ampliam parceria de nuvem para treinar modelos";
    const u = "https://blog.example.com/nvidia-aws-parceria-nuvem";
    assert.equal(summaryMatchesArticle({ title: t, url: u, summary: "A AWS vai oferecer as novas GPUs em regiões adicionais neste trimestre para clientes corporativos globais." }).ok, true);
    assert.equal(summaryMatchesArticle({ title: "Como a AWS cresce no mercado de nuvem corporativa", url: "https://b.example.com/aws-cresce", summary: "Bawsome cawsual jawsome palavras aleatórias sem relação nenhuma com o assunto original do texto aqui." }).ok, false);
  });

  it("hífen: compara as partes (open-source -> open/source)", () => {
    const r = summaryMatchesArticle({
      title: "Modelo open-source supera concorrentes em benchmarks de código",
      url: "https://blog.example.com/modelo-open-source-benchmarks-codigo",
      summary: "O novo modelo aberto tem código-fonte open e licença permissiva, além de resultados fortes em benchmarks públicos de programação.",
    });
    assert.equal(r.ok, true);
  });

  it("número curto e extensão .ghtml da URL não são evidência", () => {
    const r = summaryMatchesArticle({
      title: "Governo publica decreto sobre uso de inteligência artificial",
      url: "https://g1.globo.com/tecnologia/noticia/2026/09/10/1234-abc.ghtml",
      summary: "Em 2026 a empresa registrou 1234 pedidos e ghtml html de cafeteiras elétricas vendidas durante o trimestre inteiro no país.",
    });
    assert.equal(r.ok, false);
  });

  it("menção só ao veículo/host não é evidência", () => {
    const r = summaryMatchesArticle({
      title: "Clonagem de voz e identidade: como os golpes com IA mudaram",
      url: EXAME_URL,
      summary: "Segundo a Exame, a cotação do dólar fechou em alta e o Ibovespa recuou com investidores atentos ao cenário fiscal do país.",
    });
    assert.equal(r.ok, false);
  });

  it("título curto = pouca evidência: não acusa", () => {
    assert.equal(summaryMatchesArticle({ title: "Sora 3", url: "https://a.com/x", summary: "Um texto qualquer bem longo sobre outra coisa completamente diferente do título curto." }).ok, true);
  });
});

describe("enrichArticles: restauração e isenções (#8594)", () => {
  const digest = "Cofundador da TypeSafe AI capta US$ 40 milhões para segurança de código · Relatório de inteligência feito com IA quase levou as Forças Armadas a erro · Chips e data centers na Ásia";

  it("refetch que falha restaura o original e registra summary_restored", async () => {
    const { articles, stats } = await enrichArticles(
      [{ url: EXAME_URL, title: EXAME_TITLE, summary: digest, source: "Exame" }],
      async () => null,
    );
    assert.equal(articles[0].summary, digest);
    assert.deepEqual(stats.summary_discarded, [EXAME_URL]);
    assert.deepEqual(stats.summary_restored, [EXAME_URL]);
    assert.equal(articles[0].summary_rejected, undefined);
  });

  it("refetch que preenche mantém o novo e guarda o original em summary_rejected", async () => {
    const html = `<html><head><meta property="og:description" content="Golpistas usam clonagem de voz e identidade falsa gerada por IA para fraudar vítimas no Brasil, alertam especialistas."></head></html>`;
    const { articles, stats } = await enrichArticles(
      [{ url: EXAME_URL, title: EXAME_TITLE, summary: digest, source: "Exame" }],
      async () => html,
    );
    assert.match(String(articles[0].summary), /Golpistas/);
    assert.equal(articles[0].summary_rejected, digest);
    assert.equal(stats.summary_restored, undefined);
  });

  it("inbox e newsletter_extracted são isentos", async () => {
    const { articles, stats } = await enrichArticles(
      [
        { url: EXAME_URL, title: EXAME_TITLE, summary: digest, flag: "editor_submitted" },
        { url: EXAME_URL + "b", title: EXAME_TITLE, summary: digest, flag: "newsletter_extracted" },
      ],
      async () => null,
    );
    assert.equal(stats.summary_discarded, undefined);
    assert.equal(articles[0].summary, digest);
    assert.equal(articles[1].summary, digest);
  });
});
