import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  normalizeTitle,
  titleSimilarity,
  extractPastUrls,
  extractPastTitles,
  dedup,
} from "../scripts/dedup.ts";

describe("canonicalize", () => {
  it("remove tracking params utm_*, ref, ref_src", () => {
    assert.equal(
      canonicalize("https://a.com/x?utm_source=twitter&ref=foo&id=1"),
      "https://a.com/x?id=1",
    );
  });

  it("preserva outros query params", () => {
    assert.equal(
      canonicalize("https://a.com/x?id=1&tag=ai"),
      "https://a.com/x?id=1&tag=ai",
    );
  });

  it("remove hash fragment", () => {
    assert.equal(canonicalize("https://a.com/x#section"), "https://a.com/x");
  });

  it("remove trailing slash exceto em root", () => {
    assert.equal(canonicalize("https://a.com/x/"), "https://a.com/x");
    assert.equal(canonicalize("https://a.com/"), "https://a.com/");
  });

  it("converte arxiv /pdf/ pra /abs/", () => {
    assert.equal(
      canonicalize("https://arxiv.org/pdf/2401.12345.pdf"),
      "https://arxiv.org/abs/2401.12345",
    );
  });

  it("retorna URL original se inválida", () => {
    assert.equal(canonicalize("not a url"), "not a url");
  });
});

describe("normalizeTitle", () => {
  it("remove acentos e lowercase", () => {
    assert.equal(normalizeTitle("Ação de Avaliação"), "acao avaliacao");
  });

  it("remove stopwords PT", () => {
    assert.equal(
      normalizeTitle("a casa do futuro em são paulo"),
      "casa futuro sao paulo",
    );
  });

  it("remove stopwords EN", () => {
    assert.equal(normalizeTitle("The future of AI is here"), "future ai here");
  });

  it("colapsa whitespace", () => {
    assert.equal(normalizeTitle("  a   b\n\nc  "), "b c");
  });
});

describe("titleSimilarity", () => {
  it("idênticos retornam 1", () => {
    assert.equal(titleSimilarity("foo bar", "foo bar"), 1);
  });

  it("completamente diferentes retornam baixo", () => {
    const sim = titleSimilarity("OpenAI lança GPT-5", "Brasil vence Copa 2026");
    assert.ok(sim < 0.3, `esperado < 0.3, got ${sim}`);
  });

  it("ignora diferença de acentos", () => {
    const sim = titleSimilarity("ação avaliação", "acao avaliacao");
    assert.equal(sim, 1);
  });

  it("ignora stopwords", () => {
    // Ambos normalizam pra "casa futuro" (a, do são stopwords)
    const sim = titleSimilarity("A casa do futuro", "casa futuro");
    assert.equal(sim, 1);
  });

  it("traduções parciais têm similaridade média", () => {
    const sim = titleSimilarity(
      "Google lança Gemini 3",
      "Google launches Gemini 3",
    );
    assert.ok(sim > 0.4 && sim < 0.95, `esperado entre 0.4 e 0.95, got ${sim}`);
  });

  it("#674: dois títulos que normalizam para vazio retornam 0 (não 1)", () => {
    // Títulos só de stopwords → string vazia após normalizeTitle → maxLen = 0
    const sim = titleSimilarity("o a de para com", "o a de para com");
    assert.equal(sim, 0, "dois títulos degenerados não devem ser tratados como duplicatas");
  });

  it("#674: título vazio vs não-vazio retorna baixo (não 1)", () => {
    const sim = titleSimilarity("...", "OpenAI lança GPT-5");
    assert.ok(sim < 0.5, `esperado < 0.5, got ${sim}`);
  });
});

describe("extractPastUrls", () => {
  const md = `# Passadas

## 2026-04-23 — "Edição de ontem"

Links usados:
- https://a.com/x
- https://b.com/y

## 2026-04-22 — "Anteontem"

Links usados:
- https://c.com/z
- https://a.com/x?utm_source=twitter

## 2026-04-21 — "Três dias atrás"

Links usados:
- https://d.com/old
`;

  it("extrai URLs das primeiras N edições e canonicaliza", () => {
    const urls = extractPastUrls(md, 2);
    assert.ok(urls.has("https://a.com/x"));
    assert.ok(urls.has("https://b.com/y"));
    assert.ok(urls.has("https://c.com/z"));
    assert.ok(!urls.has("https://d.com/old")); // fora da janela
  });

  it("window=1 pega só a última edição", () => {
    const urls = extractPastUrls(md, 1);
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://a.com/x"));
  });

  it("remove pontuação trailing de URLs", () => {
    const m = `## 2026-04-23 — "x"

- https://a.com/x.
- https://b.com/y,
`;
    const urls = extractPastUrls(m, 1);
    assert.ok(urls.has("https://a.com/x"));
    assert.ok(urls.has("https://b.com/y"));
  });

  it("#672: past-editions.md só com header (sem seções) → Set vazio", () => {
    const emptyMd = "# Últimas edições publicadas — para dedup\n\natualizado em: 2026-05-05\n";
    const urls = extractPastUrls(emptyMd, 14);
    assert.equal(urls.size, 0, "header-only MD deve retornar Set vazio (não crashar)");
  });
});

