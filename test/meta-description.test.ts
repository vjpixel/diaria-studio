/**
 * test/meta-description.test.ts (#5101 item 2)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMetaDescriptionSuggestion,
  DEFAULT_META_DESCRIPTION_MAX_LENGTH,
} from "../scripts/lib/meta-description.ts";

describe("buildMetaDescriptionSuggestion (#5101)", () => {
  it("usa o 1º parágrafo do corpo quando cabe no limite", () => {
    const body = "A OpenAI anunciou um novo modelo hoje.\n\nSegundo parágrafo, ignorado.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, "A OpenAI anunciou um novo modelo hoje.");
  });

  it("nunca ultrapassa maxLength (default 155)", () => {
    const body = "Frase longa. ".repeat(30); // bem > 155 chars
    const out = buildMetaDescriptionSuggestion({ body });
    assert.ok(out !== null);
    assert.ok(out!.length <= DEFAULT_META_DESCRIPTION_MAX_LENGTH, `length=${out!.length}`);
  });

  it("respeita maxLength customizado", () => {
    const body = "Um parágrafo qualquer com bastante texto para forçar o truncamento no limite customizado.";
    const out = buildMetaDescriptionSuggestion({ body, maxLength: 40 });
    assert.ok(out !== null);
    assert.ok(out!.length <= 40, `length=${out!.length}`);
  });

  it("remove markdown inline (bold, link, itálico, código)", () => {
    const body =
      "A **Anthropic** lançou o [Claude Opus 5](https://example.com) com suporte a `tool use` e modo *experimental*.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.ok(out !== null);
    assert.doesNotMatch(out!, /[*_`[\]]/);
    assert.match(out!, /^A Anthropic lançou o Claude Opus 5 com suporte a tool use e modo experimental\.?/);
  });

  it("não corta no meio de uma palavra ao truncar — cai pro word-boundary anterior inteiro", () => {
    const body = "Palavra completa " + "x".repeat(200);
    const out = buildMetaDescriptionSuggestion({ body, maxLength: 30 });
    assert.ok(out !== null);
    // Asserção forte: o corte deve acontecer ANTES do início da corrida de
    // "x" (não em algum ponto arbitrário no meio dela) — nenhum "x" deve
    // sobreviver no resultado, e o texto final é exatamente o esperado.
    // (Antes: `!/\sx+$/.test(out) || out.endsWith("…")` — o lado direito do
    // OR é quase sempre verdadeiro e não distinguia regressão de
    // comportamento correto.)
    assert.equal(out, "Palavra completa…");
    assert.ok(!out!.includes("x"), `out="${out}"`);
  });

  it("body vazio ou só espaço → null (nunca string vazia como sentinela)", () => {
    assert.equal(buildMetaDescriptionSuggestion({ body: "" }), null);
    assert.equal(buildMetaDescriptionSuggestion({ body: "   \n\n   " }), null);
  });

  it("body undefined ou null → null (call site real interpola JSON que pode vir malformado)", () => {
    assert.equal(buildMetaDescriptionSuggestion({ body: undefined }), null);
    assert.equal(buildMetaDescriptionSuggestion({ body: null }), null);
  });

  it("ignora parágrafos seguintes — só o 1º entra na sugestão", () => {
    const body = "Primeiro.\n\nSegundo parágrafo que não deveria aparecer.\n\nTerceiro.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, "Primeiro.");
    assert.doesNotMatch(out!, /Segundo/);
  });

  it("maxLength <= 1 é inválido — cai pro default em vez de slice negativo/degenerado", () => {
    const body = "Um parágrafo qualquer com bastante texto para forçar o truncamento.";
    const outZero = buildMetaDescriptionSuggestion({ body, maxLength: 0 });
    const outNegative = buildMetaDescriptionSuggestion({ body, maxLength: -5 });
    const outOne = buildMetaDescriptionSuggestion({ body, maxLength: 1 });
    const outDefault = buildMetaDescriptionSuggestion({ body });
    assert.equal(outZero, outDefault);
    assert.equal(outNegative, outDefault);
    assert.equal(outOne, outDefault);
  });

  // ── Fleet review pré-merge: input degenerado não pode produzir sugestão
  // corrompida — deve cair pro próximo parágrafo real ou retornar `null`. ──

  it("1º parágrafo é só uma imagem markdown → não vaza '!' solto, cai pro próximo parágrafo", () => {
    const body = "![Diagrama da arquitetura](https://example.com/diagrama.png)\n\nO modelo processa dados em três etapas.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, "O modelo processa dados em três etapas.");
    assert.ok(out === null || !out.includes("!"), `out="${out}"`);
  });

  it("1º parágrafo é só uma imagem markdown e não há próximo parágrafo → null", () => {
    const body = "![Diagrama da arquitetura](https://example.com/diagrama.png)";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, null);
  });

  it("body com negrito não fechado → não vaza '**' cru, marcador é descartado", () => {
    const body = "A empresa **anunciou um novo modelo que promete revolucionar o mercado de trabalho.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.ok(out !== null);
    assert.doesNotMatch(out!, /\*/);
    assert.match(out!, /^A empresa anunciou um novo modelo/);
  });

  it("1º parágrafo é só um link markdown (label curto) → não produz sugestão sem sentido, cai pro próximo parágrafo", () => {
    const body = "[Fonte](https://example.com/artigo)\n\nA pesquisa mostra avanços significativos em diagnóstico médico.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, "A pesquisa mostra avanços significativos em diagnóstico médico.");
    assert.ok(out === null || out !== "Fonte", `out="${out}"`);
  });

  it("1º parágrafo é só um link markdown e não há próximo parágrafo → null", () => {
    const body = "[Fonte](https://example.com/artigo)";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, null);
  });
});
