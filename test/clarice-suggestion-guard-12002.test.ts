import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClariceNoise } from "../scripts/lib/clarice-suggestion-guard.ts";
import { applyClariceSuggestions } from "../scripts/clarice-apply.ts";

const WORDS = [
  "esse", "essa", "esses", "essas", "este", "esta", "estes", "estas",
  "aquele", "aquela", "aqueles", "aquelas",
  "pode", "podem", "deve", "devem", "vamos", "precisa", "precisam",
];

test("#12002: demonstrativos e verbos após ponto aceitam correção de espaço nos dois sentidos", () => {
  for (const word of WORDS) {
    const from = `O modelo funciona.${word} funcionar melhor`;
    const to = `O modelo funciona. ${word} funcionar melhor`;
    assert.equal(classifyClariceNoise(from, to), null, word);
    assert.equal(classifyClariceNoise(to, from), null, word);
  }
});

test("#12002: apply corrige os exemplos reais sem descartar a sugestão", () => {
  for (const [from, to] of [
    ["funciona.esse", "funciona. esse"],
    ["modelo.essa", "modelo. essa"],
    ["ano.este", "ano. este"],
  ]) {
    const result = applyClariceSuggestions(`texto ${from} fim`, [{ from, to }]);
    assert.equal(result.patched, `texto ${to} fim`);
    assert.equal(result.applied.length, 1);
    assert.deepEqual(result.skipped, []);
  }
});
