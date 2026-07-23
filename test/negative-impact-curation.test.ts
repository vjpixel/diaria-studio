/**
 * test/negative-impact-curation.test.ts (#3916, #3918)
 *
 * Testes de regressão para getNegativeImpactDiscoveryQueries — garante que
 * Stage 1 sempre injeta ≥1 query dedicada ao ângulo crítico/impacto-negativo
 * da IA, independente de BRAVE_API_KEY (Path A vs Path B). Mesmo esquema de
 * testes de getHowToDiscoveryQueries (#2278, test/use-melhor-curation.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getNegativeImpactDiscoveryQueries,
  NEGATIVE_IMPACT_DISCOVERY_TOPICS,
} from "../scripts/lib/negative-impact-curation.ts";

describe("getNegativeImpactDiscoveryQueries (#3916, #3918)", () => {
  it("retorna 1 query por default (+1 tema fixo)", () => {
    const queries = getNegativeImpactDiscoveryQueries(260722);
    assert.equal(queries.length, 1);
  });

  it("retorna count customizado", () => {
    const queries = getNegativeImpactDiscoveryQueries(260722, 3);
    assert.equal(queries.length, 3);
  });

  it("retorna strings não-vazias", () => {
    const queries = getNegativeImpactDiscoveryQueries(260722, NEGATIVE_IMPACT_DISCOVERY_TOPICS.length);
    for (const q of queries) {
      assert.ok(q.length > 10, `query muito curta: ${q}`);
    }
  });

  it("edições diferentes rotacionam queries (variedade)", () => {
    const q1 = getNegativeImpactDiscoveryQueries(260722);
    const q2 = getNegativeImpactDiscoveryQueries(260723);
    assert.notDeepEqual(q1, q2, "edições consecutivas devem ter queries distintas");
  });

  it("rotação é determinística (mesma edição = mesmos resultados)", () => {
    const q1 = getNegativeImpactDiscoveryQueries(260722);
    const q2 = getNegativeImpactDiscoveryQueries(260722);
    assert.deepEqual(q1, q2, "saída é determinística para a mesma edição");
  });

  it("usa somente queries do NEGATIVE_IMPACT_DISCOVERY_TOPICS", () => {
    const queries = getNegativeImpactDiscoveryQueries(260722, NEGATIVE_IMPACT_DISCOVERY_TOPICS.length);
    for (const q of queries) {
      assert.ok(NEGATIVE_IMPACT_DISCOVERY_TOPICS.includes(q), `query desconhecida: ${q}`);
    }
  });

  it("pool tem 10 temas distintos", () => {
    assert.equal(NEGATIVE_IMPACT_DISCOVERY_TOPICS.length, 10);
    const unique = new Set(NEGATIVE_IMPACT_DISCOVERY_TOPICS);
    assert.equal(unique.size, 10, "todos os temas devem ser únicos");
  });

  it("count=0 retorna vazio", () => {
    const queries = getNegativeImpactDiscoveryQueries(260722, 0);
    assert.deepEqual(queries, []);
  });

  it("count maior que o pool não retorna duplicatas (clamp)", () => {
    const queries = getNegativeImpactDiscoveryQueries(260722, 25);
    const unique = new Set(queries);
    assert.equal(queries.length, unique.size, "nenhuma query deve se repetir");
    assert.ok(queries.length <= NEGATIVE_IMPACT_DISCOVERY_TOPICS.length, "resultado clamped ao tamanho do pool");
  });

  it("NaN guard: editionNum não-finito cai no slot 0 sem lançar (#2305-espelho)", () => {
    let thrown = false;
    let result: string[] = [];
    try {
      result = getNegativeImpactDiscoveryQueries(NaN, 1);
    } catch {
      thrown = true;
    }
    assert.equal(thrown, false, "getNegativeImpactDiscoveryQueries não deve lançar exceção com NaN");
    assert.deepEqual(result, getNegativeImpactDiscoveryQueries(0, 1));
  });
});
