// Regresão #8631: fonte "Blog do Google Brasil (IA)" (tutoriais Copilot/Gemini)
// descoberta falhou 3x consecutivas (24-26/08, último ok 14/08).
// Deve permanecer desativada em seed/sources.csv até resolução.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";

describe("#8631 discovery falha fonte tutorial", () => {
  it("linha 43 do seed/sources.csv está comentada (desativada)", () => {
    const lines = readFileSync("seed/sources.csv", "utf-8").split("\n");
    const line43 = lines[42]; // 0-indexed
    assert.match(line43, /^# DESATIVADO #8631/);
  });

  it("fonte 'Blog do Google Brasil (IA)' não aparece como ativa", () => {
    const content = readFileSync("seed/sources.csv", "utf-8");
    // A linha original começa com o nome; com comentário não deve aparecer sem #
    const activeMatches = content.match(/^Blog do Google Brasil \(IA\)/gm);
    assert.equal(activeMatches, null);
  });
});
