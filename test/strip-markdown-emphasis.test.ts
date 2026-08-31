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

  it("#6866 (achado do review, P3): palavra acentuada colada no delimitador de italic não é falsamente stripada — \\w do JS é ASCII-only, corrigido com \\p{L}/\\p{N}", () => {
    // Antes do fix: "é"/"café" não contam como \w (ASCII-only), então o
    // lookaround (?<![\w*]) não bloqueava e "café*importante*" stripava
    // errado pra "caféimportante" — asterisco colado numa palavra acentuada
    // deveria ser tratado como "colado a caractere de palavra" (preservado),
    // igual já acontecia com "3*4"/"user_name" em ASCII.
    assert.equal(stripMarkdownEmphasis("café*importante*"), "café*importante*");
    assert.equal(stripMarkdownEmphasis("análise *crítica* aqui"), "análise crítica aqui");
    assert.equal(stripMarkdownEmphasis("é *importante* também"), "é importante também");
  });

  it("#6866 (achado do review, P2): dois spans de bold curtos SEGUIDOS não se fundem — cada ** fecha no par mais próximo", () => {
    // Antes do fix: "**a** **b**" virava "a** **b" (o motor engolia o
    // fechamento do 1º span como conteúdo e só parava no fechamento do 2º).
    assert.equal(stripMarkdownEmphasis("**a** **b**"), "a b");
    assert.equal(stripMarkdownEmphasis("**um** **dois** **três**"), "um dois três");
  });

  it("#6862: preserva o negrito exigido por parágrafo do social-writer (#6086 item c) — não existe lint bloqueando isso, ver docstring do módulo", () => {
    // Contrato real de .claude/agents/social-writer.md: cada parágrafo de
    // ## d{N} em 03-social.md tem EXATAMENTE UM trecho **...** — é assim
    // que gen-carousel-cards.ts sabe qual frase é o resumo do slide. Este
    // teste documenta que stripMarkdownEmphasis não é chamado sobre o
    // ARQUIVO-FONTE (só no ponto de publicação) — aqui só confirma que a
    // função em si não tem opinião sobre onde é chamada, só sobre COMO
    // remove ênfase quando de fato é chamada.
    const paragrafoReal =
      "A Anthropic lançou um modelo que roda direto no navegador, sem enviar nada pra nuvem. " +
      "**O trade-off é velocidade: local ainda é mais lento que API.**";
    const stripped = stripMarkdownEmphasis(paragrafoReal);
    assert.ok(!stripped.includes("**"), "a função remove o negrito quando CHAMADA — é o publisher que decide chamar ou não");
  });
});
