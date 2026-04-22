import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractUrls, URL_REGEX } from "../scripts/inbox-drain.ts";

describe("extractUrls() — extração via URL_REGEX + strip de pontuação", () => {
  it("extrai URL limpa de texto corrido", () => {
    const body = "Olha essa matéria: https://openai.com/blog/gpt-5 muito boa.";
    assert.deepEqual(extractUrls(body), ["https://openai.com/blog/gpt-5"]);
  });

  it("remove ponto final agarrado na URL", () => {
    const body = "Link: https://anthropic.com/news/claude.";
    assert.deepEqual(extractUrls(body), ["https://anthropic.com/news/claude"]);
  });

  it("remove parêntese de fechamento agarrado", () => {
    const body = "Ver (https://arxiv.org/abs/2501.12345) no arxiv";
    assert.deepEqual(extractUrls(body), ["https://arxiv.org/abs/2501.12345"]);
  });

  it("remove vírgula de fechamento", () => {
    const body = "Leia https://example.com/artigo, muito interessante";
    assert.deepEqual(extractUrls(body), ["https://example.com/artigo"]);
  });

  it("para antes de > em URL dentro de <https://...>", () => {
    const body = "Linkaram <https://openai.com/index/chatgpt> aqui";
    assert.deepEqual(extractUrls(body), ["https://openai.com/index/chatgpt"]);
  });

  it("extrai múltiplas URLs em um só e-mail", () => {
    const body = `Dois papers bons:
      - https://arxiv.org/abs/2501.00001
      - https://huggingface.co/papers/2501.00002.
    `;
    assert.deepEqual(extractUrls(body), [
      "https://arxiv.org/abs/2501.00001",
      "https://huggingface.co/papers/2501.00002",
    ]);
  });

  it("filtra URLs muito curtas (< 10 chars)", () => {
    // "https://x" tem 9 chars — filtrado
    const body = "tudo mundo linka https://x mas é curto demais";
    assert.deepEqual(extractUrls(body), []);
  });

  it("URL_REGEX tem flag global (stateful match() funciona)", () => {
    // Apenas garantir que a regex está realmente configurada como global
    assert.ok(URL_REGEX.global, "URL_REGEX deve ter flag /g");
  });
});
