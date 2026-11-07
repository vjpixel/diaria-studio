import { test } from "node:test";
import assert from "node:assert/strict";
import { filterClariceSuggestions } from "../scripts/lib/clarice-suggestion-guard.ts";

// #12362: a proteção factual do Stage 4 (#12329) casava `from` como substring
// de qualquer `suggested_fix` aplicado, sem fronteira de palavra nem token
// factual. Com um autofix de frase longa, toda sugestão curta e comum caía.
const protection = {
  correctedTexts: ["A redução foi de 40% em 2026, segundo a empresa OpenAI."],
  protectConditional: false,
};

test("from curto/comum contido na frase corrigida não é protegido", () => {
  const crase = { from: "a", to: "à" };
  const plural = { from: "empresa", to: "empresas" };
  const pedaco = { from: "redu", to: "Redu" };
  const r = filterClariceSuggestions([crase, plural, pedaco], protection);
  assert.deepEqual(r.kept, [crase, plural, pedaco]);
  assert.deepEqual(r.dropped, []);
});

test("from com número, nome próprio ou boa parte do trecho continua protegido", () => {
  const numero = { from: "40%", to: "50%" };
  const ano = { from: "em 2026", to: "em 2025" };
  const nome = { from: "empresa OpenAI", to: "empresa Anthropic" };
  const grande = { from: "A redução foi de 40% em 2026, segundo a empresa OpenAI.", to: "x" };
  const r = filterClariceSuggestions([numero, ano, nome, grande], protection);
  assert.deepEqual(r.kept, []);
  assert.ok(r.dropped.every((d) => d.reason === "fact_check_protected"));
  // Sem número nem nome: protegido só se cobre metade do trecho corrigido.
  const curto = { correctedTexts: ["segundo a empresa"], protectConditional: false };
  const metade = { from: "segundo a", to: "conforme a" };
  assert.equal(filterClariceSuggestions([metade], curto).dropped[0]?.reason, "fact_check_protected");
});

test("maiúscula de início de frase não conta como nome próprio", () => {
  const inicio = { from: "A redução", to: "À redução" };
  assert.deepEqual(filterClariceSuggestions([inicio], protection).kept, [inicio]);
});
