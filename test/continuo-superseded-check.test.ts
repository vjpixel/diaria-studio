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

  // #6938: a cauda de continuação (`Closes #10 e #11`) permitia até 20 chars
  // soltos ANTES DE CADA número da cauda, o suficiente pra engolir uma
  // REFERÊNCIA de contexto no mesmo estilo de frase usado neste repo — a
  // cauda só avança para um 2º/3º número com conjunção EXPLÍCITA logo em
  // seguida, nunca por proximidade solta (o 1º número continua podendo
  // estar a até 20 chars do verbo, ver "não extrai nada..." acima).
  it("#6938: 'Closes #N — regression of #M' extrai só a issue colada ao verbo", () => {
    assert.deepEqual(extractClosingIssueNumbers("Closes #6935 — regression of #6930"), [6935]);
  });

  it("#6938: '#N (see #M)' extrai só a issue colada ao verbo", () => {
    assert.deepEqual(extractClosingIssueNumbers("Closes #6920 (see #6919)"), [6920]);
  });

  it("#6938: menção solta em frase separada não conta como fechamento", () => {
    assert.deepEqual(
      extractClosingIssueNumbers("Fixes the parser. Closes #1. Related: #2"),
      [1],
    );
  });

  it("#6938: conjunção explícita continua funcionando (não é regressão do fix)", () => {
    assert.deepEqual(extractClosingIssueNumbers("Closes #10, #11"), [10, 11]);
    assert.deepEqual(extractClosingIssueNumbers("Closes #10 and #11"), [10, 11]);
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
