/**
 * #8793 — regressão: consumedAt do safeBackup não deve poluir arquivo real.
 * #7462 (fix anterior) protege realIndex=0; este teste trava a classe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSessionRecords } from "../scripts/lib/session-registry";

describe("#8793 / #7462 — mergeSessionRecords não propaga consumedAt de backup", () => {
  const base = {
    kind: "continuo" as const, machineTag: "300", sessionId: "s",
    startedAt: "2026-09-25T10:00:00.000Z",
    merge_grant: { granted: true, grantedAt: "2026-09-25T10:00:00.000Z", sessionId: "coordinator" },
  };

  it("real sem consumedAt + backup com consumedAt antigo → resultado sem consumedAt", () => {
    const real = { ...base, lastHeartbeat: "2026-09-25T12:00:00.000Z", merge_grant: { ...base.merge_grant } };
    const backup = { ...base, lastHeartbeat: "2026-09-25T11:00:00.000Z", merge_grant: { ...base.merge_grant, consumedAt: "2026-09-25T09:00:00.000Z" } };
    const m = mergeSessionRecords([real, backup], 0);
    assert.equal((m.merge_grant as any)?.consumedAt, undefined, "BUG #8793: backup poluiu real");
  });

  it("grupo órfão (realIndex=-1, só backup) → não honra consumedAt como prova", () => {
    const onlyBackup = { ...base, lastHeartbeat: "2026-09-25T11:00:00.000Z", merge_grant: { ...base.merge_grant, consumedAt: "2026-09-25T09:00:00.000Z" } };
    const m = mergeSessionRecords([onlyBackup], -1);
    assert.equal((m.merge_grant as any)?.consumedAt, undefined, "#6972: backup órfão não prova consumo");
  });
});
