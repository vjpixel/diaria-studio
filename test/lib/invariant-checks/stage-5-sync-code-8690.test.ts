/** #8690 regressão: marker sync-code-ran + invariant (test/ real, não console.assert) */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { checkSyncCodeRan } from "../../../scripts/lib/invariant-checks/stage-5.ts";

describe("stage-5-sync-code-8690 invariant", () => {
  const base = "/tmp/stage-5-8690-" + Date.now();
  before(() => { mkdirSync(base, { recursive: true }); });
  after(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

  it("1 — absent marker reports sync-code-ran", () => {
    const empty = resolve(base, "empty");
    mkdirSync(resolve(empty, "_internal"), { recursive: true });
    const res = checkSyncCodeRan(empty);
    assert.ok(Array.isArray(res));
    assert.ok(res.some(v => v.rule === "sync-code-ran"));
  });

  it("2 — good marker passes clean", () => {
    const ok = resolve(base, "ok");
    mkdirSync(resolve(ok, "_internal"), { recursive: true });
    writeFileSync(resolve(ok, "_internal", ".marker-sync-code-ran.json"), JSON.stringify({ details: { outcome: "synced", up_to_date: true, branch_before: "master" } }));
    assert.strictEqual(checkSyncCodeRan(ok).length, 0);
  });

  it("3 — bad outcome reports sync-code-ran-outcome", () => {
    const bad = resolve(base, "bad");
    mkdirSync(resolve(bad, "_internal"), { recursive: true });
    writeFileSync(resolve(bad, "_internal", ".marker-sync-code-ran.json"), JSON.stringify({ details: { outcome: "fetch_failed" } }));
    const res = checkSyncCodeRan(bad);
    assert.ok(res.some(v => v.rule === "sync-code-ran-outcome"));
  });
});