describe("dedup", () => {
  it("pass 0: rejeita agregadores", () => {
    const articles = [
      { url: "https://techcrunch.com/x/ai", title: "ok" },
      { url: "https://therundown.ai/p/something", title: "roundup" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0].url, "https://techcrunch.com/x/ai");
    assert.ok(result.removed[0].dedup_note.includes("agregador"));
  });

  it("pass 1: remove artigos já em edições passadas", () => {
    const articles = [
      { url: "https://a.com/x", title: "já usado" },
      { url: "https://b.com/new", title: "novo" },
    ];
    const past = new Set(["https://a.com/x"]);
    const result = dedup(articles, past, 0.85);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0].url, "https://b.com/new");
  });

  it("pass 2a: URLs duplicadas mantêm fonte cadastrada sobre discovered", () => {
    const articles = [
      { url: "https://a.com/x", title: "A", discovered_source: true },
      { url: "https://a.com/x", title: "A longer title", discovered_source: false },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0].discovered_source, false);
  });

  it("pass 2b: títulos similares colapsam, preferindo fonte cadastrada", () => {
    const articles = [
      { url: "https://a.com/1", title: "OpenAI lança GPT-5", discovered_source: true },
      { url: "https://b.com/2", title: "OpenAI lança GPT-5", discovered_source: false },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0].url, "https://b.com/2");
  });

  it("artigos sem título passam direto pela pass 2b", () => {
    const articles = [
      { url: "https://a.com/1" },
      { url: "https://b.com/2" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 2);
  });

  it("threshold alto não agrupa títulos levemente similares", () => {
    const articles = [
      { url: "https://a.com/1", title: "OpenAI anuncia novidade A" },
      { url: "https://b.com/2", title: "Google anuncia novidade B" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 2);
  });
});

describe("extractPastTitles (#231)", () => {
  const sampleMd = `# Últimas edições

## 2026-04-27 — "Pode confiar no ChatGPT para cuidar da sua saúde?"

Links usados:
- https://example.com/a

---

## 2026-04-26 — "OpenAI lança GPT-5.5 com foco em agentes"

Links usados:
- https://example.com/b

---
`;

  it("extrai títulos das edições mais recentes", () => {
    const titles = extractPastTitles(sampleMd, 2);
    assert.equal(titles.length, 2);
    assert.ok(titles[0].includes("ChatGPT"));
    assert.ok(titles[1].includes("GPT-5.5"));
  });

  it("window=1 retorna só o mais recente", () => {
    const titles = extractPastTitles(sampleMd, 1);
    assert.equal(titles.length, 1);
    assert.ok(titles[0].includes("ChatGPT"));
  });
});

describe("dedup pass 2b — inbox title guard (#482)", () => {
  it("dois artigos inbox com URLs diferentes NÃO são deduplicados por título", () => {
    const articles = [
      { url: "https://a.com/1", title: "(inbox)" },
      { url: "https://b.com/2", title: "(inbox)" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    // Ambos devem ser mantidos — URLs diferentes, título compartilhado deve ser ignorado
    assert.equal(result.kept.length, 2);
  });

  it("artigo inbox com URL idêntica a outro ainda é deduplicado (sub-pass 2a)", () => {
    const articles = [
      { url: "https://a.com/x", title: "(inbox)" },
      { url: "https://a.com/x", title: "(inbox)" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 1);
  });

  it("artigo inbox vs artigo normal com URL diferente NÃO colidem por título", () => {
    const articles = [
      { url: "https://a.com/1", title: "(inbox)" },
      { url: "https://b.com/2", title: "OpenAI anuncia GPT-5" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 2);
  });

  it("case-insensitive: '(INBOX)' também é ignorado na comparação de título", () => {
    const articles = [
      { url: "https://a.com/1", title: "(INBOX)" },
      { url: "https://b.com/2", title: "(INBOX)" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 2);
  });
});

describe("dedup Pass 1b — title similarity vs past editions (#231)", () => {
  it("remove artigo com título quase idêntico ao headline de edição anterior", () => {
    const pastTitles = ["OpenAI lança GPT-5 com foco em agentes autônomos"];
    const articles = [
      { url: "https://techcrunch.com/gpt5-review", title: "OpenAI lança GPT-5 com foco em agentes autônomos" },
    ];
    // Título idêntico → sim ≥ 0.70, deve ser removido
    const result = dedup(articles, new Set(), 0.85, pastTitles, 0.70);
    assert.equal(result.kept.length, 0);
    assert.ok(result.removed.some(r => r.dedup_note.includes("headline de edição anterior")));
  });

  it("título parcialmente similar (score ~0.28) NÃO é removido com threshold 0.70", () => {
    // Nota: Levenshtein de títulos PT/EN diferentes tem score baixo (~0.28).
    // Pass 1b é eficaz para títulos quase idênticos, não para paráfrases.
    const pastTitles = ["OpenAI lança GPT-5.5 com foco em agentes"];
    const articles = [
      { url: "https://techcrunch.com/gpt55-review", title: "GPT-5.5 chega com foco em agentes autônomos" },
    ];
    const result = dedup(articles, new Set(), 0.85, pastTitles, 0.70);
    assert.equal(result.kept.length, 1); // mantido — score ~0.28 < 0.70
  });

  it("artigo com tema diferente não é removido", () => {
    const pastTitles = ["OpenAI lança GPT-5.5"];
    const articles = [
      { url: "https://bbc.com/spotify-ai", title: "Spotify e IA: por que não há botão de filtro" },
    ];
    const result = dedup(articles, new Set(), 0.85, pastTitles, 0.70);
    assert.equal(result.kept.length, 1); // mantido — tema diferente
  });

  it("sem pastTitles (default []) não remove por similaridade", () => {
    const articles = [
      { url: "https://a.com/1", title: "Qualquer título" },
    ];
    const result = dedup(articles, new Set(), 0.85); // sem pastTitles
    assert.equal(result.kept.length, 1);
  });
});
