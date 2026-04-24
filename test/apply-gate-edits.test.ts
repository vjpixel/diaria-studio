import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSections } from "../scripts/apply-gate-edits.ts";

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
});
