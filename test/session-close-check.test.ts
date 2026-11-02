import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkSessionClose } from "../scripts/session-close-check.ts";
import type { SessionRecord } from "../scripts/lib/session-registry.ts";

const session: SessionRecord = {
  sessionId: "own", kind: "interactive", machineTag: "test",
  startedAt: "2026-10-29T00:00:00Z", lastHeartbeat: "2026-10-29T01:00:00Z",
  branch: "feature/own", worktrees: [{ path: "/repo/own" }],
};
const clean = (command: string, args: string[]): string => {
  if (command === "gh") return "[]";
  if (args[0] === "worktree") return "worktree /repo/peer\nbranch refs/heads/feature/peer\n\n";
  if (args[0] === "branch") return "feature/own\n";
  if (args[0] === "rev-parse") return "origin/feature/own\n";
  if (args[0] === "config") return "origin\n";
  if (args[0] === "rev-list") return "0\n";
  return "";
};

describe("session closure evidence", () => {
  it("checks only owned worktrees and keeps manual checks explicit", () => {
    const seen: string[] = [];
    const result = checkSessionClose("/repo", session, [], (cmd, args, cwd) => {
      seen.push(cwd); return clean(cmd, args);
    });
    assert.equal(result.canClose, true);
    assert.deepEqual(result.checkedWorktrees, ["/repo/own"]);
    assert.ok(!seen.includes("/repo/peer"));
    assert.equal(result.manualChecks.length, 2);
  });
  it("reports dirty files, unpushed commits, PRs, both claim kinds and recent stashes", () => {
    const result = checkSessionClose("/repo", { ...session, claimed_issues: [12],
      claimed_foreign_issues: ["owner/other#3"] }, [], (cmd, args) => {
      if (args[0] === "status") return "?? forgotten.txt\n";
      if (args[0] === "rev-list") return "2\n";
      if (args[0] === "stash") return "stash@{0}\t1793235600\tOn feature/own: work\nstash@{1}\t1\told\n";
      if (cmd === "gh") return JSON.stringify([{ number: 7, url: "https://example.test/pr/7", headRefName: "feature/own" }]);
      return clean(cmd, args);
    });
    assert.equal(result.canClose, false);
    assert.equal(result.pending.length, 6);
    assert.ok(!result.pending.some(p => p.includes("stash@{1}")));
  });
  it("never certifies missing identity, missing upstream or failed GitHub/fetch", () => {
    assert.equal(checkSessionClose("/repo", undefined).canClose, false);
    for (const failing of ["gh", "rev-parse", "fetch"]) {
      const result = checkSessionClose("/repo", session, [], (cmd, args) => {
        if (cmd === failing || args[0] === failing) throw new Error("offline/missing");
        return clean(cmd, args);
      });
      assert.equal(result.canClose, false, failing);
      assert.equal(result.errors.length, 1, failing);
    }
  });
  it("discovers branch locations and includes explicit worktrees", () => {
    const result = checkSessionClose("/repo", { ...session, worktrees: [] }, ["extra"], (cmd, args) => {
      if (args[0] === "worktree") return "worktree /repo/moved\nbranch refs/heads/feature/own\n\n";
      return clean(cmd, args);
    });
    assert.deepEqual(result.checkedWorktrees, ["/repo/extra", "/repo/moved"]);
  });
  it("does not block on line-ending-only diffs nor routine audience snapshots (#11733)", () => {
    const status = " M scripts/lib/crlf.ts\nM  scripts/lib/real.ts\n M context/audience-profile.md\n"
      + "?? docs/audience-history/2026-10-22.md\n?? _tmp.ts\n";
    const result = checkSessionClose("/repo", session, [], (cmd, args) => {
      if (args[0] === "status") return status;
      if (args[0] === "diff") return "scripts/lib/real.ts\ncontext/audience-profile.md\n";
      return clean(cmd, args);
    });
    assert.equal(result.canClose, false);
    assert.equal(result.pending.length, 1);
    assert.ok(result.pending[0].includes("real.ts") && result.pending[0].includes("_tmp.ts"));
    assert.ok(!result.pending[0].includes("crlf.ts") && !result.pending[0].includes("audience"));
    assert.equal(result.ignored.length, 3);
  });
  it("keeps every modification blocking when the EOL-insensitive diff fails", () => {
    const result = checkSessionClose("/repo", session, [], (cmd, args) => {
      if (args[0] === "status") return " M scripts/lib/crlf.ts\n";
      if (args[0] === "diff") throw new Error("no HEAD");
      return clean(cmd, args);
    });
    assert.equal(result.canClose, false);
    assert.ok(result.pending.some(p => p.includes("crlf.ts")));
  });
  it("certifies a real checkout whose only dirt is CRLF and audience snapshots (#11733)", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-close-eol-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-b", "feature/own");
      git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(dir, "lib.ts"), "a\nb\n");
      // As in the repo, the history dir is tracked (older snapshots committed), so status lists files, not "?? docs/".
      mkdirSync(join(dir, "docs", "audience-history"), { recursive: true });
      writeFileSync(join(dir, "docs", "audience-history", "2026-10-21.md"), "old");
      git("add", "lib.ts", "docs"); git("commit", "-m", "base");
      git("branch", "base"); git("branch", "--set-upstream-to=base");
      writeFileSync(join(dir, "lib.ts"), "a\r\nb\r\n");
      writeFileSync(join(dir, "docs", "audience-history", "2026-10-29.md"), "snapshot");
      const run = (cmd: string, args: string[]) => cmd === "gh" ? "[]" : git(...args);
      const ok = checkSessionClose(dir, { ...session, worktrees: [{ path: dir }] }, [], run);
      assert.deepEqual(ok.errors, []);
      assert.deepEqual(ok.pending, []);
      assert.equal(ok.canClose, true);
      assert.equal(ok.ignored.length, 2);
      writeFileSync(join(dir, "lib.ts"), "a\r\nc\r\n");
      const dirty = checkSessionClose(dir, { ...session, worktrees: [{ path: dir }] }, [], run);
      assert.equal(dirty.canClose, false);
      assert.ok(dirty.pending.some(p => p.includes("lib.ts")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("detects real untracked changes and commits ahead of an upstream", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-close-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-b", "feature/own");
      git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
      git("commit", "--allow-empty", "-m", "base");
      git("branch", "base"); git("branch", "--set-upstream-to=base");
      git("commit", "--allow-empty", "-m", "unsent");
      writeFileSync(join(dir, "forgotten.txt"), "pending");
      const result = checkSessionClose(dir, { ...session, worktrees: [{ path: dir }] }, [], (cmd, args) =>
        cmd === "gh" ? "[]" : git(...args));
      assert.equal(result.canClose, false);
      assert.ok(result.pending.some(p => p.includes("forgotten.txt")));
      assert.ok(result.pending.some(p => p.includes("não enviados") && p.includes("(1)")));
      assert.deepEqual(result.errors, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("ignores dirty files last written before the session started, never ones written after or unknown (#11733)", () => {
    const started = Date.parse(session.startedAt);
    const run = (cmd: string, args: string[]) =>
      args[0] === "status" ? "?? old.ts\n?? new.ts\n M mod-old.ts\n?? unknown.ts\n?? dir/\n" : clean(cmd, args);
    const mtimes: Record<string, number> = {
      "/repo/own/old.ts": started - 1000, "/repo/own/new.ts": started + 1000, "/repo/own/mod-old.ts": started - 1,
    };
    const result = checkSessionClose("/repo", session, [], run, abs => mtimes[abs]);
    assert.equal(result.ignored.length, 2);
    const pending = result.pending.join("\n");
    assert.ok(pending.includes("new.ts") && pending.includes("unknown.ts") && pending.includes("dir/"));
    assert.ok(!/\?\? old\.ts/.test(pending) && !pending.includes("mod-old.ts"));
    assert.equal(result.canClose, false);
  });
});
