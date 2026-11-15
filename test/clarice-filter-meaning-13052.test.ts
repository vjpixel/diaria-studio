/**
 * Regressão #13052 — o filtro da Clarice deixava passar troca de nome de
 * modelo ("Gemini 4 Carbon" → "1.5 Flash-8B") e comparativo virando
 * superlativo ("foi pior" → "foi o pior"), pacote semanal 26w46.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyClariceMeaningChange,
  filterClariceSuggestions,
} from "../scripts/lib/clarice-suggestion-guard.ts";

test("troca de identificador de modelo é descartada (caso 26w46)", () => {
  const cases = [
    { from: "Gemini 4 Carbon", to: "Gemini 1.5 Flash-8B" },
    { from: "4 Carbon", to: "1.5 Flash-8B" },
    { from: "o Gemini 4 Carbon foi", to: "o 1.5 Flash-8B foi" },
    { from: "Gemini Pro", to: "Gemini Flash" },
    { from: "cresceu 30%", to: "cresceu 40%" },
    { from: "o modelo", to: "o modelo GPT-5" },
  ];
  for (const s of cases) {
    assert.equal(classifyClariceMeaningChange(s.from, s.to), "identifier_swap", `${s.from} → ${s.to}`);
  }
});

test("comparativo virando superlativo é descartado (caso 26w46)", () => {
  const cases = [
    { from: "foi pior", to: "foi o pior" },
    { from: "é melhor que", to: "é o melhor que" },
    { from: "ficou maior", to: "ficou a maior" },
    { from: "mais rápido", to: "o mais rápido" },
  ];
  for (const s of cases) {
    assert.equal(classifyClariceMeaningChange(s.from, s.to), "degree_change", `${s.from} → ${s.to}`);
  }
});

test("correções legítimas seguem passando", () => {
  const cases = [
    { from: "os resultado", to: "os resultados" },
    { from: "Antropic", to: "Anthropic" },
    { from: "Openai", to: "OpenAI" },
    { from: "GPT4", to: "GPT-4" },
    { from: "1000 usuários", to: "1.000 usuários" },
    { from: "3 empresas", to: "três empresas" },
    { from: "o pior resultado", to: "a pior colocação" },
    { from: "chegou a maior marca", to: "chegou à maior marca" },
    { from: "Inteligencia", to: "Inteligência" },
    { from: "o Gemini 4 Carbon", to: "do Gemini 4 Carbon" },
  ];
  for (const s of cases) {
    assert.equal(classifyClariceMeaningChange(s.from, s.to), null, `${s.from} → ${s.to}`);
  }
});

test("filterClariceSuggestions descarta as duas sugestões do 26w46 e mantém a real", () => {
  const swap = { from: "Gemini 4 Carbon", to: "1.5 Flash-8B" };
  const degree = { from: "foi pior", to: "foi o pior" };
  const real = { from: "os resultado", to: "os resultados" };
  const r = filterClariceSuggestions([swap, degree, real]);
  assert.deepEqual(r.kept, [real]);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["identifier_swap", "degree_change"]);
});

test("filtro também recusa no modo com proteção do Stage 4", () => {
  const r = filterClariceSuggestions([{ from: "foi pior", to: "foi o pior" }], {
    correctedTexts: [],
    protectConditional: true,
  });
  assert.equal(r.dropped[0]?.reason, "degree_change");
});
