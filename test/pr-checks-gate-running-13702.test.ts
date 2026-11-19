/**
 * test/pr-checks-gate-running-13702.test.ts (#13702)
 *
 * `scripts/lib/wait-pr-checks.sh` estende o prazo da espera de CI enquanto há
 * check EM EXECUÇÃO (#13685). Até o #13702 o laço derivava "em execução" de
 * `pending - queued`, o que contava um `StatusContext` legado em
 * PENDING/EXPECTED (que pode nunca postar) como check rodando e dobrava a
 * espera pra 60 min. O gate passou a expor `runningChecks` (só `CheckRun`
 * com status != COMPLETED e `startedAt`) e a imprimir `running=R` no fim da
 * linha `queue:`. O lado do laço vive em `scripts/lib/wait-pr-checks.test.sh`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePrChecksGate, type PrCheckNode } from "../scripts/lib/pr-checks-gate.ts";
import { formatQueueLine } from "../scripts/check-pr-checks-gate.ts";

const STARTED = "2026-11-19T03:00:00Z";

describe("evaluatePrChecksGate — runningChecks (#13702)", () => {
  it("CheckRun IN_PROGRESS com startedAt conta como execução; QUEUED não", () => {
    const rollup: PrCheckNode[] = [
      { name: "test", status: "IN_PROGRESS", conclusion: null, startedAt: STARTED },
      { name: "e2e", status: "QUEUED", conclusion: null },
    ];
    const r = evaluatePrChecksGate(rollup, { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.runningChecks, ["test"]);
    assert.deepEqual(r.queuedChecks, ["e2e"]);
  });

  it("StatusContext legado PENDING/EXPECTED não conta como execução", () => {
    const rollup: PrCheckNode[] = [
      { context: "deploy/preview", state: "PENDING" } as PrCheckNode,
      { context: "legacy-ci", state: "EXPECTED" } as PrCheckNode,
    ];
    const r = evaluatePrChecksGate(rollup, { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.equal(r.pendingChecks.length, 2);
    assert.deepEqual(r.runningChecks, []);
    assert.deepEqual(r.queuedChecks, []);
  });

  it("CheckRun não COMPLETED sem startedAt (payload parcial) não conta como execução", () => {
    const rollup: PrCheckNode[] = [{ name: "test", status: "IN_PROGRESS", conclusion: null }];
    const r = evaluatePrChecksGate(rollup, { mergeable: "MERGEABLE" });
    assert.equal(r.verdict, "pending");
    assert.deepEqual(r.runningChecks, []);
  });
});

describe("formatQueueLine — running=R (#13702)", () => {
  it("status legado pendente sai running=0, mesmo com pending > queued", () => {
    const r = evaluatePrChecksGate(
      [
        { context: "deploy/preview", state: "PENDING" } as PrCheckNode,
        { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: STARTED },
      ],
      { mergeable: "MERGEABLE" },
    );
    assert.equal(formatQueueLine(r), "[check-pr-checks-gate] queue: queued=0 pending=1 running=0");
  });

  it("running=R vem no fim: o grep antigo de `queued=K pending=P` continua casando", () => {
    const r = evaluatePrChecksGate(
      [
        { name: "test", status: "IN_PROGRESS", conclusion: null, startedAt: STARTED },
        { name: "e2e", status: "QUEUED", conclusion: null },
      ],
      { mergeable: "MERGEABLE" },
    );
    const line = formatQueueLine(r) ?? "";
    assert.equal(line, "[check-pr-checks-gate] queue: queued=1 pending=2 running=1");
    assert.match(line, /queue: queued=1 pending=2/);
  });

  it("resultado sem runningChecks (shape antigo) imprime a linha sem running=", () => {
    const line = formatQueueLine({
      verdict: "pending",
      failingChecks: [],
      pendingChecks: ["a"],
      queuedChecks: [],
      reason: "x",
    });
    assert.equal(line, "[check-pr-checks-gate] queue: queued=0 pending=1");
  });
});
