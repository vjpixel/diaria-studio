/** #9458: WORDPRESS_FOOTER_RE não pode cortar a partir de um "o post" no meio do resumo. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFeedBoilerplate, cleanSummary } from "../scripts/lib/clean-summary.ts";

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
  // excerpt WordPress típico termina em "[…]" antes do rodapé
  assert.equal(stripFeedBoilerplate("Texto do excerpt […] O post Foo apareceu primeiro em Site."), "Texto do excerpt […]");
});

// ── #9483: rodapé sem pontuação antes do "O post" ────────────────────────────

test("#9483: </p><p> colapsado em espaço (último parágrafo sem pontuação) — rodapé sai", () => {
  const out = cleanSummary(
    "<p>A OpenAI lançou Foo hoje com recursos</p><p>O post OpenAI Foo apareceu primeiro em Site.</p>",
    "OpenAI lança Foo",
  );
  assert.doesNotMatch(out, /apareceu primeiro em/);
  assert.match(out, /A OpenAI lançou Foo hoje com recursos/);
});

test("#9483: '…O post' colado e ': O post' — rodapé sai", () => {
  assert.equal(stripFeedBoilerplate("excerpt…O post Foo apareceu primeiro em Site."), "excerpt…");
  assert.equal(stripFeedBoilerplate("texto: O post Foo apareceu primeiro em Site."), "texto:");
  assert.equal(stripFeedBoilerplate("Body without period The post Foo appeared first on Blog."), "Body without period");
});

test("#9483: proteções do #9458 seguem valendo com a âncora relaxada", () => {
  // 'o post' minúsculo nunca inicia o corte, mesmo sem pontuação antes do rodapé
  assert.equal(
    stripFeedBoilerplate(
      "Segundo o post publicado no blog, a OpenAI cortou preços sem aviso O post OpenAI corta preços apareceu primeiro em TecMundo.",
    ),
    "Segundo o post publicado no blog, a OpenAI cortou preços sem aviso",
  );
  // "O post" colado a letra (meio de palavra) não é rodapé
  assert.equal(stripFeedBoilerplate("RádioO post Foo apareceu primeiro em Site."), "RádioO post Foo apareceu primeiro em Site.");
  // sem "apareceu primeiro em", nada sai
  assert.equal(stripFeedBoilerplate("Leia O post completo no blog"), "Leia O post completo no blog");
});
