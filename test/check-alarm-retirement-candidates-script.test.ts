/**
 * test/check-alarm-retirement-candidates-script.test.ts (#7049)
 *
 * Cobre `parseGhApiIssueRows` (`scripts/check-alarm-retirement-candidates.ts`)
 * — a transformação PURA (JSON.parse + filtro de pull_request + mapeamento +
 * normalização de `state_reason`) extraída do `spawnSync` pelo fleet review
 * da PR #7049 (finding P1): o bug de casing corrigido no self-review
 * original desta feature (#6798) — `state_reason` minúsculo da REST
 * ("not_planned") não casava com o `"NOT_PLANNED"` maiúsculo que a lógica
 * pura downstream espera — não tinha NENHUM teste cobrindo este caminho.
 * Fixture no formato REAL da REST `GET /repos/{owner}/{repo}/issues`
 * (`state_reason` minúsculo, snake_case) — não o formato já-normalizado que
 * `test/alarm-retirement-candidates.test.ts` usa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGhApiIssueRows, type GhApiIssueRow } from "../scripts/check-alarm-retirement-candidates.ts";

function ghRow(overrides: Partial<GhApiIssueRow> = {}): GhApiIssueRow {
  return {
    number: 1,
    title: "achado de exemplo",
    body: "corpo qualquer",
    state_reason: "not_planned",
    closed_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseGhApiIssueRows — fixture no formato REAL da REST API", () => {
  it("normaliza state_reason minúsculo (\"not_planned\") pra NOT_PLANNED maiúsculo — o bug do self-review original", () => {
    const raw = JSON.stringify([ghRow({ state_reason: "not_planned" })]);
    const [issue] = parseGhApiIssueRows(raw);
    assert.equal(issue.stateReason, "NOT_PLANNED");
  });

  it("normaliza completed/duplicate minúsculos também", () => {
    const raw = JSON.stringify([
      ghRow({ number: 1, state_reason: "completed" }),
      ghRow({ number: 2, state_reason: "duplicate" }),
    ]);
    const issues = parseGhApiIssueRows(raw);
    assert.equal(issues[0].stateReason, "COMPLETED");
    assert.equal(issues[1].stateReason, "DUPLICATE");
  });

  it("filtra entradas que são pull requests (endpoint /issues mistura issues e PRs)", () => {
    const raw = JSON.stringify([
      ghRow({ number: 1 }),
      { ...ghRow({ number: 2 }), pull_request: { url: "https://api.github.com/..." } },
    ]);
    const issues = parseGhApiIssueRows(raw);
    assert.deepEqual(
      issues.map((i) => i.number),
      [1],
    );
  });

  it("body null (REST permite) vira string vazia, nunca null propagado", () => {
    const raw = JSON.stringify([ghRow({ body: null })]);
    const [issue] = parseGhApiIssueRows(raw);
    assert.equal(issue.body, "");
  });

  it("state_reason null (issue reaberta/refechada sem reason) vira UNKNOWN, nunca null cru", () => {
    const raw = JSON.stringify([ghRow({ state_reason: null })]);
    const [issue] = parseGhApiIssueRows(raw);
    assert.equal(issue.stateReason, "UNKNOWN");
  });

  it("closed_at null vira null (data desconhecida é um caso legítimo, ao contrário de stateReason)", () => {
    const raw = JSON.stringify([ghRow({ closed_at: null })]);
    const [issue] = parseGhApiIssueRows(raw);
    assert.equal(issue.closedAt, null);
  });

  it("JSON malformado lança (o caller, fetchClosedAlarmIssues, decide o que fazer com a exceção)", () => {
    assert.throws(() => parseGhApiIssueRows("{ isto não é um array JSON válido"));
  });

  it("lista vazia devolve lista vazia", () => {
    assert.deepEqual(parseGhApiIssueRows("[]"), []);
  });
});
