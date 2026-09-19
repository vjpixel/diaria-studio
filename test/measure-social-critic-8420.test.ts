/**
 * test/measure-social-critic-8420.test.ts (#8420 — medição 7b do epic #8412)
 *
 * Cobre a lógica pura de `scripts/measure-social-critic-8420.ts`
 * (`extractSocialParagraphs`, catálogo `PATTERNS`/`PATTERN_INSTRUCTIONS`) —
 * a parte reutilizável do harness que não depende do corpus real em disco
 * nem da API do Jev. A medição em si (gabarito cego × Jev, n=50 parágrafos,
 * 8 padrões) foi rodada manualmente contra o corpus real (resultado
 * publicado na issue #8420); este teste só garante que o parser e o
 * catálogo de padrões não regridam silenciosamente.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSocialParagraphs, PATTERNS, PATTERN_INSTRUCTIONS } from "../scripts/measure-social-critic-8420.ts";

test("extractSocialParagraphs extrai parágrafos de d1/d2/d3/post_pixel dentro de # Social", () => {
  const md = [
    "# Social",
    "",
    "> nota de rodapé sobre o formato, não é parágrafo de conteúdo real mas passa dos 120 chars só pra garantir",
    "",
    "## d1",
    "",
    "Este é um parágrafo longo o bastante para passar do piso de 120 caracteres definido no filtro do harness de medição, então deve entrar no pool.",
    "",
    "#Hashtag1 #Hashtag2",
    "",
    "## post_pixel",
    "",
    "Outro parágrafo bem mais longo, também acima do piso de 120 caracteres do filtro, pra ser elegível pro pool de amostragem do harness de medição.",
  ].join("\n");

  const paras = extractSocialParagraphs(md, "260911");
  const bySection = new Map(paras.map((p) => [p.section, p.text]));
  assert.equal(paras.filter((p) => p.section === "d1").length, 1);
  assert.ok(bySection.get("d1")!.includes("piso de 120"));
  assert.equal(paras.filter((p) => p.section === "post_pixel").length, 1);
  // Pure hashtag line never becomes its own paragraph entry.
  assert.ok(!paras.some((p) => /^(#\w+\s*)+$/.test(p.text)));
});

test("extractSocialParagraphs para na fronteira de # Curto — não entra no pool", () => {
  const md = [
    "# Social",
    "",
    "## d1",
    "",
    "Parágrafo elegível da seção Social, bem acima do piso de 120 caracteres do filtro do harness de medição, então deve entrar no pool.",
    "",
    "# Curto",
    "",
    "## d1",
    "",
    "Este parágrafo pertence à seção Curto e não deve aparecer no pool, mesmo tendo tamanho suficiente para passar no filtro.",
  ].join("\n");

  const paras = extractSocialParagraphs(md, "260911");
  assert.equal(paras.length, 1);
  assert.ok(!paras[0].text.includes("Curto"));
});

test("extractSocialParagraphs filtra fragmentos curtos, placeholders não resolvidos e a linha de poll É IA?", () => {
  const md = [
    "# Social",
    "",
    "## d3",
    "",
    "É IA? 🧐",
    "",
    "Curto demais.",
    "",
    "Hoje saíram mais {outros_count} novidades, texto longo o bastante pra passar do piso mas com placeholder não resolvido.",
  ].join("\n");

  assert.deepEqual(extractSocialParagraphs(md, "260911"), []);
});

test("extractSocialParagraphs filtra legendas de crédito de foto (CC BY-SA / Wikimedia)", () => {
  const md = [
    "# Social",
    "",
    "## d3",
    "",
    "Uma legenda de foto com licença Creative Commons — [Autor](https://commons.wikimedia.org/wiki/User:X) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).",
  ].join("\n");

  assert.deepEqual(extractSocialParagraphs(md, "260911"), []);
});

test("extractSocialParagraphs devolve [] quando não há seção # Social", () => {
  assert.deepEqual(extractSocialParagraphs("# Curto\n\n## d1\n\nTexto qualquer.", "260911"), []);
});

test("catálogo de padrões tem 1 instrução não-vazia por padrão declarado", () => {
  assert.ok(PATTERNS.length >= 1);
  for (const p of PATTERNS) {
    assert.ok(PATTERN_INSTRUCTIONS[p] && PATTERN_INSTRUCTIONS[p].length > 20, `padrão sem instrução: ${p}`);
  }
  // Nenhuma instrução órfã (chave em PATTERN_INSTRUCTIONS que não está em PATTERNS).
  assert.deepEqual(Object.keys(PATTERN_INSTRUCTIONS).sort(), [...PATTERNS].sort());
});
