import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalize,
  normalizeTitle,
  titleSimilarity,
  extractPastUrls,
  extractPastTitles,
  extractPastEditionArticleTitles,
  extractPastDestaqueUrls,
  jaccardSimilarity,
  subjectSimilarity,
  tokenizeForJaccard,
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

describe("tokenizeForJaccard / jaccardSimilarity (#897)", () => {
  it("tokeniza removendo stopwords e tokens curtos", () => {
    const tokens = tokenizeForJaccard("OpenAI lança GPT-5.5 com foco em agentes");
    assert.ok(tokens.has("openai"));
    assert.ok(tokens.has("gpt"));
    assert.ok(tokens.has("foco"));
    assert.ok(tokens.has("agentes"));
    // Tokens curtos descartados
    assert.equal(tokens.has("a"), false);
    assert.equal(tokens.has("em"), false);
  });

  it("Jaccard idênticos = 1", () => {
    const a = tokenizeForJaccard("OpenAI GPT-5 lançamento");
    const b = tokenizeForJaccard("OpenAI GPT-5 lançamento");
    assert.equal(jaccardSimilarity(a, b), 1);
  });

  it("Jaccard sem overlap = 0", () => {
    const a = tokenizeForJaccard("Política eleições Brasil");
    const b = tokenizeForJaccard("Receita bolo chocolate");
    assert.equal(jaccardSimilarity(a, b), 0);
  });

  it("Jaccard parcial — PT-BR vs EN da mesma história", () => {
    // OpenAI lança GPT-5 vs OpenAI launches GPT-5
    // PT: "openai", "lanca", "gpt"
    // EN: "openai", "launches", "gpt"
    // Intersection: openai + gpt = 2; Union: 4 → 0.5
    const a = tokenizeForJaccard("OpenAI lança GPT-5");
    const b = tokenizeForJaccard("OpenAI launches GPT-5");
    const sim = jaccardSimilarity(a, b);
    assert.ok(sim >= 0.4 && sim <= 0.7, `esperado entre 0.4 e 0.7, got ${sim}`);
  });

  it("Set vazio = 0", () => {
    assert.equal(jaccardSimilarity(new Set(), new Set(["a", "b"])), 0);
    assert.equal(jaccardSimilarity(new Set(["a"]), new Set()), 0);
  });

  it("subjectSimilarity wrapper bate com expectativa do issue (#897)", () => {
    // Issue cita exemplo: "Truque Google IA 3x mais rápido" e
    // "Multi-token prediction Gemma 4" — temas relacionados via Gemma 4 mas
    // entidades diferentes — não deve casar com threshold 0.6.
    const sim = subjectSimilarity(
      "Truque Google IA 3x mais rápido",
      "Multi-token prediction Gemma 4 paper",
    );
    assert.ok(sim < 0.6, `esperado < 0.6, got ${sim}`);
  });
});

