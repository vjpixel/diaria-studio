import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractClosingIssueNumbers,
  computeSupersededVerdict,
} from "../scripts/lib/continuo-superseded-check.ts";

describe("extractClosingIssueNumbers (#6926)", () => {
  it("extrai números de issue de palavras-chave em inglês", () => {
    assert.deepEqual(extractClosingIssueNumbers("Closes #10"), [10]);
    assert.deepEqual(extractClosingIssueNumbers("Fixes #10\n\nResolves #11"), [10, 11]);
  });

  it("suporta múltiplas issues no mesmo verbo", () => {
    assert.deepEqual(extractClosingIssueNumbers("Closes #10 e #11"), [10, 11]);
  });

  it("não extrai nada de corpo em português (escopo: só inglês, ver #6920)", () => {
    assert.deepEqual(extractClosingIssueNumbers("Fecha #10"), []);
  });

  it("corpo sem referência nenhuma → array vazio", () => {
    assert.deepEqual(extractClosingIssueNumbers("Refactor sem issue associada."), []);
  });

  it("body não-string → array vazio, nunca lança", () => {
    assert.deepEqual(extractClosingIssueNumbers(undefined), []);
    assert.deepEqual(extractClosingIssueNumbers(null), []);
  });
});

describe("computeSupersededVerdict (#6926/#6238)", () => {
  it("nenhuma issue referenciada → nunca superseded, portão não se aplica", () => {
    const result = computeSupersededVerdict([], new Map());
    assert.equal(result.superseded, false);
  });

  it("todas as issues referenciadas já CLOSED → superseded", () => {
    const result = computeSupersededVerdict([10, 11], new Map([[10, "CLOSED"], [11, "CLOSED"]]));
    assert.equal(result.superseded, true);
  });

  it("uma issue ainda OPEN entre várias → não superseded", () => {
    const result = computeSupersededVerdict([10, 11], new Map([[10, "CLOSED"], [11, "OPEN"]]));
    assert.equal(result.superseded, false);
  });

  it("issue referenciada sem entrada no mapa de estados (desconhecido) → não superseded (fail-closed)", () => {
    const result = computeSupersededVerdict([10], new Map());
    assert.equal(result.superseded, false);
  });

  it("única issue referenciada, CLOSED → superseded", () => {
    const result = computeSupersededVerdict([10], new Map([[10, "CLOSED"]]));
    assert.equal(result.superseded, true);
  });
});
