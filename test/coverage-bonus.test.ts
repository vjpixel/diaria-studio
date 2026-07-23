import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coverageBonus,
  COVERAGE_BONUS_PER_SOURCE,
} from "../scripts/lib/coverage-bonus.ts";

describe("coverageBonus (#3920)", () => {
  it("+5 por fonte extra, sem teto (decisão do editor)", () => {
    assert.equal(coverageBonus(0), 0);
    assert.equal(coverageBonus(1), 5);
    assert.equal(coverageBonus(2), 10);
    assert.equal(coverageBonus(3), 15);
    assert.equal(coverageBonus(6), 30);
    assert.equal(coverageBonus(10), 50);
  });

  it("constante exportada é 5", () => {
    assert.equal(COVERAGE_BONUS_PER_SOURCE, 5);
  });

  it("valores <= 0 / NaN / Infinity → 0 (defensivo)", () => {
    assert.equal(coverageBonus(-1), 0);
    assert.equal(coverageBonus(-99), 0);
    assert.equal(coverageBonus(NaN), 0);
    assert.equal(coverageBonus(Infinity), 0);
  });

  it("fracionário é truncado (floor)", () => {
    assert.equal(coverageBonus(2.9), 10);
    assert.equal(coverageBonus(1.1), 5);
  });

  it("cap opcional limita o bônus quando fornecido", () => {
    assert.equal(coverageBonus(6, 15), 15);
    assert.equal(coverageBonus(2, 15), 10);
    assert.equal(coverageBonus(3, 15), 15);
    // sem cap default = Infinity
    assert.equal(coverageBonus(6), 30);
  });
});
