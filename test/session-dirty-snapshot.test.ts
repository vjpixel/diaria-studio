/**
 * #11785 — foto do checkout sujo no início da sessão: captura, gravação
 * única, leitura defensiva e o hook de SessionStart (só em `startup`).
 * A comparação no encerramento é coberta em `session-close-check.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureDirtySnapshot, isUnchangedSinceSnapshot, normalizeCheckoutPath, parsePorcelainZ, readSnapshot,
  snapshotFilePath, writeSnapshotOnce, SNAPSHOT_VERSION, MAX_SNAPSHOT_ENTRIES,
} from "../.claude/hooks/lib/session-dirty-snapshot.mjs";
import { runDirtySnapshotHook } from "../.claude/hooks/session-start-dirty-snapshot.mjs";

const fakeSnapshot = (entries: Record<string, { code: string; hash: string | null }> = {}) =>
  ({ version: SNAPSHOT_VERSION, capturedAt: "2026-11-02T00:00:00.000Z", checkout: "/repo", entries });

describe("session dirty snapshot (#11785)", () => {
  it("parses -z porcelain, keeping the rename destination and spaces in paths", () => {
    const out = " M a b.ts\0R  new.ts\0old.ts\0?? dir/x.ts\0 D gone.ts\0";
    assert.deepEqual(parsePorcelainZ(out), [
      { code: " M", path: "a b.ts" }, { code: "R ", path: "new.ts" },
      { code: "??", path: "dir/x.ts" }, { code: " D", path: "gone.ts" },
    ]);
  });
  it("captures code + hash per dirty entry from git", () => {
    const calls: string[][] = [];
    const snap = captureDirtySnapshot("/repo/sub", {
      run: (args) => { calls.push(args); return args[0] === "rev-parse" ? "/repo\n" : " M a.ts\0?? b.ts\0"; },
      hash: abs => `h:${abs}`, now: () => new Date("2026-11-02T00:00:00Z"),
    });
    assert.ok(snap);
    assert.equal(snap.checkout, "/repo");
    assert.deepEqual(snap.entries, { "a.ts": { code: " M", hash: "h:/repo/a.ts" }, "b.ts": { code: "??", hash: "h:/repo/b.ts" } });
    assert.ok(calls[1].includes("--untracked-files=all") && calls[1].includes("-z"));
  });
  it("does not write a partial snapshot above the entry cap", () => {
    const many = Array.from({ length: MAX_SNAPSHOT_ENTRIES + 1 }, (_, i) => `?? f${i}`).join("\0");
    assert.equal(captureDirtySnapshot("/repo", { run: a => a[0] === "rev-parse" ? "/repo" : many, hash: () => "x" }), null);
  });
  it("keys by session and normalized checkout; rejects unsafe session ids", () => {
    assert.equal(snapshotFilePath("abc", "/repo", "/base"), snapshotFilePath("abc", "/repo/", "/base"));
    assert.notEqual(snapshotFilePath("abc", "/repo", "/base"), snapshotFilePath("abc", "/other", "/base"));
    assert.equal(snapshotFilePath("../evil", "/repo", "/base"), null);
    assert.equal(snapshotFilePath("", "/repo", "/base"), null);
    assert.equal(normalizeCheckoutPath("/repo/a/../b/"), "/repo/b");
  });
  it("first snapshot wins; unreadable or foreign-version files read as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "dirty-snap-"));
    try {
      const path = join(dir, "nested", "s.json");
      assert.equal(writeSnapshotOnce(path, fakeSnapshot({ "a.ts": { code: " M", hash: "1" } })), true);
      assert.equal(writeSnapshotOnce(path, fakeSnapshot({ "b.ts": { code: " M", hash: "2" } })), false);
      assert.deepEqual(Object.keys(readSnapshot(path)!.entries), ["a.ts"]);
      writeFileSync(path, "{not json");
      assert.equal(readSnapshot(path), null);
      writeFileSync(path, JSON.stringify({ ...fakeSnapshot(), version: 999 }));
      assert.equal(readSnapshot(path), null);
      assert.equal(readSnapshot(join(dir, "missing.json")), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("unchanged only with same code and same hash", () => {
    const snap = fakeSnapshot({ "a.ts": { code: " M", hash: "1" }, "gone.ts": { code: " D", hash: null } });
    const hash = (abs: string) => abs.endsWith("gone.ts") ? null : "1";
    assert.equal(isUnchangedSinceSnapshot(snap, "/repo", { code: " M", path: "a.ts" }, hash), true);
    assert.equal(isUnchangedSinceSnapshot(snap, "/repo", { code: "M ", path: "a.ts" }, hash), false);
    assert.equal(isUnchangedSinceSnapshot(snap, "/repo", { code: " M", path: "a.ts" }, () => "2"), false);
    assert.equal(isUnchangedSinceSnapshot(snap, "/repo", { code: "??", path: "new.ts" }, hash), false);
    assert.equal(isUnchangedSinceSnapshot(snap, "/repo", { code: " D", path: "gone.ts" }, hash), true);
    assert.equal(isUnchangedSinceSnapshot(null, "/repo", { code: " M", path: "a.ts" }, hash), false);
  });
  describe("SessionStart hook", () => {
    const capture = () => fakeSnapshot({ "a.ts": { code: " M", hash: "1" } });
    it("writes only on startup — resume/compact/clear would attribute the session's own dirt to someone else", () => {
      const dir = mkdtempSync(join(tmpdir(), "dirty-snap-hook-"));
      try {
        for (const source of ["resume", "compact", "clear", undefined]) {
          const result = runDirtySnapshotHook({ session_id: "s1", cwd: "/repo", source }, { capture, baseDir: dir });
          assert.deepEqual(result, { written: false, reason: "source-not-startup" });
        }
        const first = runDirtySnapshotHook({ session_id: "s1", cwd: "/repo", source: "startup" }, { capture, baseDir: dir });
        assert.equal(first.written, true);
        assert.equal(JSON.parse(readFileSync(first.path!, "utf8")).entries["a.ts"].hash, "1");
        const again = runDirtySnapshotHook({ session_id: "s1", cwd: "/repo", source: "startup" }, { capture, baseDir: dir });
        assert.equal(again.written, false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("refuses an unsafe session id", () => {
      assert.equal(runDirtySnapshotHook({ session_id: "../x", cwd: "/repo", source: "startup" },
        { capture, baseDir: "/nonexistent" }).reason, "invalid-session-id");
    });
  });
});
