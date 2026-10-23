/**
 * test/pr-merge-state-10928.test.ts (#10928)
 *
 * Regressão: `check-pr-checks-gate.ts` dava `verdict=pass` sem dizer nada em
 * PRs `mergeStateStatus: BLOCKED` — por review threads não resolvidas e por
 * uma entrada de check (`markdown-guards`) presa como pendente com o run do
 * mesmo nome já concluído. O veredito da condição 1 continua `pass` (threads
 * são a condição 2), mas agora o CLI imprime a causa do bloqueio.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findStuckCheckEntries, formatMergeStateLine } from "../scripts/lib/pr-merge-state.ts";
import { evaluatePrChecksGate } from "../scripts/lib/pr-checks-gate.ts";
import { countUnresolvedThreads, resolveMergeStateLine } from "../scripts/check-pr-checks-gate.ts";

const STUCK_ROLLUP = [
  { name: "markdown-guards", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-10-22T10:00:00Z" },
  { name: "markdown-guards", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-22T10:05:00Z" },
  { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-22T10:05:00Z" },
];

describe("findStuckCheckEntries (#10928)", () => {
  it("cenário real: entrada pendente supersedida por run concluído do mesmo nome → presa (e o gate dá pass)", () => {
    assert.equal(evaluatePrChecksGate(STUCK_ROLLUP).verdict, "pass");
    assert.deepEqual(findStuckCheckEntries(STUCK_ROLLUP), ["markdown-guards"]);
  });

  it("pendente REAL (o vigente ainda rodando) nunca é 'presa'", () => {
    const rollup = [
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-22T10:00:00Z" },
      { name: "ci", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-10-22T10:05:00Z" },
    ];
    assert.equal(evaluatePrChecksGate(rollup).verdict, "pending");
    assert.deepEqual(findStuckCheckEntries(rollup), []);
  });

  it("CANCELLED supersedido não é pendente → não é presa", () => {
    const rollup = [
      { name: "ci", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-22T10:00:00Z" },
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-22T10:05:00Z" },
    ];
    assert.deepEqual(findStuckCheckEntries(rollup), []);
  });

  it("payload malformado → [] sem lançar", () => {
    assert.deepEqual(findStuckCheckEntries(undefined), []);
    assert.deepEqual(findStuckCheckEntries([null, 3, "x"]), []);
  });
});

describe("formatMergeStateLine (#10928)", () => {
  it("CLEAN e sem entrada presa → null (nada a dizer)", () => {
    assert.equal(formatMergeStateLine({ mergeStateStatus: "CLEAN", unresolvedThreads: 0, stuckChecks: [] }), null);
  });

  it("BLOCKED por threads → cita a contagem", () => {
    const line = formatMergeStateLine({ mergeStateStatus: "BLOCKED", unresolvedThreads: 2, stuckChecks: [] });
    assert.match(line ?? "", /merge-state: mergeStateStatus=BLOCKED/);
    assert.match(line ?? "", /2 thread\(s\) de review não resolvida\(s\)/);
  });

  it("BLOCKED com leitura de threads falha → diz 'não lidas', nunca 0", () => {
    const line = formatMergeStateLine({ mergeStateStatus: "BLOCKED", unresolvedThreads: null, stuckChecks: [] });
    assert.match(line ?? "", /não lidas/);
  });

  it("BLOCKED sem causa identificada → aponta o ruleset", () => {
    const line = formatMergeStateLine({ mergeStateStatus: "BLOCKED", unresolvedThreads: 0, stuckChecks: [] });
    assert.match(line ?? "", /causa não identificada/);
  });

  it("entrada presa é relatada mesmo fora de BLOCKED", () => {
    const line = formatMergeStateLine({ mergeStateStatus: "CLEAN", unresolvedThreads: 0, stuckChecks: ["markdown-guards"] });
    assert.match(line ?? "", /presa como pendente.*markdown-guards/);
  });
});

describe("resolveMergeStateLine / countUnresolvedThreads (#10928)", () => {
  it("BLOCKED + threads + entrada presa → as duas causas; threads só lidas quando BLOCKED", () => {
    let reads = 0;
    const stdout = JSON.stringify({ statusCheckRollup: STUCK_ROLLUP, mergeStateStatus: "BLOCKED" });
    const line = resolveMergeStateLine(stdout, () => {
      reads++;
      return 3;
    });
    assert.equal(reads, 1);
    assert.match(line ?? "", /3 thread\(s\)/);
    assert.match(line ?? "", /markdown-guards/);
  });

  it("CLEAN → não consulta threads, null", () => {
    let reads = 0;
    const stdout = JSON.stringify({ statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }], mergeStateStatus: "CLEAN" });
    assert.equal(resolveMergeStateLine(stdout, () => (reads++, 0)), null);
    assert.equal(reads, 0);
  });

  it("stdout ilegível → null sem lançar", () => {
    assert.equal(resolveMergeStateLine("não-json", () => 0), null);
    assert.equal(resolveMergeStateLine(null, () => 0), null);
  });

  it("countUnresolvedThreads: conta só isResolved=false; shape errado → null", () => {
    const ok = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } } } },
    });
    assert.equal(countUnresolvedThreads(ok), 2);
    assert.equal(countUnresolvedThreads(JSON.stringify({ errors: [{ message: "x" }] })), null);
    assert.equal(countUnresolvedThreads("lixo"), null);
  });
});
