/** #9458: WORDPRESS_FOOTER_RE não pode cortar a partir de um "o post" no meio do resumo. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFeedBoilerplate } from "../scripts/lib/clean-summary.ts";

test("#9458: 'o post' no meio do texto preserva o resumo; só o rodapé sai", () => {
  const input =
    "Segundo o post publicado no blog, a OpenAI cortou preços em 50%. O post OpenAI corta preços apareceu primeiro em TecMundo.";
  assert.equal(stripFeedBoilerplate(input), "Segundo o post publicado no blog, a OpenAI cortou preços em 50%.");
});

test("#9458: 'O post' capitalizado em frase anterior não é confundido com o rodapé", () => {
  const input = "O post do CEO detalha o plano. O post Plano novo apareceu primeiro em Site.";
  assert.equal(stripFeedBoilerplate(input), "O post do CEO detalha o plano.");
});

test("#9458: rodapé sozinho e em inglês continuam saindo", () => {
  assert.equal(stripFeedBoilerplate("O post Título apareceu primeiro em Fonte."), "");
  assert.equal(stripFeedBoilerplate("Body text here. The post Foo appeared first on Blog."), "Body text here.");
});
