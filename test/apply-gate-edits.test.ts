import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSections, mergeWithNewJson, canonicalizeUrl, resolveDestaques } from "../scripts/apply-gate-edits.ts";

describe("parseSections", () => {
  it("extrai URLs de todas as 4 seções", () => {
    const md = `# Header

## Destaques

- [90] Título A — https://a.com/1 — 2026-04-24
- [85] Título B — https://b.com/2 — 2026-04-24

## Lançamentos

- [70] Lan 1 — https://c.com/3 — 2026-04-24

## Pesquisas

- [75] Pes 1 — https://d.com/4 — 2026-04-24

## Notícias

- [65] Not 1 — https://e.com/5 — 2026-04-24
- [60] Not 2 — https://f.com/6 — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.destaques, ["https://a.com/1", "https://b.com/2"]);
    assert.deepEqual(result.lancamento, ["https://c.com/3"]);
    assert.deepEqual(result.pesquisa, ["https://d.com/4"]);
    assert.deepEqual(result.noticias, ["https://e.com/5", "https://f.com/6"]);
  });

  it("preserva ordem física das URLs (não ordena por score)", () => {
    const md = `## Destaques

- [50] C — https://c.com/3 — 2026-04-24
- [90] A — https://a.com/1 — 2026-04-24
- [70] B — https://b.com/2 — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.destaques, [
      "https://c.com/3",
      "https://a.com/1",
      "https://b.com/2",
    ]);
  });

  it("deduplica dentro do mesmo bucket mantendo primeira ocorrência", () => {
    const md = `## Lançamentos

- [70] A — https://a.com/1 — 2026-04-24
- [70] A de novo — https://a.com/1 — 2026-04-24
- [65] B — https://b.com/2 — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.lancamento, ["https://a.com/1", "https://b.com/2"]);
  });

  it("ignora seções desconhecidas", () => {
    const md = `## Destaques

- [90] A — https://a.com/1 — 2026-04-24

## Rascunhos

- [50] R — https://r.com/x — 2026-04-24

## Notícias

- [65] N — https://n.com/1 — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.destaques, ["https://a.com/1"]);
    assert.deepEqual(result.noticias, ["https://n.com/1"]);
    // Rascunhos não é uma seção válida — ignorado
  });

  it("separador --- aborta bucket atual (antes de Saúde das fontes)", () => {
    const md = `## Notícias

- [65] N — https://n.com/1 — 2026-04-24

---

## Saúde das fontes

Tudo certo.

- não-url: https://fake.com/no — isso é ruído
`;
    const result = parseSections(md);
    assert.deepEqual(result.noticias, ["https://n.com/1"]);
  });

  it("aceita linhas sem data trailing", () => {
    const md = `## Lançamentos

- [70] A — https://a.com/1
`;
    const result = parseSections(md);
    assert.deepEqual(result.lancamento, ["https://a.com/1"]);
  });

  it("retorna seções vazias quando MD não tem nada", () => {
    const result = parseSections("# Empty\n\nNothing here.");
    assert.deepEqual(result, {
      destaques: [],
      lancamento: [],
      pesquisa: [],
      noticias: [],
      tutorial: [],
      video: [],
    });
  });

  it("parseia seção 'Aprenda hoje' (#59 tutorial)", () => {
    const md = `## Aprenda hoje

- [70] Tutorial de RAG — https://simonwillison.net/rag — 2026-04-24

## Notícias

- [60] Notícia — https://a.com/x — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.tutorial, ["https://simonwillison.net/rag"]);
    assert.deepEqual(result.noticias, ["https://a.com/x"]);
  });

  it("ignora linhas que não começam com - (não são bullets)", () => {
    const md = `## Destaques

Texto qualquer com https://foo.com/x.
- [90] A — https://a.com/1 — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.destaques, ["https://a.com/1"]);
  });

  it("mesma URL em buckets diferentes mantém em ambos", () => {
    const md = `## Destaques

- [90] A — https://a.com/1 — 2026-04-24

## Lançamentos

- [90] A — https://a.com/1 — 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.destaques, ["https://a.com/1"]);
    assert.deepEqual(result.lancamento, ["https://a.com/1"]);
  });

  it("#661: aceita double-hyphen (--) como separador (Google Drive autocorrect)", () => {
    const md = `## Lançamentos

- [90] Título X -- https://x.com/1 -- 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.lancamento, ["https://x.com/1"]);
  });

  it("#661: aceita en-dash (–) como separador", () => {
    const md = `## Notícias

- [70] Título Y – https://y.com/2 – 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.noticias, ["https://y.com/2"]);
  });

  it("#661: mistura de em-dash e double-hyphen no mesmo arquivo", () => {
    const md = `## Destaques

- [90] A — https://a.com/1 — 2026-04-24
- [85] B -- https://b.com/2 -- 2026-04-24
`;
    const result = parseSections(md);
    assert.deepEqual(result.destaques, ["https://a.com/1", "https://b.com/2"]);
  });
});

// Helper para criar artigo de teste
function makeArticle(url: string, score = 50, extra: Record<string, unknown> = {}) {
  return { url, title: `Título de ${url}`, score, ...extra };
}

describe("mergeWithNewJson (#293)", () => {
  it("preserva artigos no bucket do editor e ordem do editor", () => {
    const existingMd = `## Destaques\n\n## Lançamentos\n\n- [80] L2 — https://lan2.com — 2026-04-01\n- [70] L1 — https://lan1.com — 2026-04-01\n\n## Pesquisas\n\n## Notícias\n\n`;
    const newJson = {
      highlights: [],
      runners_up: [],
      lancamento: [makeArticle("https://lan1.com", 70), makeArticle("https://lan2.com", 80)],
      pesquisa: [],
      noticias: [],
      tutorial: [],
    };
    const { merged, warnings } = mergeWithNewJson(existingMd, newJson);
    // Editor colocou lan2 antes de lan1 → preservar essa ordem
    assert.equal(merged.lancamento[0].url, "https://lan2.com");
    assert.equal(merged.lancamento[1].url, "https://lan1.com");
    assert.equal(warnings.length, 0);
  });

  it("artigos em Destaques do editor ficam no topo do bucket original", () => {
    const existingMd = `## Destaques\n\n- [90] Art — https://art.com — 2026-04-01\n\n## Notícias\n\n- [50] B — https://b.com — 2026-04-01\n\n## Lançamentos\n\n## Pesquisas\n\n`;
    const newJson = {
      highlights: [],
      runners_up: [],
      lancamento: [],
      pesquisa: [],
      noticias: [makeArticle("https://b.com", 50), makeArticle("https://art.com", 90)],
      tutorial: [],
    };
    const { merged } = mergeWithNewJson(existingMd, newJson);
    // art.com estava nos Destaques → deve ser o primeiro em noticias
    assert.equal(merged.noticias[0].url, "https://art.com");
  });

  it("artigo novo no JSON recebe new_in_pool=true", () => {
    const existingMd = `## Destaques\n\n## Lançamentos\n\n- [70] A — https://a.com — 2026-04-01\n\n## Pesquisas\n\n## Notícias\n\n`;
    const newJson = {
      highlights: [], runners_up: [],
      lancamento: [makeArticle("https://a.com", 70), makeArticle("https://new.com", 80)],
      pesquisa: [], noticias: [], tutorial: [],
    };
    const { merged, warnings } = mergeWithNewJson(existingMd, newJson);
    const newArticle = merged.lancamento.find((a) => a.url === "https://new.com");
    assert.ok(newArticle, "artigo novo deve estar no resultado");
    assert.equal((newArticle as Record<string, unknown>).new_in_pool, true);
    assert.equal(warnings.length, 0);
  });

  it("artigo removido do pool gera warning e é excluído", () => {
    const existingMd = `## Destaques\n\n## Notícias\n\n- [60] Old — https://old.com — 2026-04-01\n\n## Lançamentos\n\n## Pesquisas\n\n`;
    const newJson = {
      highlights: [], runners_up: [],
      lancamento: [], pesquisa: [],
      noticias: [makeArticle("https://novo.com", 70)],
      tutorial: [],
    };
    const { merged, warnings } = mergeWithNewJson(existingMd, newJson);
    assert.ok(warnings.some((w) => w.includes("https://old.com")));
    assert.ok(!merged.noticias.some((a) => a.url === "https://old.com"));
  });

  it("editor moveu artigo entre buckets — respeita bucket do editor", () => {
    const existingMd = `## Destaques\n\n## Lançamentos\n\n- [80] Art — https://art.com — 2026-04-01\n\n## Pesquisas\n\n## Notícias\n\n`;
    const newJson = {
      highlights: [], runners_up: [],
      lancamento: [],
      pesquisa: [makeArticle("https://art.com", 80)], // scorer coloca em pesquisa
      noticias: [], tutorial: [],
    };
    const { merged } = mergeWithNewJson(existingMd, newJson);
    // Editor moveu para lancamento — deve respeitar isso
    assert.equal(merged.lancamento.length, 1);
    assert.equal(merged.lancamento[0].url, "https://art.com");
    assert.equal(merged.pesquisa.length, 0);
  });
});