describe("dedup Pass 1c — subject Jaccard vs past article titles (#897)", () => {
  it("remove artigo cujo título é traduzido/parafraseado de artigo de edição anterior", () => {
    // Past edition cobriu "GPT-5.5 Instant launch" (openai.com); current
    // edition tem "ChatGPT alucinações com GPT-5.5" do canaltech (mesma news,
    // ângulo paralelo). Jaccard sobre tokens normalizados deve >= 0.6.
    const pastArticleTitles = [
      "OpenAI lança GPT-5.5 Instant",
    ];
    const articles = [
      { url: "https://canaltech.com.br/openai-gpt-5-5-instant-anuncia", title: "OpenAI lança GPT-5.5 Instant para usuários" },
    ];
    const result = dedup(
      articles,
      new Set(), // pastUrls
      0.85,      // titleThreshold (intra)
      [],        // pastTitles (Pass 1b)
      0.70,
      pastArticleTitles, // Pass 1c
      0.6,
    );
    assert.equal(result.kept.length, 0);
    assert.ok(
      result.removed.some(r => r.dedup_note.includes("subject similar")),
      `esperado dedup_note com "subject similar", got: ${JSON.stringify(result.removed)}`,
    );
  });

  it("artigo com tema completamente diferente não é dedup'd", () => {
    const pastArticleTitles = ["OpenAI lança GPT-5.5 Instant"];
    const articles = [
      { url: "https://example.com/a", title: "Brasil aprova marco regulatório de IA" },
    ];
    const result = dedup(
      articles, new Set(), 0.85, [], 0.70, pastArticleTitles, 0.6,
    );
    assert.equal(result.kept.length, 1);
  });

  it("threshold conservador — nomes genéricos compartilhados não disparam dup", () => {
    // Issue calls out: títulos genéricos "Como X usa IA" não devem dar false
    // positive. Testa com tokens vazios após stopword removal.
    const pastArticleTitles = ["Como AWS usa IA pra otimizar custos"];
    const articles = [
      { url: "https://example.com/a", title: "Como Microsoft usa IA pra automação" },
    ];
    // Tokens overlap: "como", "usa" (ambos curtos/stopwords filtrados)
    // Resto: "aws"/"otimizar"/"custos" vs "microsoft"/"automacao" — sem overlap
    // jaccard ~ 0 (apenas "ia" se passar pelo filtro >= 3 chars)
    const result = dedup(
      articles, new Set(), 0.85, [], 0.70, pastArticleTitles, 0.6,
    );
    assert.equal(result.kept.length, 1, "genérico não deve disparar dup");
  });

  it("sem pastArticleTitles (default []) não toca em afterPass1b output", () => {
    const articles = [
      { url: "https://a.com/1", title: "Algum título" },
    ];
    const result = dedup(articles, new Set(), 0.85);
    assert.equal(result.kept.length, 1);
  });

  it("título sem tokens significativos (todos curtos) não dispara dup", () => {
    // "a b c d" tokens todos descartados (< 3 chars) → set vazio → no dup
    const pastArticleTitles = ["x y z"];
    const articles = [{ url: "https://a.com/1", title: "a b c d" }];
    const result = dedup(articles, new Set(), 0.85, [], 0.70, pastArticleTitles, 0.6);
    assert.equal(result.kept.length, 1);
  });

  it("artigo sem título passa direto pelo Pass 1c", () => {
    const pastArticleTitles = ["OpenAI lança GPT-5.5 Instant"];
    const articles = [{ url: "https://a.com/1" }];
    const result = dedup(articles, new Set(), 0.85, [], 0.70, pastArticleTitles, 0.6);
    assert.equal(result.kept.length, 1);
  });
});

