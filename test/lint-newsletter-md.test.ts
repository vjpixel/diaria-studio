import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractUrlsBySection,
  buildUrlBucketMap,
  lintNewsletter,
  countTitlesPerHighlight,
} from "../scripts/lint-newsletter-md.ts";

describe("extractUrlsBySection", () => {
  it("extrai URLs por seção LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://destaque-fora.com",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item",
      "https://openai.com/x",
      "",
      "---",
      "",
      "PESQUISAS",
      "Paper",
      "https://arxiv.org/y",
      "",
      "---",
      "",
      "OUTRAS NOTÍCIAS",
      "Notícia",
      "https://techcrunch.com/z",
    ].join("\n");

    const r = extractUrlsBySection(md);
    assert.equal(r["LANÇAMENTOS"]?.length, 1);
    assert.equal(r["LANÇAMENTOS"][0].url, "https://openai.com/x");
    assert.equal(r["PESQUISAS"]?.length, 1);
    assert.equal(r["OUTRAS NOTÍCIAS"]?.length, 1);
  });

  it("ignora URLs em destaques (fora das seções secundárias)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "https://destaque.com",
      "Texto.",
    ].join("\n");
    const r = extractUrlsBySection(md);
    assert.equal(Object.keys(r).length, 0);
  });
});

describe("buildUrlBucketMap", () => {
  it("highlights têm prioridade sobre buckets", () => {
    const approved = {
      highlights: [{ url: "https://x/destaque", title: "D1" }],
      lancamento: [{ url: "https://x/destaque", title: "D1" }],
      pesquisa: [],
      noticias: [],
    };
    const { byUrl } = buildUrlBucketMap(approved);
    assert.equal(byUrl.get("https://x/destaque")?.bucket, "highlights");
  });

  it("buckets mapeados corretamente", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://l/x" }],
      pesquisa: [{ url: "https://p/x" }],
      noticias: [{ url: "https://n/x" }],
    };
    const { byUrl } = buildUrlBucketMap(approved);
    assert.equal(byUrl.get("https://l/x")?.bucket, "lancamento");
    assert.equal(byUrl.get("https://p/x")?.bucket, "pesquisa");
    assert.equal(byUrl.get("https://n/x")?.bucket, "noticias");
  });
});

describe("lintNewsletter", () => {
  it("ok quando todas URLs batem com bucket esperado", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://openai.com/x" }],
      pesquisa: [{ url: "https://arxiv.org/y" }],
      noticias: [{ url: "https://techcrunch.com/z" }],
    };
    const md = [
      "LANÇAMENTOS",
      "Item",
      "https://openai.com/x",
      "",
      "---",
      "PESQUISAS",
      "https://arxiv.org/y",
      "",
      "---",
      "OUTRAS NOTÍCIAS",
      "https://techcrunch.com/z",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("erro quando URL com bucket noticias está em LANÇAMENTOS (caso ComfyUI 260426)", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      pesquisa: [],
      noticias: [
        { url: "https://techcrunch.com/comfyui-500m", title: "ComfyUI hits $500M valuation" },
      ],
    };
    const md = [
      "LANÇAMENTOS",
      "ComfyUI atinge $500M",
      "https://techcrunch.com/comfyui-500m",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].expected_bucket, "lancamento");
    assert.equal(r.errors[0].found_in_bucket, "noticias");
    assert.ok(r.errors[0].title?.includes("ComfyUI"));
  });

  it("erro quando URL não existe no approved", () => {
    const approved = { highlights: [], lancamento: [], pesquisa: [], noticias: [] };
    const md = [
      "LANÇAMENTOS",
      "Artigo fantasma",
      "https://ghost.com/x",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].found_in_bucket, "missing");
  });

  it("destaque que aparece em seção secundária vira warning, não error", () => {
    const approved = {
      highlights: [{ url: "https://x/destaque", title: "Destaque" }],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    };
    const md = [
      "LANÇAMENTOS",
      "Item",
      "https://x/destaque",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 1);
  });

  it("dedup markdown link [url](url)", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://openai.com/x" }],
      pesquisa: [],
      noticias: [],
    };
    const md = [
      "LANÇAMENTOS",
      "Item",
      "[https://openai.com/x](https://openai.com/x)",
    ].join("\n");
    const r = lintNewsletter(md, approved);
    assert.equal(r.ok, true);
  });
});

describe("countTitlesPerHighlight (#178)", () => {
  it("ok quando todos 3 destaques têm exatamente 1 título", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título único do destaque 1",
      "",
      "Corpo do destaque.",
      "",
      "https://example.com/1",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título único do destaque 2",
      "",
      "Corpo.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título único do destaque 3",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, true);
    assert.equal(r.destaques.length, 3);
    for (const d of r.destaques) {
      assert.equal(d.title_count, 1);
      assert.equal(d.status, "ok");
    }
  });

  it("erro quando destaque tem 3 títulos (editor não podou)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Opção 1 de título",
      "Opção 2 de título",
      "Opção 3 de título",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título único",
      "",
      "Corpo.",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título único",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.destaques[0].title_count, 3);
    assert.equal(r.destaques[0].status, "needs_pruning");
    assert.equal(r.destaques[1].status, "ok");
    assert.equal(r.destaques[2].status, "ok");
  });

  it("erro quando há menos de 3 destaques", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "",
      "Corpo.",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("Esperado 3 destaques")));
  });

  it("URL na linha logo abaixo do header é ignorada (não conta como título)", () => {
    // #172 mudou layout pra URL imediatamente abaixo do título — esse check
    // tolera ambas as ordens
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título único",
      "https://example.com/1",
      "",
      "Corpo.",
      "",
      "DESTAQUE 2 | PESQUISA",
      "Título único",
      "",
      "DESTAQUE 3 | MERCADO",
      "Título único",
    ].join("\n");
    const r = countTitlesPerHighlight(md);
    assert.equal(r.destaques[0].title_count, 1);
    assert.equal(r.destaques[0].titles[0], "Título único");
  });
});
