import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdownEmphasis } from "../scripts/lib/strip-markdown-emphasis.ts";

describe("stripMarkdownEmphasis (#6862)", () => {
  it("remove **bold** simples, preserva o texto", () => {
    assert.equal(stripMarkdownEmphasis("isso é **importante** de verdade"), "isso é importante de verdade");
  });

  it("remove __bold__ (underscore duplo)", () => {
    assert.equal(stripMarkdownEmphasis("isso é __importante__ também"), "isso é importante também");
  });

  it("remove *italic* simples", () => {
    assert.equal(stripMarkdownEmphasis("um *detalhe* qualquer"), "um detalhe qualquer");
  });

  it("remove _italic_ simples", () => {
    assert.equal(stripMarkdownEmphasis("um _detalhe_ qualquer"), "um detalhe qualquer");
  });

  it("múltiplas ocorrências de bold na mesma linha", () => {
    assert.equal(
      stripMarkdownEmphasis("**primeiro** ponto, **segundo** ponto"),
      "primeiro ponto, segundo ponto",
    );
  });

  it("bold que engloba múltiplas palavras", () => {
    assert.equal(
      stripMarkdownEmphasis("**um jailbreak de IA não arromba, encena**"),
      "um jailbreak de IA não arromba, encena",
    );
  });

  it("#6862: caso real 1 — bold encostando em dois-pontos (padrão do social-writer)", () => {
    assert.equal(
      stripMarkdownEmphasis("**Por que isso importa:** o atacante assume um papel."),
      "Por que isso importa: o atacante assume um papel.",
    );
  });

  it("#6862: caso real 2 — bold no meio de frase com pontuação colada", () => {
    assert.equal(
      stripMarkdownEmphasis("O modelo responde fiel à cena, **sem quebrar o personagem**, e isso muda tudo."),
      "O modelo responde fiel à cena, sem quebrar o personagem, e isso muda tudo.",
    );
  });

  it("preserva asterisco legítimo no MEIO de palavra (matemática/expressão) — não é ênfase", () => {
    assert.equal(stripMarkdownEmphasis("o resultado é 3*4 = 12"), "o resultado é 3*4 = 12");
  });

  it("preserva underscore legítimo em identificador (snake_case) — não é ênfase", () => {
    assert.equal(stripMarkdownEmphasis("o campo se chama user_name no banco"), "o campo se chama user_name no banco");
    assert.equal(
      stripMarkdownEmphasis("veja algo_importante_aqui no código"),
      "veja algo_importante_aqui no código",
    );
  });

  it("texto sem nenhuma marcação passa intacto", () => {
    const plain = "Um texto qualquer sem marcação nenhuma, com vírgula e ponto final.";
    assert.equal(stripMarkdownEmphasis(plain), plain);
  });

  it("bold e italic misturados na mesma linha", () => {
    assert.equal(
      stripMarkdownEmphasis("**negrito** e depois *itálico* juntos"),
      "negrito e depois itálico juntos",
    );
  });

  it("multiline — bold cruzando quebra de linha", () => {
    assert.equal(stripMarkdownEmphasis("**linha um\nlinha dois**"), "linha um\nlinha dois");
  });

  it("idempotente — rodar 2x produz o mesmo resultado da 1ª vez", () => {
    const once = stripMarkdownEmphasis("**bold** e *italic* e texto normal");
    const twice = stripMarkdownEmphasis(once);
    assert.equal(once, twice);
  });

  it("string vazia não lança", () => {
    assert.equal(stripMarkdownEmphasis(""), "");
  });

  it("** sem par de fechamento não é removido (texto malformado passa intacto)", () => {
    assert.equal(stripMarkdownEmphasis("começa com ** mas nunca fecha"), "começa com ** mas nunca fecha");
  });
});
