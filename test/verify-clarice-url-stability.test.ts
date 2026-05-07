import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractUrlsBySection,
  compareUrls,
  verifyStability,
} from "../scripts/verify-clarice-url-stability.ts";

const SAMPLE_MD = `# Newsletter

Intro aqui.

DESTAQUE 1

Algum texto.

LANÇAMENTOS

- Item A — https://anthropic.com/news/claude-4-7?utm_source=foo
- Item B — https://openai.com/index/gpt-5

PESQUISAS

- Paper X — https://arxiv.org/abs/2501.12345

NOTÍCIAS

- News Y — https://techcrunch.com/2026/05/06/example
`;

describe("extractUrlsBySection", () => {
  it("agrupa URLs pela seção correta", () => {
    const urls = extractUrlsBySection(SAMPLE_MD);
    assert.deepEqual(urls.LANCAMENTOS, [
      "https://anthropic.com/news/claude-4-7?utm_source=foo",
      "https://openai.com/index/gpt-5",
    ]);
    assert.deepEqual(urls.PESQUISAS, ["https://arxiv.org/abs/2501.12345"]);
    assert.deepEqual(urls.NOTICIAS, ["https://techcrunch.com/2026/05/06/example"]);
  });

  it("aceita ## Header (Stage 1) e plain caps (Stage 2)", () => {
    const stage1 = `## Lançamentos

- https://anthropic.com/news/x

## Pesquisas

- https://arxiv.org/abs/1
`;
    const urls = extractUrlsBySection(stage1);
    assert.deepEqual(urls.LANCAMENTOS, ["https://anthropic.com/news/x"]);
    assert.deepEqual(urls.PESQUISAS, ["https://arxiv.org/abs/1"]);
  });

  it("dedup URLs duplicadas dentro da mesma seção", () => {
    const md = `LANÇAMENTOS

- [link](https://anthropic.com/news/x) https://anthropic.com/news/x
`;
    const urls = extractUrlsBySection(md);
    assert.deepEqual(urls.LANCAMENTOS, ["https://anthropic.com/news/x"]);
  });

  it("trim de pontuação trailing após URL", () => {
    const md = `LANÇAMENTOS

- Veja https://anthropic.com/news/x.
`;
    const urls = extractUrlsBySection(md);
    assert.deepEqual(urls.LANCAMENTOS, ["https://anthropic.com/news/x"]);
  });

  it("URL em parágrafo narrativo é ignorada (P2 #889)", () => {
    const md = `LANÇAMENTOS

A nova versão foi anunciada em https://anthropic.com/news/x e gerou debate.

- Item de verdade — https://anthropic.com/news/y
`;
    const urls = extractUrlsBySection(md);
    // URL em parágrafo narrativo é ignorada; só a do list item conta.
    assert.deepEqual(urls.LANCAMENTOS, ["https://anthropic.com/news/y"]);
  });

  it("URL em item numerado (1.) é capturada", () => {
    const md = `LANÇAMENTOS

1. Primeiro item — https://anthropic.com/news/x
2. Segundo item — https://openai.com/index/y
`;
    const urls = extractUrlsBySection(md);
    assert.deepEqual(urls.LANCAMENTOS, [
      "https://anthropic.com/news/x",
      "https://openai.com/index/y",
    ]);
  });

  it("URL em item com asterisco (*) é capturada", () => {
    const md = `LANÇAMENTOS

* Item — https://anthropic.com/news/x
`;
    const urls = extractUrlsBySection(md);
    assert.deepEqual(urls.LANCAMENTOS, ["https://anthropic.com/news/x"]);
  });

  it("humanizer move URL de parágrafo narrativo entre seções não vira falso positivo", () => {
    // Pre: URL na intro narrativa + URL em LANÇAMENTOS (list item).
    const pre = `Intro: a Anthropic anunciou em https://anthropic.com/news/foo um novo modelo.

LANÇAMENTOS

- Item — https://anthropic.com/news/bar
`;
    // Post: humanizer reescreveu a intro e moveu a URL pro fim do parágrafo
    // (mas é o mesmo conteúdo narrativo). LANÇAMENTOS intacto.
    const post = `Intro reescrita pelo humanizer. A Anthropic divulgou novo modelo: https://anthropic.com/news/foo.

LANÇAMENTOS

- Item — https://anthropic.com/news/bar
`;
    const result = verifyStability(pre, post);
    assert.equal(result.status, "ok");
    assert.equal(result.lancamento_changes.length, 0);
    // URLs em narrativa não contam como other_changes — são ignoradas.
    assert.equal(result.other_changes.length, 0);
  });

  it("seção '---' encerra a seção atual", () => {
    const md = `LANÇAMENTOS

- https://anthropic.com/news/x

---

- Item solto: https://example.com
`;
    const urls = extractUrlsBySection(md);
    assert.deepEqual(urls.LANCAMENTOS, ["https://anthropic.com/news/x"]);
    assert.deepEqual(urls.OUTRAS, ["https://example.com"]);
  });
});

