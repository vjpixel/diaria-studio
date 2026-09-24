/**
 * #8690 — o Passo -3 de /diaria-5-publicacao (sync-code.ts) deixa um marker
 * por edição, e o invariant `sync-code-ran` do Stage 5 acusa quando ele falta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSyncCodeMarker, writeSyncCodeMarker, syncCodeMarkerPath } from "../scripts/lib/sync-code-marker.ts";
import { STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";

function withDir(fn: (d: string) => void) {
  const d = mkdtempSync(join(tmpdir(), "diaria-8690-"));
  try {
    fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe("sync-code-ran (#8690)", () => {
  it("marker ausente → warning", () => {
    withDir((d) => {
      const v = checkSyncCodeMarker(d);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /Passo -3/);
    });
  });

  it("marker em dia → sem violação", () => {
    withDir((d) => {
      writeSyncCodeMarker(d, { ran_at: "x", outcome: "already_up_to_date", commits_behind: 0, up_to_date: true });
      assert.deepEqual(checkSyncCodeMarker(d), []);
      assert.equal(JSON.parse(readFileSync(syncCodeMarkerPath(d), "utf8")).outcome, "already_up_to_date");
    });
  });

  it("checkout defasado ou defasagem não medida → warning", () => {
    withDir((d) => {
      writeSyncCodeMarker(d, { ran_at: "x", outcome: "ff_failed", commits_behind: 4, up_to_date: false });
      assert.match(checkSyncCodeMarker(d)[0].message, /4 commit/);
      writeSyncCodeMarker(d, { ran_at: "x", outcome: "fetch_failed", commits_behind: -1, up_to_date: false });
      assert.match(checkSyncCodeMarker(d)[0].message, /não conseguiu medir/);
    });
  });

  it("regra registrada no Stage 5", () => {
    assert.ok(STAGE_5_RULES.some((r) => r.id === "sync-code-ran" && r.stage === 5));
  });
});