describe("canonicalizeUrl (#439)", () => {
  it("normaliza trailing slash", () => {
    // root slash preserved (url-utils: only removes trailing slash when pathname.length > 1)
    assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
    assert.equal(canonicalizeUrl("https://example.com/path/"), "https://example.com/path");
  });

  it("lowercase scheme e host", () => {
    assert.equal(canonicalizeUrl("HTTPS://Example.COM/path"), "https://example.com/path");
  });

  it("remove fragment", () => {
    assert.equal(canonicalizeUrl("https://example.com/page#section"), "https://example.com/page");
  });

  it("preserva query string", () => {
    assert.equal(canonicalizeUrl("https://example.com/search?q=ai"), "https://example.com/search?q=ai");
  });

  it("URL inválida retorna como está sem crash", () => {
    assert.equal(canonicalizeUrl("not-a-url"), "not-a-url");
  });

  it("URLs equivalentes canonicalizam para o mesmo valor", () => {
    const a = canonicalizeUrl("https://openai.com/blog/gpt-5/");
    const b = canonicalizeUrl("https://openai.com/blog/gpt-5");
    assert.equal(a, b);
  });
});

describe("parseSections — strip pontuação trailing na URL (#443)", () => {
  it("remove ponto final da URL", () => {
    const md = `## Destaques\n\n1. [85] Título — https://example.com/article. — 2026-05-01\n\n## Lançamentos\n\n## Pesquisas\n\n## Notícias\n`;
    const result = parseSections(md);
    assert.ok(result.destaques.includes("https://example.com/article"));
    assert.ok(!result.destaques.some((u) => u.endsWith(".")));
  });

  it("remove vírgula trailing da URL", () => {
    const md = `## Destaques\n\n1. [80] Título — https://example.com/article, — 2026-05-01\n\n## Lançamentos\n\n## Pesquisas\n\n## Notícias\n`;
    const result = parseSections(md);
    assert.ok(result.destaques.includes("https://example.com/article"));
  });

  it("URL sem pontuação trailing preservada intacta", () => {
    const md = `## Destaques\n\n1. [90] Título — https://example.com/article — 2026-05-01\n\n## Lançamentos\n\n## Pesquisas\n\n## Notícias\n`;
    const result = parseSections(md);
    assert.ok(result.destaques.includes("https://example.com/article"));
  });
});