describe("compareUrls", () => {
  it("happy path — todas URLs iguais retorna ok", () => {
    const result = verifyStability(SAMPLE_MD, SAMPLE_MD);
    assert.equal(result.status, "ok");
    assert.equal(result.lancamento_changes.length, 0);
    assert.equal(result.other_changes.length, 0);
  });

  it("URL em LANÇAMENTOS modificada (utm strippado) → erro com diff before/after", () => {
    const post = SAMPLE_MD.replace(
      "https://anthropic.com/news/claude-4-7?utm_source=foo",
      "https://anthropic.com/news/claude-4-7",
    );
    const result = verifyStability(SAMPLE_MD, post);
    assert.equal(result.status, "error");
    assert.equal(result.lancamento_changes.length, 1);
    assert.equal(
      result.lancamento_changes[0].before,
      "https://anthropic.com/news/claude-4-7?utm_source=foo",
    );
    assert.equal(
      result.lancamento_changes[0].after,
      "https://anthropic.com/news/claude-4-7",
    );
  });

  it("URL adicionada em LANÇAMENTOS → fatal", () => {
    const post = SAMPLE_MD.replace(
      "- Item B — https://openai.com/index/gpt-5",
      "- Item B — https://openai.com/index/gpt-5\n- Item C — https://google.com/blog/x",
    );
    const result = verifyStability(SAMPLE_MD, post);
    assert.equal(result.status, "error");
    assert.equal(result.lancamento_changes.length, 1);
    assert.equal(result.lancamento_changes[0].before, "");
    assert.equal(result.lancamento_changes[0].after, "https://google.com/blog/x");
  });

  it("URL removida de LANÇAMENTOS → fatal", () => {
    const post = SAMPLE_MD.replace(
      "- Item B — https://openai.com/index/gpt-5\n",
      "",
    );
    const result = verifyStability(SAMPLE_MD, post);
    assert.equal(result.status, "error");
    assert.equal(result.lancamento_changes.length, 1);
    assert.equal(result.lancamento_changes[0].before, "https://openai.com/index/gpt-5");
    assert.equal(result.lancamento_changes[0].after, "");
  });

  it("URL adicionada em PESQUISAS → warn (status ok, other_changes preenchido)", () => {
    const post = SAMPLE_MD.replace(
      "- Paper X — https://arxiv.org/abs/2501.12345",
      "- Paper X — https://arxiv.org/abs/2501.12345\n- Paper Y — https://arxiv.org/abs/2501.99999",
    );
    const result = verifyStability(SAMPLE_MD, post);
    assert.equal(result.status, "ok");
    assert.equal(result.lancamento_changes.length, 0);
    const added = result.other_changes.filter((c) => c.kind === "added");
    assert.equal(added.length, 1);
    assert.equal(added[0].section, "PESQUISAS");
    assert.equal(added[0].url, "https://arxiv.org/abs/2501.99999");
  });

  it("URL removida de NOTÍCIAS → warn (status ok)", () => {
    const post = SAMPLE_MD.replace(
      "- News Y — https://techcrunch.com/2026/05/06/example\n",
      "",
    );
    const result = verifyStability(SAMPLE_MD, post);
    assert.equal(result.status, "ok");
    const removed = result.other_changes.filter((c) => c.kind === "removed");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].section, "NOTICIAS");
  });

  it("reordenamento de URLs dentro de LANÇAMENTOS é OK (mesmo set)", () => {
    const post = SAMPLE_MD.replace(
      "- Item A — https://anthropic.com/news/claude-4-7?utm_source=foo\n- Item B — https://openai.com/index/gpt-5",
      "- Item B — https://openai.com/index/gpt-5\n- Item A — https://anthropic.com/news/claude-4-7?utm_source=foo",
    );
    const result = verifyStability(SAMPLE_MD, post);
    assert.equal(result.status, "ok");
    assert.equal(result.lancamento_changes.length, 0);
  });

  it("Clarice adiciona trailing slash em URL oficial → fatal", () => {
    const pre = `LANÇAMENTOS

- https://anthropic.com/news/x
`;
    const post = `LANÇAMENTOS

- https://anthropic.com/news/x/
`;
    const result = verifyStability(pre, post);
    assert.equal(result.status, "error");
    assert.equal(result.lancamento_changes.length, 1);
    assert.equal(result.lancamento_changes[0].before, "https://anthropic.com/news/x");
    assert.equal(result.lancamento_changes[0].after, "https://anthropic.com/news/x/");
  });
});

describe("compareUrls — programmatic API", () => {
  it("compareUrls aceita maps já extraídos", () => {
    const pre = {
      LANCAMENTOS: ["https://anthropic.com/news/x"],
      PESQUISAS: [],
      NOTICIAS: [],
      OUTRAS: [],
    } as const;
    const post = {
      LANCAMENTOS: ["https://anthropic.com/news/x/"],
      PESQUISAS: [],
      NOTICIAS: [],
      OUTRAS: [],
    } as const;
    const result = compareUrls(pre, post);
    assert.equal(result.status, "error");
  });
});
