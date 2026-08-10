/**
 * test/plan-issues-normalize.test.ts (#4860)
 *
 * Testa o helper compartilhado `normalizeIssues` (promovido de
 * `render-overnight-timeline.ts`, #4817) isoladamente do resto do módulo de
 * timeline — cobre os dois shapes de `plan.issues` (array/dict) e os casos
 * degenerados (ausente, vazio, malformado).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeIssues } from "../scripts/lib/plan-issues-normalize.ts";

interface Issue {
  number: number;
  status?: string;
}

describe("normalizeIssues", () => {
  it("array (shape overnight) passa através sem alteração", () => {
    const plan = { issues: [{ number: 9999, status: "mergeada" }] };
    const issues = normalizeIssues<Issue>(plan);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 9999);
    assert.equal(issues[0].status, "mergeada");
  });

  it("dict (shape develop) vira array — número explícito preservado", () => {
    const plan = {
      issues: {
        "4800": { number: 4800, status: "mergeada" },
      },
    };
    const issues = normalizeIssues<Issue>(plan);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 4800);
    assert.equal(issues[0].status, "mergeada");
  });

  it("dict sem campo `number` explícito deriva o número da chave", () => {
    const plan = {
      issues: {
        "4800": { status: "mergeada" },
      },
    };
    const issues = normalizeIssues<Issue>(plan);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 4800);
  });

  it("dict com múltiplas entradas: preserva todas", () => {
    const plan = {
      issues: {
        "4800": { status: "mergeada" },
        "4783": { status: "pulada" },
      },
    };
    const issues = normalizeIssues<Issue>(plan);
    assert.equal(issues.length, 2);
    const byNumber = new Map(issues.map((i) => [i.number, i.status]));
    assert.equal(byNumber.get(4800), "mergeada");
    assert.equal(byNumber.get(4783), "pulada");
  });

  it("dict vazio retorna array vazio", () => {
    assert.deepEqual(normalizeIssues<Issue>({ issues: {} }), []);
  });

  it("issues ausente retorna array vazio", () => {
    assert.deepEqual(normalizeIssues<Issue>({}), []);
  });

  it("plan null/undefined retorna array vazio, nunca lança", () => {
    assert.deepEqual(normalizeIssues<Issue>(null), []);
    assert.deepEqual(normalizeIssues<Issue>(undefined), []);
  });

  it("issues com valor não-objeto/não-array (malformado) retorna array vazio", () => {
    assert.deepEqual(normalizeIssues<Issue>({ issues: "not-an-object" as unknown as Issue[] }), []);
    assert.deepEqual(normalizeIssues<Issue>({ issues: null }), []);
  });
});
