import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrNumber,
  findStaleBlocks,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
  type PrState,
} from "../scripts/lib/block-staleness.ts";

/** Consultor fake, configurável por teste — zero rede, zero `gh`,
 * zero `session-registry` real. */
function fakeConsultor(overrides: Partial<BlockStalenessConsultor>): BlockStalenessConsultor {
  return {
    getPrState: () => "UNKNOWN",
    isIssueClaimedActive: () => true,
    hasLabel: () => null,
    ...overrides,
  };
}

test("extractPrNumber: prioriza o campo pr estruturado", () => {
  assert.equal(extractPrNumber({ number: 1, pr: 42 }), 42);
});

test("extractPrNumber: cai pro texto livre de nota (PR #NNNN)", () => {
  assert.equal(
    extractPrNumber({ number: 1, pr: null, nota: "PR #6216 aberto por outra sessao" }),
    6216,
  );
  assert.equal(
    extractPrNumber({ number: 1, pr: null, nota: "pr #123, mesmo lote" }),
    123,
  );
});

test("extractPrNumber: null quando nenhuma fonte tem número", () => {
  assert.equal(extractPrNumber({ number: 1, pr: null, nota: "sem numero aqui" }), null);
  assert.equal(extractPrNumber({ number: 1 }), null);
});

// --- pr-em-voo ---------------------------------------------------------

test("pr-em-voo: PR MERGED → caducado", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6202, status: "pulada", motivo: "pr-em-voo", nota: "PR #6209 aberto por outra sessao" },
  ];
  const consultor = fakeConsultor({
    getPrState: (pr): PrState => (pr === 6209 ? "MERGED" : "UNKNOWN"),
  });
  const findings = findStaleBlocks(issues, consultor);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].number, 6202);
  assert.equal(findings[0].category, "pr-em-voo");
  assert.match(findings[0].reason, /mergeado/);
});

test("pr-em-voo: PR CLOSED (sem merge) → caducado", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 100, status: "pulada", motivo: "pr-em-voo", pr: 200 },
  ];
  const consultor = fakeConsultor({
    getPrState: (): PrState => "CLOSED",
  });
  const findings = findStaleBlocks(issues, consultor);
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /fechado/);
});

test("pr-em-voo: PR ainda OPEN → não acusa", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6185, status: "pulada", motivo: "pr-em-voo", nota: "PR #6216 aberto por outra sessao" },
  ];
  const consultor = fakeConsultor({
    getPrState: (): PrState => "OPEN",
  });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

test("pr-em-voo: sem número extraível → não verificável, não acusa", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 1, status: "pulada", motivo: "pr-em-voo", nota: "sem numero de PR aqui" },
  ];
  const consultor = fakeConsultor({ getPrState: (): PrState => "MERGED" });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

test("pr-em-voo: gh indisponível (UNKNOWN) → fail-soft, não acusa", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 1, status: "pulada", motivo: "pr-em-voo", pr: 999 },
  ];
  const consultor = fakeConsultor({ getPrState: (): PrState => "UNKNOWN" });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

// --- claimed-por-outra-sessao -------------------------------------------

test("claimed-por-outra-sessao: sessão encerrou/stale (claim livre) → caducado", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6204, status: "pulada", motivo: "claimed-por-outra-sessao" },
  ];
  const consultor = fakeConsultor({ isIssueClaimedActive: () => false });
  const findings = findStaleBlocks(issues, consultor);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "claimed-por-outra-sessao");
});

test("claimed-por-outra-sessao: sessão ainda ativa → não acusa", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6204, status: "pulada", motivo: "claimed-por-outra-sessao" },
  ];
  const consultor = fakeConsultor({ isIssueClaimedActive: () => true });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

// --- bloqueio-execucao ---------------------------------------------------

test("bloqueio-execucao: label removida → caducado", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6186, status: "pulada", motivo: "bloqueio-execucao" },
  ];
  const consultor = fakeConsultor({ hasLabel: () => false });
  const findings = findStaleBlocks(issues, consultor);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "bloqueio-execucao");
});

test("bloqueio-execucao: label ainda presente → não acusa", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6186, status: "pulada", motivo: "bloqueio-execucao" },
  ];
  const consultor = fakeConsultor({ hasLabel: () => true });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

test("bloqueio-execucao: label não verificável (gh indisponível) → fail-soft, não acusa", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 6186, status: "pulada", motivo: "bloqueio-execucao" },
  ];
  const consultor = fakeConsultor({ hasLabel: () => null });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

// --- motivos NÃO transitórios (nunca reabertos por este mecanismo) ------

test("motivos não-transitórios (bloqueio-externo, requer-sessao-local, ambigua, trade-off-real) nunca são reportados", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 1, status: "pulada", motivo: "bloqueio-externo", pr: 10, nota: "PR #10" },
    { number: 2, status: "pulada", motivo: "requer-sessao-local" },
    { number: 3, status: "pulada", motivo: "ambigua" },
    { number: 4, status: "pulada", motivo: "trade-off-real" },
  ];
  // Consultor deliberadamente "generoso" (tudo caducado) — mesmo assim
  // nenhuma das 4 issues acima pode aparecer, porque o motivo delas não
  // está no conjunto transitório que este mecanismo sabe reavaliar.
  const consultor = fakeConsultor({
    getPrState: (): PrState => "MERGED",
    isIssueClaimedActive: () => false,
    hasLabel: () => false,
  });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

test("issues não-puladas (elegivel, mergeada, etc.) nunca entram na checagem", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 1, status: "elegivel", motivo: null },
    { number: 2, status: "mergeada", motivo: "pr-em-voo", pr: 10 },
  ];
  const consultor = fakeConsultor({ getPrState: (): PrState => "MERGED" });
  assert.deepEqual(findStaleBlocks(issues, consultor), []);
});

test("mistura de findings caducados e válidos: só os caducados voltam, ordenados por número", () => {
  const issues: BlockStalenessPlanIssue[] = [
    { number: 300, status: "pulada", motivo: "pr-em-voo", pr: 1 },
    { number: 100, status: "pulada", motivo: "claimed-por-outra-sessao" },
    { number: 200, status: "pulada", motivo: "pr-em-voo", pr: 2 }, // ainda OPEN
    { number: 50, status: "pulada", motivo: "requer-sessao-local" }, // não-transitório
  ];
  const consultor = fakeConsultor({
    getPrState: (pr): PrState => (pr === 1 ? "MERGED" : "OPEN"),
    isIssueClaimedActive: () => false,
  });
  const findings = findStaleBlocks(issues, consultor);
  assert.deepEqual(
    findings.map((f) => f.number),
    [100, 300],
  );
});
