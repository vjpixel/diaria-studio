import { test } from "node:test";
import assert from "node:assert/strict";
import { filterClariceSuggestions } from "../scripts/lib/clarice-suggestion-guard.ts";

// #12399: depois do #12362 a maiúscula de início de frase deixou de contar como
// nome próprio, e o `suggested_fix` do fact-check costuma começar justamente
// pelo nome corrigido. A Clarice desfazendo esse nome caía em `kept`.
const prot = (text: string) => ({ correctedTexts: [text], protectConditional: false });

test("nome próprio na posição 0 do trecho corrigido é protegido", () => {
  const s = { from: "Anthropic", to: "Antropic" };
  const r = filterClariceSuggestions([s], prot("Anthropic lançou o modelo ontem."));
  assert.deepEqual(r.kept, []);
  assert.equal(r.dropped[0]?.reason, "fact_check_protected");
});

test("nome próprio abrindo frase depois de ponto é protegido", () => {
  const s = { from: "Microsoft", to: "Microsofit" };
  const r = filterClariceSuggestions([s], prot("O acordo saiu ontem. Microsoft anunciou a compra em março."));
  assert.equal(r.dropped[0]?.reason, "fact_check_protected");
});

test("maiúscula interna ou sigla conta como nome em qualquer posição", () => {
  const corrected = prot("xAI lançou o Grok, e o iPhone ganhou suporte.");
  for (const s of [{ from: "xAI", to: "XAI" }, { from: "iPhone", to: "Iphone" }]) {
    assert.equal(filterClariceSuggestions([s], corrected).dropped[0]?.reason, "fact_check_protected", s.from);
  }
});

test("palavra funcional que abre frase não conta como nome", () => {
  const corrected = prot("Segundo a empresa, o lançamento ficou para depois.");
  const s = { from: "Segundo", to: "Conforme" };
  assert.deepEqual(filterClariceSuggestions([s], corrected).kept, [s]);
});

test("substantivo comum que abre frase e segue igual em `to` não é protegido", () => {
  const corrected = prot("Empresas anunciaram cortes de pessoal na semana passada.");
  const s = { from: "Empresas anunciaram", to: "Empresas anunciaram," };
  assert.deepEqual(filterClariceSuggestions([s], corrected).kept, [s]);
});
