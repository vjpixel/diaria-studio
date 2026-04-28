import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeTitleOption } from "../scripts/lib/title-heuristic.ts";

describe("looksLikeTitleOption (#259)", () => {
  describe("aceita", () => {
    it("título curto sem pontuação", () => {
      assert.equal(looksLikeTitleOption("OpenAI fecha exclusividade"), true);
    });

    it("título curto com ponto de interrogação", () => {
      assert.equal(looksLikeTitleOption("Pode confiar no ChatGPT?"), true);
    });

    it("título curto com ponto de exclamação", () => {
      assert.equal(looksLikeTitleOption("OpenAI revoluciona o mercado!"), true);
    });

    it("título curto com ellipsis (3 pontos)", () => {
      assert.equal(looksLikeTitleOption("Estudo mostra..."), true);
    });

    it("título curto com 4+ pontos (ellipsis estendida)", () => {
      assert.equal(looksLikeTitleOption("E agora?...."), true);
    });

    it("título com vírgula final (raro mas válido)", () => {
      assert.equal(looksLikeTitleOption("OpenAI lança GPT-5,"), true);
    });

    it("título com 60 chars exatos", () => {
      const t = "a".repeat(60);
      assert.equal(looksLikeTitleOption(t), true);
    });
  });

  describe("rejeita", () => {
    it("título com ponto único final", () => {
      assert.equal(looksLikeTitleOption("OpenAI lança GPT-5.5."), false);
    });

    it("parágrafo de body (longo + ponto)", () => {
      const t =
        "Este parágrafo do body é claramente longo e termina em ponto final.";
      assert.equal(looksLikeTitleOption(t), false);
    });

    it("linha com 61 chars", () => {
      const t = "a".repeat(61);
      assert.equal(looksLikeTitleOption(t), false);
    });

    it("linha vazia", () => {
      assert.equal(looksLikeTitleOption(""), false);
    });

    it("só whitespace", () => {
      assert.equal(looksLikeTitleOption("   \t  "), false);
    });

    it("ponto seguido de whitespace final", () => {
      assert.equal(looksLikeTitleOption("Frase qualquer.   "), false);
    });
  });

  describe("ellipsis vs ponto único — discrimination", () => {
    it("dois pontos NÃO contam como ellipsis", () => {
      // ".." (2 pontos) não é ellipsis editorial — rejeita como body.
      assert.equal(looksLikeTitleOption("Frase incompleta.."), false);
    });

    it("três pontos contam como ellipsis", () => {
      assert.equal(looksLikeTitleOption("Frase incompleta..."), true);
    });
  });
});
