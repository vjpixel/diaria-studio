/**
 * test/reconcile-issue-dependencies.test.ts (#7137)
 *
 * Cobre `buildReconcileReport` (pura, monta a decisão por issue a partir de
 * issues+estados já buscados) e `fetchDependencyState` (I/O via `gh`,
 * injetável) de `scripts/reconcile-issue-dependencies.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReconcileReport,
  fetchDependencyState,
} from "../scripts/reconcile-issue-dependencies.ts";
import { DEPENDS_ON_BLOCK_LABEL } from "../scripts/lib/issue-exec-track.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

describe("buildReconcileReport", () => {
  it("issue sem marcador e sem label → omitida do relatório", () => {
    const rows = buildReconcileReport(
      [{ number: 1, labels: ["bug"], body: "sem marcador" }],
      {},
    );
    assert.deepEqual(rows, []);
  });

  it("issue com marcador, dependência ainda aberta → add", () => {
    const rows = buildReconcileReport(
      [{ number: 7124, labels: [], body: "<!-- depends-on: #6798 -->" }],
      { 6798: "open" },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "add");
    assert.deepEqual(rows[0].dependsOn, [6798]);
    assert.deepEqual(rows[0].unresolved, [6798]);
  });

  // ─── REGRESSÃO CENTRAL (#633): a issue #7124 tinha a label
  // dependencia-aberta e a dependência #6798 fechou — o relatório precisa
  // dizer "remove" SEM que ninguém remova a label manualmente.
  it("REGRESSÃO #7124/#6798: dependência fechada, issue já bloqueada → remove", () => {
    const rows = buildReconcileReport(
      [{ number: 7124, labels: [DEPENDS_ON_BLOCK_LABEL], body: "<!-- depends-on: #6798 -->" }],
      { 6798: "closed" },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "remove");
  });

  it("dependência com estado desconhecido (consulta falhou) → nunca remove, sempre noop/add", () => {
    const rows = buildReconcileReport(
      [{ number: 7124, labels: [DEPENDS_ON_BLOCK_LABEL], body: "<!-- depends-on: #6798 -->" }],
      {}, // 6798 ausente do mapa == consulta falhou/nunca rodou
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "noop");
    assert.deepEqual(rows[0].indeterminate, [6798]);
  });

  it("issue com a label mas sem marcador (marcador removido depois) → remove (cleanup)", () => {
    const rows = buildReconcileReport(
      [{ number: 1, labels: [DEPENDS_ON_BLOCK_LABEL], body: "sem marcador agora" }],
      {},
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "remove");
    assert.deepEqual(rows[0].dependsOn, []);
  });

  it("múltiplas issues no mesmo relatório, cada uma com seu próprio veredito", () => {
    const rows = buildReconcileReport(
      [
        { number: 1, labels: [], body: "<!-- depends-on: #10 -->" },
        { number: 2, labels: [DEPENDS_ON_BLOCK_LABEL], body: "<!-- depends-on: #11 -->" },
        { number: 3, labels: ["bug"], body: null },
      ],
      { 10: "open", 11: "closed" },
    );
    assert.equal(rows.length, 2); // #3 é omitida (sem marcador, sem label)
    assert.equal(rows.find((r) => r.issue === 1)!.action, "add");
    assert.equal(rows.find((r) => r.issue === 2)!.action, "remove");
  });
});

describe("fetchDependencyState", () => {
  function ghRun(status: number | null, stdout: string): (args: string[], cwd: string) => GhSpawnResult {
    return () => ({ status, stdout, stderr: "" });
  }

  it("state CLOSED → closed", () => {
    assert.equal(fetchDependencyState(1, "/tmp", ghRun(0, '{"state":"CLOSED"}')), "closed");
  });

  it("state OPEN → open", () => {
    assert.equal(fetchDependencyState(1, "/tmp", ghRun(0, '{"state":"OPEN"}')), "open");
  });

  it("gh falha (status != 0) → unknown, nunca closed", () => {
    assert.equal(fetchDependencyState(1, "/tmp", ghRun(1, "")), "unknown");
  });

  it("JSON malformado → unknown, nunca lança", () => {
    assert.doesNotThrow(() => fetchDependencyState(1, "/tmp", ghRun(0, "não é json")));
    assert.equal(fetchDependencyState(1, "/tmp", ghRun(0, "não é json")), "unknown");
  });

  it("state com valor inesperado → unknown (nunca adivinha)", () => {
    assert.equal(fetchDependencyState(1, "/tmp", ghRun(0, '{"state":"MERGED"}')), "unknown");
  });
});