describe("extractPastEditionArticleTitles (#897)", () => {
  function withTempEditions(populate: (dir: string) => void): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-dedup-897-"));
    populate(dir);
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("lê títulos de _internal/01-approved.json (highlights + runners_up + buckets)", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      const ed = join(d, "260505");
      mkdirSync(join(ed, "_internal"), { recursive: true });
      writeFileSync(
        join(ed, "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [{ article: { title: "Destaque 1: GPT-5.5" } }],
          runners_up: [{ article: { title: "Runner-up: Gemma 4" } }],
          noticias: [{ title: "Noticia X" }],
        }),
      );
    });
    try {
      const titles = extractPastEditionArticleTitles(dir, 3);
      assert.ok(titles.includes("Destaque 1: GPT-5.5"));
      assert.ok(titles.includes("Runner-up: Gemma 4"));
      assert.ok(titles.includes("Noticia X"));
    } finally {
      cleanup();
    }
  });

  it("lê títulos de root/01-approved.json (formato pré-#574)", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      const ed = join(d, "260427");
      mkdirSync(ed, { recursive: true });
      writeFileSync(
        join(ed, "01-approved.json"),
        JSON.stringify({
          highlights: [{ article: { title: "Old format edition title" } }],
        }),
      );
    });
    try {
      const titles = extractPastEditionArticleTitles(dir, 3);
      assert.ok(titles.includes("Old format edition title"));
    } finally {
      cleanup();
    }
  });

  it("exclui edição corrente quando currentAammdd fornecido", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      for (const aammdd of ["260505", "260506"]) {
        const ed = join(d, aammdd);
        mkdirSync(join(ed, "_internal"), { recursive: true });
        writeFileSync(
          join(ed, "_internal", "01-approved.json"),
          JSON.stringify({ highlights: [{ article: { title: `Title for ${aammdd}` } }] }),
        );
      }
    });
    try {
      const titles = extractPastEditionArticleTitles(dir, 3, "260506");
      assert.ok(titles.includes("Title for 260505"));
      assert.equal(titles.includes("Title for 260506"), false);
    } finally {
      cleanup();
    }
  });

  it("respeita window — pega apenas N edições mais recentes", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      for (const aammdd of ["260501", "260502", "260503"]) {
        const ed = join(d, aammdd);
        mkdirSync(join(ed, "_internal"), { recursive: true });
        writeFileSync(
          join(ed, "_internal", "01-approved.json"),
          JSON.stringify({ highlights: [{ article: { title: `Title-${aammdd}` } }] }),
        );
      }
    });
    try {
      const titles = extractPastEditionArticleTitles(dir, 1);
      assert.ok(titles.includes("Title-260503"));
      assert.equal(titles.includes("Title-260502"), false);
    } finally {
      cleanup();
    }
  });

  it("dir inexistente retorna array vazio (sem crash)", () => {
    const titles = extractPastEditionArticleTitles("/tmp/does-not-exist-xyz-897", 3);
    assert.deepEqual(titles, []);
  });

  it("JSON corrompido em uma edição não impede leitura das outras", () => {
    const { dir, cleanup } = withTempEditions((d) => {
      for (const aammdd of ["260501", "260502"]) {
        const ed = join(d, aammdd);
        mkdirSync(join(ed, "_internal"), { recursive: true });
      }
      // 260501 corrompido
      writeFileSync(join(d, "260501", "_internal", "01-approved.json"), "{ broken");
      // 260502 OK
      writeFileSync(
        join(d, "260502", "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ article: { title: "Survivor" } }] }),
      );
    });
    try {
      const titles = extractPastEditionArticleTitles(dir, 3);
      assert.ok(titles.includes("Survivor"));
    } finally {
      cleanup();
    }
  });
});

