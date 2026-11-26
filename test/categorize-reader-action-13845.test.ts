/**
 * #13845 — conteúdo que propõe AÇÃO CONCRETA ao leitor (o quê no título +
 * onde no texto) vai ao USE MELHOR mesmo sendo notícia (decisão do editor de
 * 25/11/2026). Fixtures resumidas de `_internal/01-categorized.json` das
 * edições citadas (título/summary/URL como chegaram ao categorizer, entidades
 * HTML cruas inclusive).
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { categorizeWithRule, proposesReaderAction, type Article } from "../scripts/lib/launch-heuristics.ts";
import { categorizeArticles } from "../scripts/categorize.ts";
import { applyStage2Caps, STAGE_2_MAX_USE_MELHOR } from "../scripts/lib/apply-stage2-caps.ts";

function cat(a: Partial<Article>) {
  return categorizeWithRule({ summary: "", ...a } as Article);
}

const GEMINI_261123: Partial<Article> = {
  url: "https://canaltech.com.br/inteligencia-artificial/veja-o-que-o-gemini-sabe-sobre-voce/",
  title: "O que o Gemini sabe sobre você? Veja como acessar e apagar a memória da IA",
  summary:
    "Voc&ecirc; sabe quais informa&ccedil;&otilde;es o Gemini guarda sobre voc&ecirc;? O Google lan&ccedil;ou um painel que facilita a consulta e a edi&ccedil;&atilde;o desses dados.",
  source: "Canaltech (IA)",
};

describe("#13845: ação concreta do leitor → USE MELHOR", () => {
  it("261123: memória do Gemini (RADAR → USE MELHOR pelo editor) vai para use_melhor", () => {
    const r = cat(GEMINI_261123);
    assert.equal(r.category, "tutorial");
    assert.equal(r.rule, "reader-action");
    const buckets = categorizeArticles([{ ...GEMINI_261123 } as Article]);
    assert.equal(buckets.use_melhor.length, 1);
    assert.equal(buckets.radar.length, 0);
  });

  it("261027: 'Veja como bloquear resumos automáticos e limpar a busca' (USE MELHOR no gate 4)", () => {
    const r = cat({
      url: "https://canaltech.com.br/inteligencia-artificial/cansou-da-ia-no-google-veja-como-bloquear-resumos-automaticos-e-limpar-a-busca/",
      title: "Cansou da IA no Google? Veja como bloquear resumos automáticos e limpar a busca",
      summary: "Em qualquer pesquisa no Google, a Vis&atilde;o Geral da IA &eacute; o primeiro resultado a aparecer.",
    });
    assert.equal(r.rule, "reader-action");
  });

  it("261116: 'Como adicionar instruções…' abrindo o título, com 'instruções personalizadas' no summary", () => {
    const r = cat({
      url: "https://canaltech.com.br/inteligencia-artificial/como-adicionar-instrucoes-para-que-o-gemini-lembre-de-informacoes-em-qualquer-conversa/",
      title: "Como adicionar instruções para que o Gemini lembre de informações em qualquer conversa?",
      summary: "&Eacute; poss&iacute;vel definir instru&ccedil;&otilde;es personalizadas no Gemini para que a IA siga suas prefer&ecirc;ncias.",
    });
    assert.equal(r.rule, "reader-action");
  });
});

describe("#13845: contraexemplos seguem fora do USE MELHOR", () => {
  it("notícia do lançamento do painel sem instrução ao leitor continua RADAR", () => {
    const a = {
      url: "https://canaltech.com.br/inteligencia-artificial/google-lanca-painel-de-memoria-do-gemini/",
      title: "Google lança painel de memória do Gemini no Brasil",
      summary: "O Google lançou um painel que mostra as informações que a IA usa para personalizar as respostas.",
    } as Article;
    assert.notEqual(cat(a).category, "tutorial");
    assert.equal(categorizeArticles([a]).radar.length, 1);
  });

  it("'veja como' com verbo de ação mas sem o ONDE no texto continua RADAR", () => {
    const a = {
      url: "https://exemplo.com.br/tecnologia/veja-como-acessar-o-novo-modelo",
      title: "Nova IA chinesa supera rivais; veja como acessar o modelo",
      summary: "O modelo foi treinado com menos chips e lidera rankings de raciocínio.",
    } as Article;
    assert.equal(proposesReaderAction(a), false);
    assert.notEqual(cat(a).rule, "reader-action");
  });

  it("'veja como' jornalístico ('veja como a IA vai mudar') não casa", () => {
    assert.equal(
      proposesReaderAction({
        url: "https://exemplo.com.br/x",
        title: "Veja como a IA vai mudar as configurações do mercado de trabalho",
        summary: "Painel de especialistas debate o futuro.",
      } as Article),
      false,
    );
  });

  it("261119: 'veja como investir' (RADAR no gate 4) não é ação sobre conta/dado do leitor", () => {
    const r = cat({
      url: "https://exemplo.com.br/mercado/ipo-anthropic-bdr",
      title: "IPO da Anthropic: veja como investir na criadora do Claude por meio de BDRs no Brasil",
      summary: "Investidores brasileiros podem acessar a conta na corretora.",
      type_hint: "noticia",
    });
    assert.notEqual(r.rule, "reader-action");
  });

  it("'como explorar falhas' (o atacante age, não o leitor) não casa (#11116)", () => {
    assert.equal(
      proposesReaderAction({
        url: "https://exemplo.com.br/seguranca/x",
        title: "Pesquisadores mostram como acessar as falhas do painel de controle do roteador",
        summary: "A configuração padrão deixa o aparelho exposto.",
      } as Article),
      false,
    );
  });
});

describe("#13845: LANÇAMENTOS e cap de USE MELHOR intocados", () => {
  it("domínio oficial com ação do leitor segue o bloco de LANÇAMENTO (regra não roda antes dele)", () => {
    const r = cat({
      url: "https://blog.google/products/gemini/gemini-memory-controls/",
      title: "New memory controls in Gemini: see how to manage what Gemini remembers. Veja como apagar a memória no painel",
      summary: "Today we're rolling out a new panel in settings.",
      type_hint: "lancamento",
    });
    assert.equal(r.category, "lancamento");
    assert.notEqual(r.rule, "reader-action");
  });

  it("cap máximo de USE MELHOR segue valendo com candidatos reader-action extras", () => {
    const extra = Array.from({ length: 6 }, (_, i) => ({
      url: `https://site${i}.com.br/x/veja-como-apagar-${i}`,
      title: `Veja como apagar o histórico da IA ${i}`,
      summary: "No painel de configurações.",
    }));
    const buckets = categorizeArticles(extra as Article[]);
    assert.equal(buckets.use_melhor.length, 6);
    const { approved } = applyStage2Caps({
      highlights: [{ url: "https://h/1" }, { url: "https://h/2" }, { url: "https://h/3" }],
      lancamento: [],
      radar: [],
      use_melhor: buckets.use_melhor,
      runners_up: [],
    } as never);
    assert.ok((approved.use_melhor?.length ?? 0) <= STAGE_2_MAX_USE_MELHOR);
  });
});
