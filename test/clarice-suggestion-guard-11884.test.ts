import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClariceNoise } from "../scripts/lib/clarice-suggestion-guard.ts";
import { applyClariceSuggestions } from "../scripts/clarice-apply.ts";
import { applyChunkSuggestions } from "../scripts/lib/clarice-chunk.ts";

const cases = [
  ["Veja https://example.com", ".com", ". com"],
  ["Veja https://example.br", ".br", ". br"],
  ["[link](https://example.org/a,b)", "a,b", "a, b"],
  ["Veja **palavra** agora", "palavra", " palavra"],
  ["Intro\n  - item afim de ajudar", "  - item afim de", "- item a fim de"],
  ["fim afim de ajudar  \nComeço", "afim de ajudar  \n", "a fim de ajudar\n"],
];

for (const [text, from, to] of cases) {
  test(`preserva contexto e estrutura: ${JSON.stringify(from)}`, () => {
    assert.equal(classifyClariceNoise(from, to, text), "whitespace_only");
    const result = applyClariceSuggestions(text, [{ from, to }]);
    assert.equal(result.patched, text);
    assert.equal(result.skipped[0].reason, "whitespace_only");
    const chunk = applyChunkSuggestions({ text, startOffset: 0 }, [{ from, to }], () => {});
    assert.equal(chunk.text, text);
    assert.equal(chunk.skipped[0].reason, "whitespace_only");
  });
}

test("aceita correção de prosa ao lado de link/markup e usa o estado atual", () => {
  const text = "[link](https://example.com) **bom** afim de ajudar e texto,outro";
  const suggestions = [
    { from: "afim de", to: "a fim de" },
    { from: "texto,outro", to: "texto, outro" },
  ];
  assert.equal(applyClariceSuggestions(text, suggestions).applied.length, 2);
  assert.equal(applyChunkSuggestions({ text, startOffset: 0 }, suggestions, () => {}).applied.length, 2);
  const result = applyClariceSuggestions("Veja example ponto com", [
    { from: " ponto ", to: "." }, { from: ".com", to: ". com" },
  ]);
  assert.equal(result.patched, "Veja example.com");
  assert.equal(result.skipped[0].reason, "whitespace_only");
});

test("avalia todas as ocorrências e preserva ambiguidade", () => {
  const text = "a,b e https://example.com/a,b";
  assert.equal(classifyClariceNoise("a,b", "a, b", text), "whitespace_only");
  assert.equal(applyClariceSuggestions("texto,outro e texto,outro", [
    { from: "texto,outro", to: "texto, outro" },
  ]).skipped[0].reason, "ambiguous");
});

test("recusa alterações estruturais mistas sem contexto também", () => {
  assert.equal(classifyClariceNoise("fim afim de  \nComeço", "fim a fim de\nComeço"), "whitespace_only");
  assert.equal(classifyClariceNoise("  - item afim de", "- item a fim de"), "whitespace_only");
});
