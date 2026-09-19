/**
 * test/measure-title-picker-8420.test.ts (#8420 — medição 7a do epic #8412)
 *
 * Cobre a lógica pura de parsing de `scripts/measure-title-picker-8420.ts`
 * (`parseDestaques`/`extractBodyForUrl`) — a parte reutilizável do harness
 * que não depende do corpus real em disco nem da API do Jev. A medição em si
 * (amostragem + comparação Sonnet blind × Jev × editor) foi rodada
 * manualmente contra o corpus real (resultado publicado na issue #8420);
 * este teste só garante que o parser não regride silenciosamente.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDestaques, extractBodyForUrl } from "../scripts/measure-title-picker-8420.ts";

test("parseDestaques extrai as 3 opções de título + URL de um bloco DESTAQUE", () => {
  const md = [
    "**DESTAQUE 1 | 🔬 PESQUISA**",
    "",
    "**[Título A](https://example.com/a)**",
    "",
    "**[Título B](https://example.com/a)**",
    "",
    "**[Título C](https://example.com/a)**",
    "",
    "Corpo do parágrafo.",
    "",
    "Por que isso importa:",
    "",
    "Frase de impacto.",
  ].join("\n");

  const blocks = parseDestaques(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].category, "🔬 PESQUISA");
  assert.deepEqual(blocks[0].titles, ["Título A", "Título B", "Título C"]);
  assert.equal(blocks[0].url, "https://example.com/a");
});

test("parseDestaques reconhece destaque já podado (1 título só)", () => {
  const md = [
    "**DESTAQUE 2 | 💼 MERCADO**",
    "",
    "**[Título único](https://example.com/b)**",
    "",
    "Corpo.",
  ].join("\n");

  const blocks = parseDestaques(md);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].titles, ["Título único"]);
});

test("parseDestaques ignora texto fora de blocos DESTAQUE", () => {
  const md = "Texto solto sem header de destaque.\n\n**[Não é destaque](https://x.com)**";
  assert.deepEqual(parseDestaques(md), []);
});

test("extractBodyForUrl corta no marcador 'Por que isso importa' e remove as linhas de título", () => {
  const md = [
    "**DESTAQUE 1 | 🔬 PESQUISA**",
    "",
    "**[Título A](https://example.com/a)**",
    "",
    "Primeiro parágrafo do corpo.",
    "",
    "Segundo parágrafo do corpo.",
    "",
    "Por que isso importa:",
    "",
    "Frase de impacto que não deve aparecer no resumo.",
  ].join("\n");

  const body = extractBodyForUrl(md, "https://example.com/a");
  assert.ok(body);
  assert.ok(body!.includes("Primeiro parágrafo"));
  assert.ok(body!.includes("Segundo parágrafo"));
  assert.ok(!body!.includes("Frase de impacto"));
  assert.ok(!body!.includes("Título A"));
});

test("extractBodyForUrl devolve null quando a URL não aparece no markdown", () => {
  const md = "**DESTAQUE 1 | X**\n\n**[T](https://outra.com)**\n\nCorpo.\n\nPor que isso importa:\n\nX.";
  assert.equal(extractBodyForUrl(md, "https://nao-existe.com"), null);
});
