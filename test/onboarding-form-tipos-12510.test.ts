/**
 * test/onboarding-form-tipos-12510.test.ts (#12510)
 *
 * `ChoiceQuestion` era uma interface só para `select` e `checkbox`: compilava
 * `{kind:"select", maxChoices:3, exclusiveOption:"x"}` e um `checkbox` com
 * `optionsFrom`, e `parseFormSubmission` ignorava esses campos em silêncio.
 * `shownWhen` aceitava nenhum gate (a pergunta nunca escondia) ou os dois
 * (combinavam em E sem ninguém documentar).
 *
 * Agora: union discriminada (`SelectQuestion | CheckboxQuestion`) e
 * `ShownWhen = {anyOf} | {minChecked}`. As asserções de TIPO (`@ts-expect-error`)
 * só falham no `tsc -p tsconfig.test.json` (job "Typecheck ratchet"): sem a
 * union, cada `@ts-expect-error` vira "Unused '@ts-expect-error' directive".
 * As de runtime travam `validateFormQuestions` para lista montada fora do TS.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FORM_QUESTIONS,
  validateFormQuestions,
  type CheckboxQuestion,
  type FormQuestion,
  type SelectQuestion,
  type ShownWhen,
} from "../scripts/lib/onboarding-form-contract.ts";

describe("#12510 tipos das perguntas", () => {
  it("campos de um kind no outro não compilam", () => {
    // @ts-expect-error — escolha única não tem limite de caixas
    const a: SelectQuestion = { id: "a", label: "A", kind: "select", options: ["x"], maxChoices: 3 };
    // @ts-expect-error — escolha única não tem opção exclusiva
    const b: SelectQuestion = { id: "b", label: "B", kind: "select", options: ["x"], exclusiveOption: "x" };
    // @ts-expect-error — caixa não restringe opções a outra pergunta
    const c: CheckboxQuestion = { id: "c", label: "C", kind: "checkbox", options: ["x"], optionsFrom: "a" };
    // @ts-expect-error — pergunta aberta não tem opções
    const d: FormQuestion = { id: "d", label: "D", kind: "text", options: ["x"] };
    // @ts-expect-error — escolha não tem placeholder
    const e: FormQuestion = { id: "e", label: "E", kind: "checkbox", options: ["x"], placeholder: "?" };
    assert.ok([a, b, c, d, e].length === 5);
  });

  it("shownWhen exige exatamente um gate", () => {
    // @ts-expect-error — sem gate nenhum
    const none: ShownWhen = { questionId: "q" };
    // @ts-expect-error — os dois gates juntos
    const both: ShownWhen = { questionId: "q", anyOf: ["x"], minChecked: 2 };
    const any: ShownWhen = { questionId: "q", anyOf: ["x"] };
    const min: ShownWhen = { questionId: "q", minChecked: 2 };
    assert.ok([none, both, any, min].length === 4);
  });

  it("as perguntas reais seguem válidas e tipadas pela union", () => {
    assert.deepEqual(validateFormQuestions(FORM_QUESTIONS), []);
    const escolha = FORM_QUESTIONS.find((q) => q.id === "produto_escolha");
    assert.equal(escolha?.kind, "select");
    if (escolha?.kind === "select") assert.equal(escolha.optionsFrom, "produto_formato");
  });

  it("runtime: lista montada fora do TS com campo trocado ou gate duplo é recusada", () => {
    const base = [{ id: "fmt", label: "F", kind: "checkbox", options: ["x", "y"] }];
    const bad = [
      ...base,
      { id: "s", label: "S", kind: "select", options: ["x"], maxChoices: 3, exclusiveOption: "x" },
      { id: "c", label: "C", kind: "checkbox", options: ["x"], optionsFrom: "fmt" },
      { id: "w", label: "W", kind: "select", options: ["x"], shownWhen: { questionId: "fmt", anyOf: ["x"], minChecked: 2 } },
      { id: "n", label: "N", kind: "select", options: ["x"], shownWhen: { questionId: "fmt" } },
    ] as unknown as FormQuestion[];
    const errs = validateFormQuestions(bad).join("\n");
    assert.match(errs, /s: maxChoices só em caixa/);
    assert.match(errs, /s: exclusiveOption só em caixa/);
    assert.match(errs, /c: optionsFrom só em escolha única/);
    assert.match(errs, /w: shownWhen com anyOf e minChecked juntos/);
    assert.match(errs, /n: shownWhen sem anyOf nem minChecked/);
  });
});