describe("resolveDestaques (#663) — fallback respeita intenção do editor", () => {
  const highlights = [
    { rank: 1, url: "https://a.com/1" },
    { rank: 2, url: "https://b.com/2" },
    { rank: 3, url: "https://c.com/3" },
  ];

  const makeSection = (destaques: string[], noticias: string[]) => ({
    destaques,
    lancamento: [],
    pesquisa: [],
    noticias,
    tutorial: [],
    video: [],
  });

  it("editor selecionou 3 destaques → usa exatamente os 3 do editor", () => {
    const s = makeSection(
      ["https://a.com/1", "https://b.com/2", "https://c.com/3"],
      ["https://a.com/1", "https://b.com/2", "https://c.com/3"],
    );
    const result = resolveDestaques(s, highlights);
    assert.deepEqual(result, ["https://a.com/1", "https://b.com/2", "https://c.com/3"]);
  });

  it("editor selecionou 0 destaques + scorer rank 1 está nos buckets → completa com rank 1", () => {
    const s = makeSection([], ["https://a.com/1", "https://b.com/2"]);
    const result = resolveDestaques(s, highlights);
    assert.ok(result.includes("https://a.com/1"), "rank 1 deve estar nos destaques");
  });

  it("#663: editor removeu artigo X dos buckets → X NÃO volta como fallback", () => {
    // a.com/1 é rank 1 do scorer, mas editor o removeu dos buckets
    const s = makeSection([], ["https://b.com/2", "https://c.com/3"]); // sem a.com/1
    const result = resolveDestaques(s, highlights);
    assert.ok(!result.includes("https://a.com/1"), "artigo removido não deve voltar como fallback");
    assert.ok(result.includes("https://b.com/2"), "rank 2 (ainda no bucket) deve ser usado");
  });

  it("#663: editor removeu TODOS os candidatos do scorer → retorna 0 destaques", () => {
    // Editor limpou todos os buckets
    const s = makeSection([], []); // buckets vazios
    const result = resolveDestaques(s, highlights);
    assert.equal(result.length, 0, "0 destaques quando editor removeu tudo");
  });

  it("editor colocou 1 destaque manualmente + scorer completa com buckets", () => {
    const s = makeSection(
      ["https://d.com/custom"], // escolha manual não está nos highlights do scorer
      ["https://a.com/1", "https://b.com/2", "https://d.com/custom"],
    );
    const result = resolveDestaques(s, highlights);
    assert.equal(result[0], "https://d.com/custom", "escolha manual do editor é D1");
    assert.equal(result.length, 3, "completado para 3");
    assert.ok(result.includes("https://a.com/1"));
    assert.ok(result.includes("https://b.com/2"));
  });

  it("mais de 3 destaques → mantém só os 3 primeiros", () => {
    const s = makeSection(
      ["https://a.com/1", "https://b.com/2", "https://c.com/3", "https://d.com/4"],
      [],
    );
    const result = resolveDestaques(s, highlights);
    assert.equal(result.length, 3);
    assert.equal(result[0], "https://a.com/1");
  });
});
