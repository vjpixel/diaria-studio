/**
 * test/doi-form-guard-7723.test.ts (#7723)
 *
 * Trava o guard que impede `KIT_DOI_FORM_ID` de apontar para um form de
 * SISTEMA do Kit — o estado real que fez o double opt-in não enviar nada
 * entre 26/08 e 09/09/2026, sem erro, sem log, sem ninguém notar.
 *
 * O #6565 já cobria o id ausente. O caso que de fato aconteceu era o id
 * PRESENTE e inútil: `9839463` ("Newsletter site") é `format: null`, não tem
 * página de edição nem toggle "Send confirmation email". O vínculo respondia
 * `201` e nenhum e-mail saía.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verificarDoiForm,
  mensagemDoiFormInvalido,
  KIT_SYSTEM_FORM_IDS,
} from "../workers/poll/src/doi-form-guard-7723.ts";

test("id ausente ou vazio: veredito 'ausente' (comportamento do #6565, preservado)", () => {
  for (const v of [undefined, "", "   "]) {
    const r = verificarDoiForm(v);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "ausente");
    assert.equal(mensagemDoiFormInvalido(r), null, "ausência é caminho documentado, não anomalia — não loga");
  }
});

test("REGRESSÃO #7723: form de SISTEMA é recusado — é o estado que ficou 2 semanas em silêncio", () => {
  const r = verificarDoiForm("9839463"); // "Newsletter site", o valor que KIT_DOI_FORM_ID tinha
  assert.equal(r.ok, false, "form de sistema não pode habilitar DOI: nunca enviaria confirmação");
  assert.equal(r.ok === false && r.reason, "form-de-sistema");
});

test("o outro form de sistema conhecido também é recusado", () => {
  const r = verificarDoiForm("9870650"); // "Creator Network"
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "form-de-sistema");
});

test("designer form é aceito — é o que tem o toggle", () => {
  const r = verificarDoiForm("9897771"); // format: "sticky bar"
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.formId, "9897771");
});

test("espaços em volta não driblam o guard", () => {
  const r = verificarDoiForm("  9839463  ");
  assert.equal(r.ok, false, "trim antes de comparar — senão um espaço acidental reabre o bug");
  assert.equal(r.ok === false && r.reason, "form-de-sistema");
});

test("form de sistema LOGA alto — foi a ausência de sinal que escondeu o bug", () => {
  const msg = mensagemDoiFormInvalido(verificarDoiForm("9839463"));
  assert.ok(msg, "precisa produzir mensagem");
  assert.match(msg, /9839463/, "nomeia o id que está errado");
  assert.match(msg, /sistema/i, "diz o que há de errado com ele");
  assert.match(msg, /active/, "diz o que fez em vez de prender em inactive");
  assert.match(msg, /docs\/kit-doi-confirmation-copy\.md/, "aponta para onde está o procedimento");
});

test("veredito ok nunca produz mensagem de erro", () => {
  assert.equal(mensagemDoiFormInvalido(verificarDoiForm("9897771")), null);
});

test("a lista de forms de sistema não está vazia — guard vazio é guard inerte", () => {
  assert.ok(KIT_SYSTEM_FORM_IDS.length >= 2);
  assert.ok(KIT_SYSTEM_FORM_IDS.includes("9839463"), "o id que causou o bug precisa estar na lista");
});
