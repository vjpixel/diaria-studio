/**
 * Regressão #11867 — o guard de ruído do #11798 classificava como
 * `whitespace_only` qualquer sugestão cujos caracteres visíveis fossem iguais,
 * e assim recusava correções reais que só mexem em espaço no meio da linha
 * (`afim de`→`a fim de`, `Porque`→`Por que`...). O erro chegava ao leitor.
 * O ruído estrutural do #11798 (`\n\n` inserido, borda do trecho) continua
 * recusado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClariceNoise } from "../scripts/lib/clarice-suggestion-guard.ts";
import { applyClariceSuggestions } from "../scripts/clarice-apply.ts";
import { applyChunkSuggestions } from "../scripts/lib/clarice-chunk.ts";

// Os 5 pares da issue.
const PAIRS: Array<[string, string]> = [
  ["afim de", "a fim de"],
  ["Porque a IA", "Por que a IA"],
  ["se não", "senão"],
  ["a cerca de", "acerca de"],
  ["texto,outro", "texto, outro"],
];

test("#11867: correções que só mexem em espaço no meio da linha passam", () => {
  for (const [from, to] of PAIRS) {
    assert.equal(classifyClariceNoise(from, to), null, `${from} → ${to}`);
  }
  assert.equal(classifyClariceNoise("a  b", "a b"), null);
});

test("#11867: ruído estrutural de espaço continua recusado", () => {
  // \n\n inserido antes da palavra (formato da edição 261103)
  assert.equal(classifyClariceNoise("Palavra", "\n\nPalavra"), "whitespace_only");
  // parágrafo inserido no meio
  assert.equal(classifyClariceNoise("fim. Começo", "fim.\n\nComeço"), "whitespace_only");
  // parágrafos juntados
  assert.equal(classifyClariceNoise("fim.\n\nComeço", "fim. Começo"), "whitespace_only");
  // só borda do trecho / indentação / espaço antes da quebra (hard break)
  assert.equal(classifyClariceNoise("palavra", "palavra "), "whitespace_only");
  assert.equal(classifyClariceNoise("- item", "  - item"), "whitespace_only");
  assert.equal(classifyClariceNoise("fim  \nComeço", "fim\nComeço"), "whitespace_only");
});

const TEXT = [
  "Ele estudou afim de passar.",
  "",
  "Porque a IA erra tanto? Ninguém sabe.",
  "",
  "Falou a cerca de tudo, com texto,outro. Corra, se não perde o ônibus.",
].join("\n");

const SUGGESTIONS = [
  ...PAIRS.map(([from, to]) => ({ from, to, rule: "Ortografia" })),
  { from: "Falou", to: "\n\nFalou" }, // ruído #11798
];

const EXPECTED = PAIRS.reduce((t, [from, to]) => t.replace(from, to), TEXT);

test("#11867: clarice-apply aplica os 5 pares e recusa só o ruído", () => {
  const r = applyClariceSuggestions(TEXT, SUGGESTIONS);
  assert.deepEqual(
    r.applied.map((s) => s.from).sort(),
    PAIRS.map(([from]) => from).sort(),
  );
  assert.equal(r.patched, EXPECTED);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["whitespace_only"]);
});

test("#11867: caminho REST chunked aplica os mesmos pares", () => {
  const chunk = { text: TEXT, startOffset: 0, endOffset: TEXT.length, index: 0 };
  const r = applyChunkSuggestions(
    chunk as Parameters<typeof applyChunkSuggestions>[0],
    SUGGESTIONS,
    () => {},
  );
  assert.equal(r.text, EXPECTED);
  assert.equal(r.applied.length, PAIRS.length);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["whitespace_only"]);
});
