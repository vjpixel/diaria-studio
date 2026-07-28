/**
 * review-highlight-official-swap.test.ts (#4135 item 3)
 *
 * Regressão (#633): edição com destaque apontando pra domínio de imprensa +
 * artigo de domínio oficial sobre o MESMO tema no pool → gate sugere a troca.
 *
 * Caso real (edição 260727, #4080/#4135): D2 apontava para o Tecnoblog
 * (cobertura de imprensa) do lançamento do Claude Opus 5, enquanto o anúncio
 * oficial (anthropic.com/news/claude-opus-5, score 72) estava no pool RADAR,
 * a um bucket de distância. Textos simplificados (fixture direto, sem fetch
 * ao vivo) — a única propriedade que importa pro teste é a similaridade de
 * tema (Jaccard) suficiente para o matcher reusado de dedup-intra-edition.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findOfficialSwapSuggestions } from "../scripts/review-highlight-official-swap.ts";

const TECNOBLOG_URL = "https://tecnoblog.net/noticias/claude-opus-5-anthropic/";
const TECNOBLOG_TITLE = "Claude Opus 5 é lançado com foco no desempenho e controle de custos";
const ANTHROPIC_URL = "https://anthropic.com/news/claude-opus-5";
const ANTHROPIC_TITLE = "Anthropic lança Claude Opus 5 com foco em desempenho e custos";

describe("findOfficialSwapSuggestions — cross-check pool da edição (#4135 item 3)", () => {
  it("sugere a troca quando o destaque é imprensa e o oficial do MESMO tema está no pool (caso real 260727)", () => {
    const categorized = {
      highlights: [
        {
          rank: 1,
          article: { url: TECNOBLOG_URL, title: TECNOBLOG_TITLE },
        },
      ],
      radar: [
        { url: ANTHROPIC_URL, title: ANTHROPIC_TITLE, score: 72 },
      ],
      lancamento: [],
    };

    const { total, suggestions } = findOfficialSwapSuggestions(categorized);
    assert.equal(total, 1);
    assert.equal(suggestions.length, 1, "deve sugerir a troca pro oficial do pool");
    assert.equal(suggestions[0].highlight_url, TECNOBLOG_URL);
    assert.equal(suggestions[0].official_url, ANTHROPIC_URL);
    assert.equal(suggestions[0].source, "pool");
  });

  it("NÃO sugere quando o destaque JÁ é domínio oficial", () => {
    const categorized = {
      highlights: [
        { rank: 1, article: { url: ANTHROPIC_URL, title: ANTHROPIC_TITLE } },
      ],
      radar: [{ url: "https://canaltech.com.br/ia/claude-opus-5", title: TECNOBLOG_TITLE }],
    };
    const { suggestions } = findOfficialSwapSuggestions(categorized);
    assert.equal(suggestions.length, 0, "destaque já oficial não precisa de troca");
  });

  it("NÃO sugere quando não há artigo oficial no pool (só imprensa)", () => {
    const categorized = {
      highlights: [{ rank: 1, article: { url: TECNOBLOG_URL, title: TECNOBLOG_TITLE } }],
      radar: [
        { url: "https://canaltech.com.br/ia/claude-opus-5", title: "Claude Opus 5: veja o que muda" },
      ],
    };
    const { suggestions } = findOfficialSwapSuggestions(categorized);
    assert.equal(suggestions.length, 0, "sem candidato oficial no pool, sem sugestão");
  });

  it("NÃO sugere quando o artigo oficial no pool é sobre um TEMA diferente", () => {
    const categorized = {
      highlights: [{ rank: 1, article: { url: TECNOBLOG_URL, title: TECNOBLOG_TITLE } }],
      radar: [
        {
          // Mesma empresa (Anthropic), tema completamente diferente — não deve casar.
          url: "https://anthropic.com/news/economic-index-update",
          title: "Anthropic publica atualização do índice econômico de uso de IA",
        },
      ],
    };
    const { suggestions } = findOfficialSwapSuggestions(categorized);
    assert.equal(suggestions.length, 0, "mesmo domínio oficial mas tema diferente não deve sugerir troca");
  });

  it("encontra o candidato oficial via cluster_sources[] já dobrado pelo dedup intra-edição (#4185)", () => {
    // Simula o cenário em que dedup-intra-edition.ts já rodou ANTES deste
    // guard e fundiu o item oficial do pool como cluster_source do destaque
    // (mesmo matcher — o fold só acontece quando já confirmou mesmo evento).
    const categorized = {
      highlights: [
        {
          rank: 1,
          article: {
            url: TECNOBLOG_URL,
            title: TECNOBLOG_TITLE,
            cluster_sources: [{ url: ANTHROPIC_URL, title: ANTHROPIC_TITLE }],
          },
        },
      ],
      radar: [], // já esvaziado pelo dedup — o oficial só sobrevive em cluster_sources
    };
    const { suggestions } = findOfficialSwapSuggestions(categorized);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].official_url, ANTHROPIC_URL);
    assert.equal(suggestions[0].source, "cluster_source");
  });

  it("encontra cluster_sources[] no shape FLAT (sem wrapper article, #229)", () => {
    const categorized = {
      highlights: [
        {
          rank: 1,
          url: TECNOBLOG_URL,
          title: TECNOBLOG_TITLE,
          cluster_sources: [{ url: ANTHROPIC_URL, title: ANTHROPIC_TITLE }],
        },
      ],
      radar: [],
    };
    const { suggestions } = findOfficialSwapSuggestions(categorized as never);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].official_url, ANTHROPIC_URL);
    assert.equal(suggestions[0].source, "cluster_source");
  });

  it("respeita destaqueCount — não sugere troca para candidatos fora do top-N", () => {
    const categorized = {
      highlights: [
        { rank: 1, article: { url: "https://openai.com/index/gpt-6", title: "OpenAI lança GPT-6" } },
        { rank: 2, article: { url: "https://openai.com/index/other", title: "OpenAI lança outra coisa" } },
        { rank: 3, article: { url: "https://openai.com/index/third", title: "OpenAI lança terceira coisa" } },
        { rank: 4, article: { url: TECNOBLOG_URL, title: TECNOBLOG_TITLE } },
      ],
      radar: [{ url: ANTHROPIC_URL, title: ANTHROPIC_TITLE }],
    };
    const { total, suggestions } = findOfficialSwapSuggestions(categorized, { destaqueCount: 3 });
    assert.equal(total, 3);
    assert.equal(suggestions.length, 0, "rank 4 está fora do top-3, não deve ser comparado");
  });

  it("tolera highlights sem url/title (skip silencioso)", () => {
    const categorized = {
      highlights: [{ rank: 1, article: { title: "sem url" } }],
      radar: [{ url: ANTHROPIC_URL, title: ANTHROPIC_TITLE }],
    };
    const { suggestions } = findOfficialSwapSuggestions(categorized);
    assert.equal(suggestions.length, 0);
  });
});
