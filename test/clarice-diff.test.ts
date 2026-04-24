import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitParagraphs,
  similarity,
  alignParagraphs,
} from "../scripts/clarice-diff.ts";

describe("splitParagraphs", () => {
  it("split por linha em branco dupla", () => {
    const paras = splitParagraphs("Parágrafo 1.\n\nParágrafo 2.\n\nParágrafo 3.");
    assert.deepEqual(paras, ["Parágrafo 1.", "Parágrafo 2.", "Parágrafo 3."]);
  });

  it("trata múltiplas linhas em branco como separador único", () => {
    const paras = splitParagraphs("A.\n\n\n\nB.");
    assert.deepEqual(paras, ["A.", "B."]);
  });

  it("remove parágrafos vazios e trim", () => {
    const paras = splitParagraphs("\n\nA.\n\n   \n\nB.\n\n");
    assert.deepEqual(paras, ["A.", "B."]);
  });

  it("mantém quebras de linha dentro do parágrafo", () => {
    const paras = splitParagraphs("Linha 1\nLinha 2\n\nSegundo parágrafo");
    assert.equal(paras.length, 2);
    assert.equal(paras[0], "Linha 1\nLinha 2");
  });

  it("texto vazio retorna array vazio", () => {
    assert.deepEqual(splitParagraphs(""), []);
    assert.deepEqual(splitParagraphs("\n\n"), []);
  });
});

describe("similarity", () => {
  it("strings idênticas retornam 1", () => {
    assert.equal(similarity("hello world", "hello world"), 1);
  });

  it("strings completamente diferentes retornam próximo de 0", () => {
    const s = similarity("aaaaa", "bbbbb");
    assert.equal(s, 0);
  });

  it("ambas vazias retorna 1", () => {
    assert.equal(similarity("", ""), 1);
  });

  it("edit menor que metade fica > 0.5", () => {
    const s = similarity("hello world", "hello worlds");
    assert.ok(s > 0.9, `esperado > 0.9, got ${s}`);
  });

  it("textos longos usam sampling heurístico", () => {
    const long = "x".repeat(3000);
    const long2 = "x".repeat(2999) + "y";
    const s = similarity(long, long2);
    assert.ok(s > 0.9, `esperado > 0.9 pra diferença mínima em textos longos, got ${s}`);
  });
});

describe("alignParagraphs", () => {
  it("parágrafos idênticos geram 0 changes", () => {
    const orig = ["A.", "B.", "C."];
    const rev = ["A.", "B.", "C."];
    assert.deepEqual(alignParagraphs(orig, rev), []);
  });

  it("edit simples de um parágrafo", () => {
    const orig = ["Alô mundo.", "B.", "C."];
    const rev = ["Olá, mundo.", "B.", "C."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "Alô mundo.");
    assert.equal(changes[0].after, "Olá, mundo.");
  });

  it("inserção no meio", () => {
    const orig = ["A.", "C."];
    const rev = ["A.", "B novo completamente diferente.", "C."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "");
    assert.equal(changes[0].after, "B novo completamente diferente.");
  });

  it("deleção no meio", () => {
    const orig = ["A.", "B que sera removido totalmente.", "C."];
    const rev = ["A.", "C."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "B que sera removido totalmente.");
    assert.equal(changes[0].after, "");
  });

  it("parágrafos adicionados no final", () => {
    const orig = ["A.", "B."];
    const rev = ["A.", "B.", "C novo.", "D novo."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].before, "");
    assert.equal(changes[0].after, "C novo.");
  });

  it("parágrafos removidos do final", () => {
    const orig = ["A.", "B.", "C.", "D."];
    const rev = ["A.", "B."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].after, "");
    assert.equal(changes[1].after, "");
  });

  it("edit alta similaridade é tratado como edit, não insert+delete", () => {
    const orig = ["OpenAI anunciou o novo modelo GPT-5 com capacidades multimodais."];
    const rev = ["OpenAI anunciou o novo modelo GPT-5 com capacidades multimodais avançadas."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.ok(changes[0].before && changes[0].after);
  });
});
