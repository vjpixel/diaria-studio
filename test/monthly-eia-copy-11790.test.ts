import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripPrevResultLine } from "../scripts/lib/mensal/monthly-eia-copy.ts";
import { parseEiaLegend } from "../scripts/lib/mensal/monthly-render.ts";

describe("stripPrevResultLine (#11790)", () => {
  const md = "---\neia_answer: {A: real}\n---\n\n**É IA?**\n\nFoto de fulano.\n\nResultado da última edição: 68% das pessoas acertaram.\n";
  it("remove a linha de resultado da diária e preserva o resto", () => {
    const out = stripPrevResultLine(md);
    assert.doesNotMatch(out, /Resultado da última edição/);
    assert.match(out, /Foto de fulano\./);
    assert.match(out, /eia_answer/);
  });
  it("a legenda parseada não carrega mais o resultado", () => {
    assert.equal(parseEiaLegend(stripPrevResultLine(md)), "Foto de fulano.");
  });
  it("sem a linha, é idempotente", () => {
    const clean = stripPrevResultLine(md);
    assert.equal(stripPrevResultLine(clean), clean);
  });
});
