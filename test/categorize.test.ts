import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { categorize, type Article } from "../scripts/categorize.ts";

describe("categorize() — regras de domínio", () => {
  it("classifica anúncio oficial da OpenAI como lancamento", () => {
    const art: Article = { url: "https://openai.com/index/introducing-gpt-5/" };
    assert.equal(categorize(art), "lancamento");
  });

  it("classifica news da Anthropic como lancamento (via pattern)", () => {
    const art: Article = { url: "https://anthropic.com/news/claude-4-5-sonnet" };
    assert.equal(categorize(art), "lancamento");
  });

  it("classifica blog da Hugging Face como lancamento", () => {
    const art: Article = { url: "https://huggingface.co/blog/cool-model" };
    assert.equal(categorize(art), "lancamento");
  });

  it("classifica paper arxiv como pesquisa", () => {
    const art: Article = { url: "https://arxiv.org/abs/2501.12345" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("classifica huggingface.co/papers como pesquisa (mesmo domínio do blog)", () => {
    const art: Article = { url: "https://huggingface.co/papers/2501.12345" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("classifica anthropic.com/research como pesquisa (prioridade sobre lancamento)", () => {
    const art: Article = { url: "https://anthropic.com/research/some-paper" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("classifica openai.com/research como pesquisa (prioridade sobre lancamento)", () => {
    const art: Article = { url: "https://openai.com/research/some-paper" };
    assert.equal(categorize(art), "pesquisa");
  });

  it("usa type_hint='pesquisa' quando domínio não é reconhecido", () => {
    const art: Article = {
      url: "https://some-unknown-lab.example/paper",
      type_hint: "pesquisa",
    };
    assert.equal(categorize(art), "pesquisa");
  });

  it("cai em noticias por default (cobertura jornalística)", () => {
    const art: Article = { url: "https://techcrunch.com/2026/04/some-story" };
    assert.equal(categorize(art), "noticias");
  });

  it("cai em noticias quando URL é cobertura secundária (não domínio oficial)", () => {
    const art: Article = {
      url: "https://theverge.com/openai-announces-gpt5",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "noticias");
  });

  it("lida com www. no hostname", () => {
    const art: Article = { url: "https://www.openai.com/blog/something" };
    assert.equal(categorize(art), "lancamento");
  });

  it("URL inválida cai em noticias sem crashar", () => {
    const art: Article = { url: "not-a-url" };
    assert.equal(categorize(art), "noticias");
  });
});