describe("extractPastDestaqueUrls (#1068)", () => {
  function setupDir() {
    const dir = mkdtempSync(join(tmpdir(), "dedup-destaque-"));
    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("retorna Set vazio quando editionsDir não existe", () => {
    const r = extractPastDestaqueUrls("/path/que/nao/existe", 3);
    assert.equal(r.size, 0);
  });

  it("extrai URLs do highlights[] de _internal/01-approved.json", () => {
    const { dir, cleanup } = setupDir();
    mkdirSync(join(dir, "260510", "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "260510", "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { rank: 1, url: "https://example.com/d1", article: { title: "D1" } },
          { rank: 2, article: { url: "https://example.com/d2", title: "D2" } },
        ],
        noticias: [
          { url: "https://other.com/secondary", title: "Secondary" },
        ],
      }),
      "utf8",
    );
    try {
      const r = extractPastDestaqueUrls(dir, 3);
      assert.equal(r.size, 2);
      assert.ok(r.has("https://example.com/d1"));
      assert.ok(r.has("https://example.com/d2"));
      // Secondary NÃO entra
      assert.ok(!r.has("https://other.com/secondary"));
    } finally {
      cleanup();
    }
  });

  it("aceita formato root (sem _internal/, fallback)", () => {
    const { dir, cleanup } = setupDir();
    mkdirSync(join(dir, "260510"), { recursive: true });
    writeFileSync(
      join(dir, "260510", "01-approved.json"),
      JSON.stringify({
        highlights: [{ url: "https://example.com/legacy-format" }],
      }),
      "utf8",
    );
    try {
      const r = extractPastDestaqueUrls(dir, 3);
      assert.ok(r.has("https://example.com/legacy-format"));
    } finally {
      cleanup();
    }
  });

  it("respeita window — só inclui últimas N edições", () => {
    const { dir, cleanup } = setupDir();
    for (const aammdd of ["260501", "260502", "260503", "260510"]) {
      mkdirSync(join(dir, aammdd, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, aammdd, "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [{ url: `https://example.com/${aammdd}` }],
        }),
        "utf8",
      );
    }
    try {
      const r = extractPastDestaqueUrls(dir, 2); // window=2 → 2 mais recentes
      assert.equal(r.size, 2);
      assert.ok(r.has("https://example.com/260510"));
      assert.ok(r.has("https://example.com/260503"));
      assert.ok(!r.has("https://example.com/260502"));
    } finally {
      cleanup();
    }
  });

  it("exclui currentAammdd (self-match)", () => {
    const { dir, cleanup } = setupDir();
    mkdirSync(join(dir, "260510", "_internal"), { recursive: true });
    mkdirSync(join(dir, "260511", "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "260510", "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{ url: "https://example.com/d10" }] }),
      "utf8",
    );
    writeFileSync(
      join(dir, "260511", "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{ url: "https://example.com/d11" }] }),
      "utf8",
    );
    try {
      const r = extractPastDestaqueUrls(dir, 3, "260511");
      assert.ok(r.has("https://example.com/d10"));
      assert.ok(!r.has("https://example.com/d11"));
    } finally {
      cleanup();
    }
  });

  it("canonicaliza URLs (remove utm tracking params)", () => {
    const { dir, cleanup } = setupDir();
    mkdirSync(join(dir, "260510", "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "260510", "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [{ url: "https://example.com/d1?utm_source=newsletter" }],
      }),
      "utf8",
    );
    try {
      const r = extractPastDestaqueUrls(dir, 3);
      // utm_* stripped por canonicalize()
      assert.ok(r.has("https://example.com/d1"));
    } finally {
      cleanup();
    }
  });
});

describe("dedup com pastDestaqueUrlsSet (#1068)", () => {
  const mkArt = (url: string, title = `Title for ${url}`) => ({
    url,
    title,
    published_at: "2026-05-11T00:00:00Z",
  });

  it("URL em past destaques é bloqueada mesmo se candidata atual", () => {
    const pastUrls = new Set(["https://example.com/x"]);
    const pastDestaques = new Set(["https://example.com/x"]);
    const r = dedup(
      [mkArt("https://example.com/x")],
      pastUrls,
      0.85,
      [],
      0.7,
      [],
      0.6,
      pastDestaques,
    );
    assert.equal(r.kept.length, 0);
    assert.equal(r.removed.length, 1);
  });

  it("URL em past só como secondary é LIBERADA (promoção permitida)", () => {
    const pastUrls = new Set(["https://example.com/promoted"]);
    const pastDestaques = new Set<string>(); // não foi destaque
    const r = dedup(
      [mkArt("https://example.com/promoted")],
      pastUrls,
      0.85,
      [],
      0.7,
      [],
      0.6,
      pastDestaques,
    );
    assert.equal(r.kept.length, 1);
    assert.equal(r.removed.length, 0);
  });

  it("sem pastDestaqueUrlsSet (legacy callers): bloqueia tudo de pastUrls", () => {
    const pastUrls = new Set(["https://example.com/y"]);
    const r = dedup(
      [mkArt("https://example.com/y")],
      pastUrls,
      0.85,
    );
    assert.equal(r.kept.length, 0);
    assert.equal(r.removed[0].dedup_note, "url-match com edição anterior");
  });

  it("URL nova (não em past) passa independente do set", () => {
    const pastUrls = new Set(["https://example.com/x"]);
    const pastDestaques = new Set(["https://example.com/x"]);
    const r = dedup(
      [mkArt("https://example.com/NEW")],
      pastUrls,
      0.85,
      [],
      0.7,
      [],
      0.6,
      pastDestaques,
    );
    assert.equal(r.kept.length, 1);
  });
});
