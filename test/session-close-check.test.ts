import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkSessionClose } from "../scripts/session-close-check.ts";
import type { SessionRecord } from "../scripts/lib/session-registry.ts";
import { captureDirtySnapshot } from "../.claude/hooks/lib/session-dirty-snapshot.mjs";

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
    const result = checkSessionClose("/repo", session, [], run, abs => mtimes[abs], () => null);
    // old.ts by mtime (preExisting); mod-old.ts has no content diff in this mock, so it is EOL-only (ignored).
    assert.equal(result.preExisting.length, 1);
    assert.equal(result.ignored.length, 1);
    // #11785: without a snapshot the report says hash attribution was not possible.
    assert.equal(result.attribution.length, 1);
    assert.match(result.attribution[0], /sem foto do início da sessão/);
    const pending = result.pending.join("\n");
    assert.ok(pending.includes("new.ts") && pending.includes("unknown.ts") && pending.includes("dir/"));
    assert.ok(!/\?\? old\.ts/.test(pending) && !pending.includes("mod-old.ts"));
    assert.equal(result.canClose, false);
  });
  describe("start-of-session snapshot (#11785)", () => {
    const setup = () => {
      const dir = mkdtempSync(join(tmpdir(), "session-close-snap-"));
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      git("init", "-b", "feature/own");
      git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(dir, "tracked.ts"), "base\n");
      writeFileSync(join(dir, "other.ts"), "base\n");
      git("add", "."); git("commit", "-m", "base");
      git("branch", "base"); git("branch", "--set-upstream-to=base");
      // Dirt left by someone else before the session starts: a modified file, an untracked file inside an
      // untracked directory (`?? scratch/` in normal mode) and a deleted file.
      writeFileSync(join(dir, "tracked.ts"), "peer edit\n");
      mkdirSync(join(dir, "scratch"));
      writeFileSync(join(dir, "scratch", "_tmp_dl.ts"), "orphan\n");
      rmSync(join(dir, "other.ts"));
      const snapshot = captureDirtySnapshot(dir);
      assert.ok(snapshot);
      const run = (cmd: string, args: string[]) => cmd === "gh" ? "[]" : git(...args);
      // Session started after the dirt: the mtime fallback alone would also say "pre-existing" here, so the
      // cases below prove the snapshot path, not the mtime one (mtime is forced to "after start").
      const check = (snap: typeof snapshot | null = snapshot) => checkSessionClose(dir,
        { ...session, worktrees: [{ path: dir }] }, [], run, () => Date.parse(session.startedAt) + 1, () => snap);
      return { dir, git, snapshot, check };
    };
    it("session without edits in a dirty checkout can close, with preExisting listed", () => {
      const { dir, check } = setup();
      try {
        const result = check();
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.pending, []);
        assert.equal(result.canClose, true);
        assert.equal(result.preExisting.length, 3);
        const listed = result.preExisting.join("\n");
        assert.ok(listed.includes("tracked.ts") && listed.includes("scratch/_tmp_dl.ts") && listed.includes("other.ts"));
        assert.match(result.attribution[0], /foto do início da sessão/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("a touched mtime without content change is still pre-existing (hash, not mtime)", () => {
      const { dir, check } = setup();
      try {
        const future = new Date(Date.now() + 60_000);
        utimesSync(join(dir, "tracked.ts"), future, future);
        assert.equal(check().canClose, true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("editing a file that was already dirty blocks", () => {
      const { dir, check } = setup();
      try {
        writeFileSync(join(dir, "tracked.ts"), "peer edit\nsession edit\n");
        const result = check();
        assert.equal(result.canClose, false);
        assert.ok(result.pending.some(p => p.includes("tracked.ts")));
        assert.equal(result.preExisting.length, 2);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("a new file (even inside an already-untracked directory) blocks", () => {
      const { dir, check } = setup();
      try {
        writeFileSync(join(dir, "scratch", "mine.ts"), "new\n");
        writeFileSync(join(dir, "fresh.ts"), "new\n");
        const result = check();
        assert.equal(result.canClose, false);
        const pending = result.pending.join("\n");
        assert.ok(pending.includes("scratch/mine.ts") && pending.includes("fresh.ts"));
        assert.ok(!pending.includes("_tmp_dl.ts"));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("staging a pre-existing file changes its status code and blocks", () => {
      const { dir, git, check } = setup();
      try {
        git("add", "tracked.ts");
        const result = check();
        assert.equal(result.canClose, false);
        assert.ok(result.pending.some(p => p.includes("tracked.ts")));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("without a snapshot falls back to mtime and says attribution was not possible", () => {
      const { dir, check } = setup();
      try {
        const result = check(null);
        // mtime forced to after the start: everything blocks, as before #11785.
        assert.equal(result.canClose, false);
        assert.deepEqual(result.preExisting, []);
        assert.match(result.attribution[0], /sem foto do início da sessão/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
});

describe("#12307 session-close-check lista PRs pela REST, não pelo gh pr list (GraphQL)", () => {
  it("chama `gh api repos/{owner}/{repo}/pulls` com head={owner}:branch e nunca `gh pr list`", () => {
    const calls: string[][] = [];
    checkSessionClose("/repo", session, [], (cmd, args) => {
      if (cmd === "gh") calls.push(args);
      return clean(cmd, args);
    });
    assert.ok(calls.length > 0, "consultou o GitHub");
    for (const args of calls) {
      assert.equal(args[0], "api", JSON.stringify(args));
      assert.ok(!(args[0] === "pr" && args[1] === "list"));
      assert.match(args[1], /^repos\/\{owner\}\/\{repo\}\/pulls\?state=open&per_page=100&head=\{owner\}:/);
    }
  });
});
