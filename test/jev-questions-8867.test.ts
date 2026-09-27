import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEDUP_GRAYZONE_8417 } from "../scripts/lib/jev-questions.ts";

// #8867: o braço B do A/B (#8421) errou 2/12 pares de zona cinzenta — em
// ambos, uma entrevista/guia sobre um lançamento já publicado foi tratada
// como "mesma história" do anúncio original. O editor decidiu (27/09/2026):
// conteúdo derivado (entrevista, guia, tutorial, análise) não é repetição.
// Regressão: a instrução precisa deixar essa exceção explícita, senão o Jev
// volta a confundir os dois casos.
describe("DEDUP_GRAYZONE_8417 (#8867)", () => {
  it("instrui explicitamente que conteúdo derivado não é a mesma história", () => {
    const text = DEDUP_GRAYZONE_8417.question.instructions.toLowerCase();
    assert.match(text, /entrevista/);
    assert.match(text, /guia/);
    assert.match(text, /tutorial/);
    assert.match(text, /não é a mesma história/);
  });
});
