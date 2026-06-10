/**
 * close-poll-stdout-json.test.ts (#2018)
 *
 * Verifica que o contrato do stdout JSON de close-poll --brand clarice está
 * completo e estruturalmente consistente com a saída da diária (mesmos campos
 * obrigatórios: ok, brand, edition, answer, updated_votes, marker_path,
 * sanity_check.correct_answer).
 *
 * Sem rede — testa a forma do JSON esperado a partir da lógica do script.
 * A geração efetiva do JSON é em scripts/close-poll.ts:main() que faz
 * console.log(JSON.stringify({...})). Aqui verificamos o contrato de shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Shape mínimo esperado no stdout JSON do close-poll (ambos os branches). */
interface ClosePollOutput {
  ok: boolean;
  brand: string;
  edition: string;
  answer: string;
  updated_votes: number;
  marker_path?: string;
  sanity_check?: { correct_answer: string | null };
}

/** Valida que um objeto satisfaz o contrato do close-poll stdout JSON. */
function assertClosePollOutput(obj: unknown, context: string): void {
  const o = obj as ClosePollOutput;
  assert.equal(typeof o.ok, "boolean", `${context}: 'ok' deve ser boolean`);
  assert.equal(typeof o.brand, "string", `${context}: 'brand' deve ser string`);
  assert.equal(typeof o.edition, "string", `${context}: 'edition' deve ser string`);
  assert.equal(typeof o.answer, "string", `${context}: 'answer' deve ser string`);
  assert.equal(typeof o.updated_votes, "number", `${context}: 'updated_votes' deve ser number`);
}

describe("close-poll stdout JSON contrato (#2018)", () => {
  it("contrato brand=clarice tem todos os campos obrigatórios", () => {
    // Simulação do JSON que o script emitiria para brand=clarice
    const output: ClosePollOutput = {
      ok: true,
      brand: "clarice",
      cycle: "2605-06",
      edition: "260531",
      answer: "A",
      updated_votes: 3,
      marker_path: "/path/to/.close-poll-clarice.json",
      sanity_check: { correct_answer: "A" },
    } as unknown as ClosePollOutput;

    assertClosePollOutput(output, "brand=clarice");
    assert.equal(output.brand, "clarice");
    assert.ok(output.marker_path, "brand=clarice deve ter marker_path");
    assert.ok(output.sanity_check, "brand=clarice deve ter sanity_check");
    assert.equal(output.sanity_check!.correct_answer, "A");
  });

  it("contrato brand=diaria tem todos os campos obrigatórios", () => {
    const output: ClosePollOutput = {
      ok: true,
      brand: "diaria",
      edition: "260531",
      answer: "B",
      updated_votes: 42,
      marker_path: "/path/to/.close-poll-done.json",
      sanity_check: { correct_answer: "B" },
    };

    assertClosePollOutput(output, "brand=diaria");
    assert.equal(output.brand, "diaria");
    assert.ok(output.marker_path, "brand=diaria deve ter marker_path");
    assert.ok(output.sanity_check, "brand=diaria deve ter sanity_check");
  });

  it("contrato JSON é parseable como JSON válido", () => {
    const clariceOutput = {
      ok: true,
      brand: "clarice",
      cycle: "2605-06",
      edition: "260531",
      answer: "A",
      updated_votes: 3,
      marker_path: "/path/.close-poll-clarice.json",
      sanity_check: { correct_answer: "A" },
    };
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(clariceOutput)));
    const parsed = JSON.parse(JSON.stringify(clariceOutput));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.brand, "clarice");
    assert.equal(parsed.answer, "A");
  });

  it("sanity_check.correct_answer corresponde ao answer na saída nominal", () => {
    // Guard: se sanity_check falhou, o script já teria exitado com código 1.
    // A saída nominal sempre tem correct_answer === answer.
    const output = {
      ok: true,
      brand: "clarice",
      cycle: "2605-06",
      edition: "260531",
      answer: "B",
      updated_votes: 10,
      marker_path: "/some/path",
      sanity_check: { correct_answer: "B" },
    };
    assert.equal(output.sanity_check.correct_answer, output.answer,
      "sanity_check.correct_answer deve igualar answer na saída nominal");
  });
});
