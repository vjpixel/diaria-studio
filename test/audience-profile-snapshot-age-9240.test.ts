/**
 * test/audience-profile-snapshot-age-9240.test.ts (#9240)
 *
 * Regressão: em 01/10/2026 `docs/audience-history/` não tinha snapshot depois
 * de 2026-09-20 e o alarme do #9232 seguia reportando "nenhuma ocorrência",
 * cego pela falta de snapshots novos. Agora o snapshot mais recente velho
 * demais vira finding próprio (`family: "estado"`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findSnapshotAgeFinding,
  SNAPSHOT_MAX_AGE_DAYS,
  SNAPSHOT_AGE_FINGERPRINT,
} from "../scripts/lib/audience-profile-staleness-alarm.ts";

const at = (iso: string) => new Date(iso);

describe("findSnapshotAgeFinding (#9240)", () => {
  it("N documentado é 14 dias", () => {
    assert.equal(SNAPSHOT_MAX_AGE_DAYS, 14);
  });

  it("cenário do bug: último snapshot 2026-09-20 visto em 2026-10-05 (15 dias) -> dispara", () => {
    const f = findSnapshotAgeFinding(["2026-09-17.md", "2026-09-20.md", "_consolidated.md"], at("2026-10-05T12:00:00Z"));
    assert.ok(f);
    assert.equal(f.family, "estado");
    assert.equal(f.fingerprint, SNAPSHOT_AGE_FINGERPRINT);
    assert.match(f.body, /2026-09-20\.md/);
    assert.match(f.body, /15 dias/);
  });

  it("exatamente no limite (14 dias) não dispara; 1 dia além dispara", () => {
    assert.equal(findSnapshotAgeFinding(["2026-09-20.md"], at("2026-10-04T23:59:00Z")), null);
    assert.ok(findSnapshotAgeFinding(["2026-09-20.md"], at("2026-10-05T00:00:00Z")));
  });

  it("snapshot recente -> null, independente da ordem de entrada", () => {
    assert.equal(findSnapshotAgeFinding(["2026-09-30.md", "2026-07-01.md"], at("2026-10-01T10:00:00Z")), null);
  });

  it("sem nenhum snapshot (só _consolidated.md) -> dispara", () => {
    const f = findSnapshotAgeFinding(["_consolidated.md"], at("2026-10-01T00:00:00Z"));
    assert.ok(f);
    assert.match(f.body, /nenhum snapshot/);
  });

  it("maxAgeDays customizável", () => {
    assert.ok(findSnapshotAgeFinding(["2026-09-20.md"], at("2026-10-01T00:00:00Z"), 7));
  });
});
