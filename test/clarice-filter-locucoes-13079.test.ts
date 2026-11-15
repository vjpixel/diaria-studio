/**
 * Regressão #13079 — o guard de mudança de sentido do #13052 descartava
 * locuções fixas ("no mínimo" → "pelo menos") como `degree_change` e
 * "3 mil" → "3.000" como `identifier_swap`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyClariceMeaningChange,
  filterClariceSuggestions,
} from "../scripts/lib/clarice-suggestion-guard.ts";

test("locuções fixas e N mil passam (tabela da #13079)", () => {
  const cases = [
    { from: "no mínimo", to: "pelo menos" },
    { from: "a não ser que", to: "a menos que" },
    { from: "a maioria dos usuários", to: "a maior parte dos usuários" },
    { from: "3 mil", to: "3.000" },
    { from: "3 mil usuários", to: "3.000 usuários" },
    { from: "1,5 mil", to: "1.500" },
    { from: "no minimo", to: "ao menos" },
    { from: "uma hora extra.", to: "uma hora a mais." },
    { from: "Fora isso,", to: "No mais," },
  ];
  for (const s of cases) {
    assert.equal(classifyClariceMeaningChange(s.from, s.to), null, `${s.from} → ${s.to}`);
  }
});

test("o caso-alvo do #13052 e superlativos reais seguem descartados", () => {
  const degree = [
    { from: "foi pior", to: "foi o pior" },
    { from: "mais rápida", to: "a mais rápida" },
    { from: "ficou maior", to: "ficou a maior" },
    { from: "pelo menos foi pior", to: "pelo menos foi o pior" },
  ];
  for (const s of degree) {
    assert.equal(classifyClariceMeaningChange(s.from, s.to), "degree_change", `${s.from} → ${s.to}`);
  }
  const swap = [
    { from: "3 mil", to: "4.000" },
    { from: "3 mil", to: "30.000" },
  ];
  for (const s of swap) {
    assert.equal(classifyClariceMeaningChange(s.from, s.to), "identifier_swap", `${s.from} → ${s.to}`);
  }
});

test("filterClariceSuggestions mantém as locuções e descarta foi pior → foi o pior", () => {
  const legit = [
    { from: "no mínimo", to: "pelo menos" },
    { from: "a não ser que", to: "a menos que" },
    { from: "a maioria dos usuários", to: "a maior parte dos usuários" },
    { from: "3 mil", to: "3.000" },
  ];
  const degree = { from: "foi pior", to: "foi o pior" };
  const r = filterClariceSuggestions([...legit, degree]);
  assert.deepEqual(r.kept, legit);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["degree_change"]);
});
