/**
 * test/helpers-css.test.ts (#5480)
 *
 * Cobre `stripCssComments` (`test/helpers/css.ts`), que virou infraestrutura
 * COMPARTILHADA de duas invariantes (`studio-css-no-raw-hex` #4674 e
 * `studio-css-var-defined` #5480).
 *
 * Testar um helper de teste parece excessivo até notar o modo de falha: se
 * ele apagar demais, as duas invariantes param de enxergar as declarações
 * apagadas e passam a **reportar verde sobre código não checado**. Silenciar
 * o detector é pior que o defeito que ele procura — e o caso do `/*` dentro
 * de string (achado no review do PR #5482) fazia exatamente isso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripCssComments } from "./helpers/css.ts";

describe("stripCssComments", () => {
  it("remove comentário simples e preserva o resto", () => {
    assert.equal(stripCssComments("a { color: red; } /* nota */ b { color: blue; }").replace(/\s+/g, " ").trim(), "a { color: red; } b { color: blue; }");
  });

  it("preserva a contagem de linhas (números de linha continuam corretos)", () => {
    const css = "linha1\n/* c1\nc2\nc3 */\nlinha5";
    const out = stripCssComments(css);
    assert.equal(out.split("\n").length, css.split("\n").length);
    assert.equal(out.split("\n")[4], "linha5");
  });

  it("some com o conteúdo do comentário, incluindo hex e var()", () => {
    const out = stripCssComments("/* #EBE5D0 e var(--fg-dim) */ .x { color: var(--ink); }");
    assert.ok(!out.includes("#EBE5D0"));
    assert.ok(!out.includes("--fg-dim"));
    assert.ok(out.includes("var(--ink)"));
  });

  // Regressão do review do PR #5482. A versão ingênua tratava o `/*` dentro
  // da string como abertura de comentário e apagava tudo até o próximo `*/`
  // real — engolindo declarações no meio, que então escapavam das duas
  // invariantes sem deixar rastro.
  describe("string literal não abre comentário (regressão #5482)", () => {
    it('`content: "/*"` não engole as declarações seguintes', () => {
      const css = [
        '.icon::after { content: "/*"; }',
        ".vitima { color: #ff0000; }",
        "/* comentário de verdade */",
        ".outra { color: var(--ink); }",
      ].join("\n");
      const out = stripCssComments(css);
      assert.ok(out.includes("#ff0000"), "declaração entre a string e o próximo comentário foi engolida");
      assert.ok(out.includes("var(--ink)"));
      assert.ok(!out.includes("comentário de verdade"), "o comentário real ainda deve sumir");
    });

    it('`content: "*/"` continua intacto', () => {
      const css = '.x::after { content: "*/"; color: var(--ink); }';
      assert.equal(stripCssComments(css), css);
    });

    it("aspas simples também protegem", () => {
      const css = ".x::after { content: '/*'; }\n.y { color: #abcdef; }";
      assert.ok(stripCssComments(css).includes("#abcdef"));
    });

    it("aspa escapada não fecha a string cedo demais", () => {
      const css = '.x::after { content: "a\\"/*b"; }\n.y { color: #abcdef; }';
      assert.ok(stripCssComments(css).includes("#abcdef"));
    });
  });

  it("comentário não terminado consome até o fim, sem lançar", () => {
    // Entrada malformada não deve derrubar a suíte — degrada removendo o
    // resto, que é o comportamento conservador (nunca reporta verde sobre
    // texto que não conseguiu interpretar).
    const out = stripCssComments(".x { color: red; }\n/* aberto e nunca fechado");
    assert.ok(out.includes("color: red"));
    assert.ok(!out.includes("nunca fechado"));
  });

  it("entrada sem comentário nenhum volta idêntica", () => {
    const css = ".a { color: var(--ink); }\n.b { background: var(--paper); }";
    assert.equal(stripCssComments(css), css);
  });
});
