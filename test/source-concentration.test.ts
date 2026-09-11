/**
 * test/source-concentration.test.ts (#7977)
 *
 * Cobre scripts/lib/source-concentration.ts — índice Herfindahl-Hirschman
 * puro sobre uma lista de domínios.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDomainConcentration } from "../scripts/lib/source-concentration.ts";

describe("computeDomainConcentration (#7977)", () => {
  it("lista vazia: HHI 0, sem domínio top", () => {
    const r = computeDomainConcentration([]);
    assert.equal(r.hhi, 0);
    assert.equal(r.top_domain, null);
    assert.equal(r.domain_count, 0);
  });

  it("1 domínio sozinho: HHI máximo (10000), share 100%", () => {
    const r = computeDomainConcentration(["a.com", "a.com", "a.com"]);
    assert.equal(r.hhi, 10000);
    assert.equal(r.top_domain, "a.com");
    assert.equal(r.top_domain_share, 1);
    assert.equal(r.domain_count, 1);
  });

  it("2 domínios em partes iguais: HHI 5000", () => {
    const r = computeDomainConcentration(["a.com", "a.com", "b.com", "b.com"]);
    assert.equal(r.hhi, 5000);
    assert.equal(r.domain_count, 2);
  });

  it("4 domínios em partes iguais: HHI 2500 (limiar convencional de 'altamente concentrado')", () => {
    const r = computeDomainConcentration(["a.com", "b.com", "c.com", "d.com"]);
    assert.equal(r.hhi, 2500);
  });

  it("valores null/vazios são ignorados, não contam como domínio", () => {
    const r = computeDomainConcentration(["a.com", null, "", "a.com"]);
    assert.equal(r.domain_count, 1);
    assert.equal(r.hhi, 10000);
  });

  it("top_domain reflete o de maior participação, não o primeiro da lista", () => {
    const r = computeDomainConcentration(["a.com", "b.com", "b.com", "b.com"]);
    assert.equal(r.top_domain, "b.com");
    assert.equal(r.top_domain_share, 0.75);
  });
});
