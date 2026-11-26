/**
 * #14220 — tombstone local ANTIGO (da mesma máquina) não pode esconder
 * `prev_gate_in_transit`. Cenário da issue: o Neo tem um tombstone de
 * interrupção dele de ontem; o gate 4 é aprovado no 300; `02-reviewed.md`
 * chega ao Neo pelo sync antes do `edition-lock.json` e do `.step-4-done.json`.
 * A Etapa 5 no Neo deve sair 4 com o halt específico do #13851.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessStaleEdition, LOCAL_TOMBSTONE_SLACK_MS } from "../scripts/lib/stale-edition-guard.ts";
import { runStaleEditionGuard } from "../scripts/stale-edition-guard.ts";

const NOW = Date.parse("2026-11-26T11:00:00Z");
const tomb = (host: string, releasedAt: string, extra: Record<string, unknown> = { interrupted_stage: 4 }) => ({
  session_id: "s", host, stage: 4, acquired_at: "", heartbeat_at: releasedAt, released_at: releasedAt, ...extra,
});
const base = { step: 4, callerStage: 5, sentinelSteps: [1, 2, 3], localHost: "neo", now: NOW, newestFileAgeMs: 2 * 60_000 };

describe("#14220 tombstone local antigo + gate anterior em trânsito", () => {
  it("tombstone de interrupção deste host de ontem + arquivo recém-sincronizado → prev_gate_in_transit", () => {
    const v = assessStaleEdition({ ...base, lock: tomb("neo", "2026-11-25T11:00:00Z") });
    assert.equal(v.ok, false);
    assert.deepEqual(v.signals.map((s) => s.kind), ["prev_gate_in_transit"]);
  });
  it("tombstone de conclusão deste host antigo também não silencia", () => {
    const v = assessStaleEdition({ ...base, lock: tomb("neo", "2026-11-25T11:00:00Z", { completed_stage: 3 }) });
    assert.deepEqual(v.signals.map((s) => s.kind), ["prev_gate_in_transit"]);
  });
  it("tombstone deste host solto depois do arquivo mais novo → ok (atividade local)", () => {
    const releasedAfter = new Date(NOW - 60_000).toISOString(); // arquivo de 2 min, release de 1 min
    assert.equal(assessStaleEdition({ ...base, lock: tomb("neo", releasedAfter) }).ok, true);
  });
  it("folga: tombstone carimbado poucos ms antes do próprio arquivo (o release regrava o lock) → ok", () => {
    const releasedJustBefore = new Date(NOW - 2 * 60_000 - (LOCAL_TOMBSTONE_SLACK_MS - 1000)).toISOString();
    assert.equal(assessStaleEdition({ ...base, lock: tomb("neo", releasedJustBefore) }).ok, true);
  });
  it("released_at ilegível de tombstone local não silencia o sinal", () => {
    const v = assessStaleEdition({ ...base, lock: tomb("neo", "ontem") });
    assert.deepEqual(v.signals.map((s) => s.kind), ["prev_gate_in_transit"]);
  });
  it("trava VIVA deste host segue silenciando, mesmo com heartbeat antigo", () => {
    const live = { session_id: "s", host: "neo", stage: 4, acquired_at: "", heartbeat_at: "2026-11-25T11:00:00Z" };
    assert.equal(assessStaleEdition({ ...base, lock: live }).ok, true);
  });
  it("sem a Etapa 5 o tombstone local antigo não muda nada (Stage 4 re-roda)", () => {
    const v = assessStaleEdition({ ...base, callerStage: undefined, lock: tomb("neo", "2026-11-25T11:00:00Z") });
    assert.equal(v.ok, true);
  });
});

describe("#14220 CLI", () => {
  const setup = (releasedAt: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "stale-14220-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "edition-lock.json"), JSON.stringify(tomb("neo", releasedAt)));
    writeFileSync(join(dir, "02-reviewed.md"), "x");
    return dir;
  };
  it("tombstone local de ontem + 02-reviewed.md recém-chegado → exit 4 (halt específico)", () => {
    const dir = setup(new Date(Date.now() - 86_400_000).toISOString());
    assert.equal(runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--caller-stage", "5"], { host: "neo" }), 4);
  });
  it("tombstone local recém-solto (o release foi a última escrita) → exit 0", () => {
    const dir = setup(new Date().toISOString());
    // regrava o lock por último, como o release faz
    writeFileSync(join(dir, "_internal", "edition-lock.json"), JSON.stringify(tomb("neo", new Date().toISOString())));
    assert.equal(runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--caller-stage", "5"], { host: "neo" }), 0);
  });
});
