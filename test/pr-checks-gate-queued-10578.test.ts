/**
 * test/pr-checks-gate-queued-10578.test.ts (#10578)
 *
 * Achado da rodada 261019d: runs do GitHub ficaram ~35 min na fila de
 * runner e `scripts/lib/wait-pr-checks.sh` estourou o teto de 30 min em 6
 * PRs que depois ficaram verdes. O laço precisa distinguir "fila" (nenhum
 * runner pegou o job) de "rodando sem concluir". Este arquivo cobre o lado
 * TS desse contrato: `queuedChecks` em `evaluatePrChecksGate` e a linha
 * `queue: queued=K pending=P` que o CLI imprime e o laço bash lê. O lado do
 * laço (extensão do teto, exit 7) vive em `scripts/lib/wait-pr-checks.test.sh`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrChecksGate, isQueuedCheckRun, type PrCheckNode } from "../scripts/lib/pr-checks-gate.ts";
import { formatQueueLine } from "../scripts/check-pr-checks-gate.ts";

const STARTED = "2026-10-19T03:00:00Z";

describe("evaluatePrChecksGate — queuedChecks (#10578)", () => {
  it("fixture de fila: checks QUEUED sem startedAt entram em queuedChecks", () => {
    const rollup: PrCheckNode[] = [
      { name: "test", status: "QUEUED", conclusion: null },
      { name: "typecheck", status: "QUEUED", conclusion: null },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: STARTED },
    ];
    const r = evaluatePrChecksGate(rollup, { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.pendingChecks, ["test", "typecheck"]);
    assert.deepEqual(r.queuedChecks, ["test", "typecheck"]);
  });

  it("check IN_PROGRESS com startedAt é pendente mas NÃO está na fila", () => {
    const rollup: PrCheckNode[] = [
      { name: "test", status: "IN_PROGRESS", conclusion: null, startedAt: STARTED },
      { name: "e2e", status: "QUEUED", conclusion: null },
    ];
    const r = evaluatePrChecksGate(rollup, { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.pendingChecks, ["test", "e2e"]);
    assert.deepEqual(r.queuedChecks, ["e2e"]);
  });

  it("StatusContext PENDING não conta como fila (state não distingue fila de execução)", () => {
    const rollup: PrCheckNode[] = [{ context: "vercel", state: "PENDING" } as PrCheckNode];
    const r = evaluatePrChecksGate(rollup, { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.queuedChecks, []);
  });

  it("isQueuedCheckRun: startedAt presente prevalece sobre status de espera", () => {
    assert.equal(isQueuedCheckRun({ name: "a", status: "QUEUED" }), true);
    assert.equal(isQueuedCheckRun({ name: "a", status: "WAITING" }), true);
    assert.equal(isQueuedCheckRun({ name: "a", status: "QUEUED", startedAt: STARTED }), false);
    assert.equal(isQueuedCheckRun({ name: "a", status: "IN_PROGRESS" }), false);
    assert.equal(isQueuedCheckRun({ name: "a", status: "COMPLETED", conclusion: "SUCCESS" }), false);
  });
});

describe("formatQueueLine — contrato com wait-pr-checks.sh (#10578)", () => {
  it("pending com fila imprime queued=K pending=P (formato que o laço bash faz grep)", () => {
    const r = evaluatePrChecksGate(
      [
        { name: "test", status: "QUEUED", conclusion: null },
        { name: "lint", status: "IN_PROGRESS", conclusion: null, startedAt: STARTED },
      ],
      { mergeable: "MERGEABLE" },
    );
    const line = formatQueueLine(r);
    assert.equal(line, "[check-pr-checks-gate] queue: queued=1 pending=2");
    assert.match(line ?? "", /queue: queued=[0-9]+/);
  });

  it("vereditos não-pending não imprimem a linha", () => {
    const pass = evaluatePrChecksGate([{ name: "t", status: "COMPLETED", conclusion: "SUCCESS", startedAt: STARTED }], {
      mergeable: "MERGEABLE",
    });
    assert.equal(formatQueueLine(pass), null);
    const fail = evaluatePrChecksGate([{ name: "t", status: "COMPLETED", conclusion: "FAILURE", startedAt: STARTED }], {
      mergeable: "MERGEABLE",
    });
    assert.equal(formatQueueLine(fail), null);
  });

  it("pending sem queuedChecks (rollup vazio) não imprime — o laço lê como queued=0", () => {
    const r = evaluatePrChecksGate([], { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.equal(formatQueueLine(r), null);
  });
});
