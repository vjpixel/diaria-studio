import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeExpectedEnvioCycle } from "../scripts/lib/clarice-envio-cycle.ts";

describe("computeExpectedEnvioCycle", () => {
  it("2026-08-11 (BRT) => 2607-08 (conteúdo julho, envio agosto)", () => {
    assert.equal(computeExpectedEnvioCycle(new Date("2026-08-11T22:00:00Z")), "2607-08");
  });

  it("início do mês (2026-09-01) já é o novo ciclo — 2608-09", () => {
    assert.equal(computeExpectedEnvioCycle(new Date("2026-09-01T13:00:00Z")), "2608-09");
  });

  it("rollover de ano: janeiro => conteúdo é dezembro do ano ANTERIOR", () => {
    assert.equal(computeExpectedEnvioCycle(new Date("2027-01-05T13:00:00Z")), "2612-01");
  });

  it("fronteira BRT: 2026-08-31T23:30-03:00 (madrugada UTC de 09/01) ainda é agosto em BRT", () => {
    // 2026-09-01T02:30:00Z = 2026-08-31T23:30:00-03:00 (BRT) — ainda dia 31 de agosto.
    assert.equal(computeExpectedEnvioCycle(new Date("2026-09-01T02:30:00Z")), "2607-08");
  });

  it("fronteira BRT: 2026-09-01T03:00:00Z = 2026-09-01T00:00:00-03:00 — já virou setembro em BRT", () => {
    assert.equal(computeExpectedEnvioCycle(new Date("2026-09-01T03:00:00Z")), "2608-09");
  });

  it("todos os 12 meses produzem um ciclo válido (sem lançar)", () => {
    for (let m = 1; m <= 12; m++) {
      const iso = `2026-${String(m).padStart(2, "0")}-15T15:00:00Z`;
      assert.doesNotThrow(() => computeExpectedEnvioCycle(new Date(iso)));
    }
  });
});
