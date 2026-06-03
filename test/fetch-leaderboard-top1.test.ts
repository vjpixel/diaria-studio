/**
 * fetch-leaderboard-top1.test.ts (#1753)
 *
 * Regressão pro bug "Vencedores do mês aparece em toda edição". O bloco só deve
 * aparecer na 1ª edição do mês e anunciar o mês ANTERIOR (que acabou de fechar).
 *
 * Cobre as duas funções puras que sustentam a regra:
 *   - previousMonthSlug: período da edição → mês anterior (com virada de ano).
 *   - isFirstEditionOfMonth: detecta se há edição publicada anterior no mesmo mês.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  previousMonthSlug,
  isFirstEditionOfMonth,
} from "../scripts/fetch-leaderboard-top1.ts";

describe("previousMonthSlug (#1753)", () => {
  it("mês comum → mês anterior do mesmo ano", () => {
    assert.equal(previousMonthSlug("2026-06"), "2026-05");
    assert.equal(previousMonthSlug("2026-12"), "2026-11");
  });

  it("janeiro → dezembro do ano anterior", () => {
    assert.equal(previousMonthSlug("2026-01"), "2025-12");
  });

  it("zero-pad preservado", () => {
    assert.equal(previousMonthSlug("2026-10"), "2026-09");
    assert.equal(previousMonthSlug("2026-03"), "2026-02");
  });

  it("input malformado → retorna o próprio slug (fail-open)", () => {
    assert.equal(previousMonthSlug("nope"), "nope");
    assert.equal(previousMonthSlug(""), "");
  });
});

describe("isFirstEditionOfMonth (#1753)", () => {
  it("1ª do mês quando não há edição anterior no mesmo ano-mês", () => {
    // 260601 com histórico só de maio → é a 1ª de junho.
    assert.equal(
      isFirstEditionOfMonth("260601", [
        "2026-05-30T09:00:00.000Z",
        "2026-05-31T09:00:00.000Z",
      ]),
      true,
    );
  });

  it("NÃO é 1ª quando existe edição publicada anterior no mesmo mês", () => {
    // 260603 com 06-01 e 06-02 publicadas → não é a 1ª de junho. (Caso do bug.)
    assert.equal(
      isFirstEditionOfMonth("260603", [
        "2026-06-01T09:00:00.000Z",
        "2026-06-02T09:00:00.000Z",
      ]),
      false,
    );
  });

  it("a própria edição (mesma data) não conta contra si — comparação estrita", () => {
    // Resume/re-run: 260601 já presente no arquivo não deve suprimir o bloco.
    assert.equal(
      isFirstEditionOfMonth("260601", ["2026-06-01T09:00:00.000Z"]),
      true,
    );
  });

  it("edição posterior no mesmo mês não conta (só anteriores suprimem)", () => {
    // 260601 com uma 06-02 no arquivo (cenário improvável, mas a regra é
    // 'existe anterior?') → ainda é 1ª.
    assert.equal(
      isFirstEditionOfMonth("260601", ["2026-06-02T09:00:00.000Z"]),
      true,
    );
  });

  it("edição de outro mês não interfere", () => {
    assert.equal(
      isFirstEditionOfMonth("260601", [
        "2026-04-15T09:00:00.000Z",
        "2026-05-20T09:00:00.000Z",
      ]),
      true,
    );
  });

  it("virada de ano: 1ª de janeiro ignora dezembro do ano anterior", () => {
    assert.equal(
      isFirstEditionOfMonth("260101", ["2025-12-31T09:00:00.000Z"]),
      true,
    );
  });

  it("lista vazia → 1ª do mês (fail-open: mostra o bloco)", () => {
    assert.equal(isFirstEditionOfMonth("260603", []), true);
  });

  it("entradas inválidas são ignoradas com segurança", () => {
    assert.equal(
      isFirstEditionOfMonth("260603", [
        "" as unknown as string,
        "x",
        "2026-06-01T09:00:00.000Z",
      ]),
      false,
    );
  });

  it("edição malformada → true (fail-open, não suprime)", () => {
    assert.equal(
      isFirstEditionOfMonth("invalid", ["2026-06-01T09:00:00.000Z"]),
      true,
    );
  });
});
