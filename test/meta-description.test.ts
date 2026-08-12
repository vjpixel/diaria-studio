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
    assert.ok(out.length <= DEFAULT_META_DESCRIPTION_MAX_LENGTH, `length=${out.length}`);
  });

  it("respeita maxLength customizado", () => {
    const body = "Um parágrafo qualquer com bastante texto para forçar o truncamento no limite customizado.";
    const out = buildMetaDescriptionSuggestion({ body, maxLength: 40 });
    assert.ok(out.length <= 40, `length=${out.length}`);
  });

  it("remove markdown inline (bold, link, itálico, código)", () => {
    const body =
      "A **Anthropic** lançou o [Claude Opus 5](https://example.com) com suporte a `tool use` e modo *experimental*.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.doesNotMatch(out, /[*_`[\]]/);
    assert.match(out, /^A Anthropic lançou o Claude Opus 5 com suporte a tool use e modo experimental\.?/);
  });

  it("não corta no meio de uma palavra ao truncar", () => {
    const body = "Palavra completa " + "x".repeat(200);
    const out = buildMetaDescriptionSuggestion({ body, maxLength: 30 });
    assert.ok(!/\sx+$/.test(out) || out.endsWith("…"), `out="${out}"`);
  });

  it("string vazia quando body é vazio ou só espaço", () => {
    assert.equal(buildMetaDescriptionSuggestion({ body: "" }), "");
    assert.equal(buildMetaDescriptionSuggestion({ body: "   \n\n   " }), "");
  });

  it("ignora parágrafos seguintes — só o 1º entra na sugestão", () => {
    const body = "Primeiro.\n\nSegundo parágrafo que não deveria aparecer.\n\nTerceiro.";
    const out = buildMetaDescriptionSuggestion({ body });
    assert.equal(out, "Primeiro.");
    assert.doesNotMatch(out, /Segundo/);
  });
});
